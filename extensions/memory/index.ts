/**
 * memory/index.ts — the memory module wiring (DESIGN-MEMORY V1 形状 + V2 扩容:
 * 2 tools + 4 commands + 9 hooks, 0 exported types, zero deps, one LLM lane).
 *
 *   session_start       reconcile both layers + budget reset + static yield probe
 *   session_compact     per-turn budget reset
 *   before_agent_start  dynamic yield probe → policy + two-layer capped index
 *   context             per-turn pin & re-project: select once on the turn's
 *                      first request (query = last real user message), then
 *                      re-project the byte-identical block for every remaining
 *                      request in the turn (spec 2026-10-01-memory-recall-fix)
 *   tool_call           guardMemoryWrites secret interceptor (both layers)
 *   turn_end            auto-consolidation trigger (V2-C) + P3 automation
 *   tool_result         memory_consolidate settle
 *   agent_settled       consolidation in-flight clear
 *   registerTool        session_recall, memory_consolidate (V2-C)
 *   registerCommand     /memory, /memory-consolidate, /memory-import-claude,
 *                       /memory-import-hermes
 *
 * Injection failures NEVER block a turn (P3-ME-09): every hook body is
 * try/catch-wrapped at the boundary.
 */
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { coreBus } from "../bus.ts";
import { reconcileMemoryIndex, scanMemoryDir, scanMemoryDirCached } from "./memdir.ts";
import { resolveMemoryPaths, sessionsDirFor } from "./paths.ts";
import { buildPolicyInjection, POLICY_COMPACT } from "./policy.ts";
import { createRecallSession } from "./recall-session.ts";
import { renderMemoryDiagnostics } from "./diagnostics.ts";
import { selectForTurn, freshnessHeader, byteLength, DEFAULT_SELECTION, type SelectableMemory } from "./selection.ts";
import { guardMemoryWrites } from "./guard.ts";
import { InjectionGate } from "./yield.ts";
import { sessionRecall } from "./session-recall.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";
import { USER_INDEX_MAX } from "./policy.ts";
import { ConsolidationTrigger, CONSOLIDATE_DIRECTIVE_TYPE, registerConsolidation } from "./consolidate.ts";
import { setupAutomation, loadMemorySettings, type AutomationState, type MemorySettings } from "./automation.ts";
import { importFromClaude, importFromHermes, importHermesFull } from "./importers.ts";

export default function memoryExtension(pi: ExtensionAPI): void {
	const home = homedir();
	// resolve the agent dir at call time so HOME overrides (tests) apply
	const gate = new InjectionGate(join(process.env.HOME ?? home, ".pi", "agent"));

	let degradedNotified = false;
	let memoryDirWritable = true;
	let memorySettings: MemorySettings = { automation: true };
	const automationState: AutomationState = { enabled: true, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0 };
	// B8: the per-turn recall state machine (MR-01..09 + AD1) lives in
	// recall-session.ts — the wiring only scans layers, extracts the query
	// snapshot and projects the returned text.
	const recall = createRecallSession();

	function memoryDir(ctx?: { cwd?: string }): string {
		// anchor on the SESSION cwd (ctx.cwd); process.cwd() is only the
		// fallback. Re-resolve per call so HOME overrides (tests) apply.
		return resolveMemoryPaths(ctx?.cwd ?? process.cwd(), process.env.HOME ?? home).memoryDir;
	}

	function userMemoryDir(ctx?: { cwd?: string }): string {
		return resolveMemoryPaths(ctx?.cwd ?? process.cwd(), process.env.HOME ?? home).userMemoryDir;
	}

	function notifyOnce(ctx: ExtensionContext | undefined, msg: string): void {
		if (degradedNotified) return;
		degradedNotified = true;
		if (ctx?.hasUI) ctx.ui.notify(msg, "warning");
		else console.log(`pi-memory: ${msg}`);
	}

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		try {
			recall.compact();
			gate.probeStatic();
			memorySettings = loadMemorySettings(join(process.env.HOME ?? home, ".pi", "agent"));
			automationState.enabled = memorySettings.automation;
			// pre-create both layers (D3a): a fresh project must not degrade the
			// WHOLE injection (incl. the user layer) to policy-only just because
			// its project memory dir doesn't exist yet — the probe below reads
			// ENOENT as "not writable"
			for (const d of [memoryDir(ctx), userMemoryDir(ctx)]) {
				try {
					mkdirSync(d, { recursive: true });
				} catch {
					/* unwritable parent — the probe below degrades correctly */
				}
			}
			reconcileMemoryIndex(memoryDir(ctx));
			reconcileMemoryIndex(userMemoryDir(ctx)); // V2-D1 user layer
			// writability probe: a failed write degrades to policy-only
			try {
				// existence is not writability (review #17): probe the access mode
				accessSync(memoryDir(ctx), fsConstants.W_OK);
				memoryDirWritable = true;
			} catch {
				memoryDirWritable = false;
			}
			coreBus().publish({
				memory: { yielded: gate.state.yielded, ...(gate.state.yielded ? { dir: memoryDir(ctx) } : {}) },
			});
		} catch {
			/* never block session start */
		}
	});

	pi.on("session_compact", () => {
		// MR-02: budget + read + billing state reset — compaction rebuilds the
		// context, so recall starts fresh against the new context (NOT because
		// "old injections were dropped": projections never entered live context)
		recall.compact();
	});

	pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
		try {
			// MR-01 turn boundary: a new agent run = a new user turn → drop the
			// pin so the first context event of this turn selects fresh
			recall.turnStart();
			const wasYielded = gate.state.yielded;
			gate.probePrompt(event.systemPrompt ?? "");
			if (gate.state.yielded !== wasYielded) {
				// dynamic probe just flipped — refresh the bus channel
				coreBus().publish({
					memory: { yielded: gate.state.yielded, ...(gate.state.yielded ? { dir: memoryDir(ctx) } : {}) },
				});
			}
			if (gate.state.yielded) return undefined; // hermes owns injection
			const dir = memoryDir(ctx);
			const udir = userMemoryDir(ctx);
			if (!memoryDirWritable) {
				notifyOnce(ctx, "memory dir not writable — running policy-only");
				// policy-only: the index derives from the (unwritable) dir and
				// cannot be trusted to match, so inject just the policy block
				return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${POLICY_COMPACT}` };
			}
			const userScan = scanMemoryDirCached(udir);
			const projectScan = scanMemoryDirCached(dir);
			const skippedTotal = userScan.skipped + projectScan.skipped;
			const injection = buildPolicyInjection(
				{ entries: userScan.files.map((f) => ({ ...f.entry })), files: userScan.files.map((f) => ({ entry: f.entry, body: f.body })) },
				projectScan.files.map((f) => ({ ...f.entry })),
			) + (skippedTotal > 0 ? `\n<!-- memory: ${skippedTotal} file(s) skipped (invalid frontmatter) -->` : "");
			return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${injection}` };
		} catch {
			return undefined; // injection failure never blocks the turn
		}
	});

	/** MR-06/MR-09: the projected injection message. display:false is INERT on
	 * the projection path — no renderer consumes projections (spec MF-0d
	 * forensics) — kept for shape consistency with the sendMessage contract. */
	const makeInjection = (text: string) => ({
		customType: "pi-memory-recall",
		role: "user" as const,
		content: [{ type: "text", text }],
		display: false,
	});

	pi.on("context", (event, ctx: ExtensionContext): { messages: typeof event.messages } | undefined => {
		try {
			if (gate.state.yielded) return undefined;
			const messages = event.messages ?? [];

			// MR-03: the query snapshot is the LAST real user message —
			// role=user without customType, so tool results and injected
			// custom blocks can never become the recall prompt
			const lastUser = [...messages].reverse().find(
				(m: { role?: string; customType?: string }) => m.role === "user" && !m.customType,
			);
			const prompt = extractUserText(lastUser);

			const memories: SelectableMemory[] = [
				...scanMemoryDirCached(userMemoryDir(ctx)).files.map((f) => ({
					...f.entry,
					body: f.body,
					mtimeMs: f.mtimeMs,
					layer: "user" as const,
				})),
				...scanMemoryDirCached(memoryDir(ctx)).files.map((f) => ({
					...f.entry,
					body: f.body,
					mtimeMs: f.mtimeMs,
					layer: "project" as const,
				})),
			];

			// B8: the MR state machine (pin/re-project/select/bill) lives in
			// recall-session.ts; this wiring extracts the MR-03 query snapshot,
			// scans the two layers, and projects whatever the session returns.
			const result = recall.project({
				prompt,
				memories,
			});
			if (result.text === null) return undefined;
			return { messages: [...messages, makeInjection(result.text) as never] };
		} catch {
			return undefined;
		}
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		try {
			const name = typeof event.toolName === "string" ? event.toolName : "";
			const input = (event.input ?? {}) as Record<string, unknown>;
			// AD1: a read into either memory layer marks the file as seen
			if (name === "read" && typeof input.path === "string") {
				const layer = [userMemoryDir(ctx), memoryDir(ctx)] as const;
				if (layer[0] === input.path.slice(0, layer[0].length) || input.path.startsWith(`${layer[0]}/`) || input.path.startsWith(`${layer[1]}/`)) {
					const isUser = input.path.startsWith(layer[0]);
					recall.markRead(isUser ? "user" : "project", input.path.split("/").pop() ?? "");
				}
			}
			// V2-D2: both layers are guarded (project first, then user)
			const verdict = [memoryDir(ctx), userMemoryDir(ctx)]
				.map((d) => guardMemoryWrites(name, input, d))
				.find((v) => v.block);
			if (verdict) {
				return { block: true, reason: verdict.reason };
			}
		} catch {
			/* guard failure must not break the tool call */
		}
		return undefined;
	});

	// ── V2-C consolidation: directive + triggerTurn, native tool rendering ──
	const consolidation = new ConsolidationTrigger({
		sendDirective: (layer, directive) => {
			pi.sendMessage(
				{ customType: CONSOLIDATE_DIRECTIVE_TYPE, content: `(${layer} layer) ${directive}`, display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});
	registerConsolidation(
		pi,
		(ctx) => ({ project: memoryDir(ctx), user: userMemoryDir(ctx) }),
		consolidation,
	);
	pi.on("turn_end", (_event, ctx: ExtensionContext) => {
		try {
			if (gate.state.yielded) return; // hermes owns memory while present
			consolidation.onTurnEnd(memoryDir(ctx), userMemoryDir(ctx));
		} catch {
			/* never block the turn */
		}
	});
	pi.on("tool_result", (event, ctx: ExtensionContext) => {
		try {
			// B3: in-flight only — the turn is still the directive's turn
			if ((event as { toolName?: string }).toolName === "memory_consolidate") consolidation.settle();
			// AD2: policy-driven reads carry no freshness signal — stamp a
			// staleness note on reads into the memory layers
			const e = event as { toolName?: string; input?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> };
			if (e.toolName === "read" && typeof e.input?.path === "string") {
				const path = e.input.path;
				if ([userMemoryDir(ctx), memoryDir(ctx)].some((d) => path === d || path.startsWith(`${d}/`))) {
					const header = (() => {
						try {
							return freshnessHeader(statSync(path).mtimeMs);
						} catch {
							return null;
						}
					})();
					if (header && Array.isArray(e.content)) {
						const note = { type: "text" as const, text: `[memory] this file is ${header.replace(/\[|\]/g, "")}` };
						return { content: [...(e.content as Array<{ type: "text"; text: string }>), note] };
					}
				}
			}
		} catch {
			/* never block */
		}
		return undefined;
	});
	pi.on("agent_settled", () => {
		try {
			consolidation.settle({ directive: true });
		} catch {
			/* never block */
		}
	});

	// ── V2-A automatic maintenance: correction / review / flush ──
	setupAutomation(pi, {
		gate,
		dirs: (ctx) => ({ project: memoryDir(ctx), user: userMemoryDir(ctx) }),
		trigger: consolidation,
		settings: () => memorySettings,
		state: automationState,
	});

	pi.registerTool(defineTool({
		name: "session_recall",
		label: "Session Recall",
		description:
			"Search past pi sessions for this project (read-only). AND-matched query over user/assistant text. Returns matching excerpts with file/line pointers.",
		parameters: Type.Object({
			query: Type.String({ description: "Space-separated AND terms" }),
			project: Type.Optional(Type.String({ description: "Project cwd (defaults to current)" })),
			since: Type.Optional(Type.String({ description: "ISO date or -Nd (days ago)" })),
			until: Type.Optional(Type.String({ description: "ISO date" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max hits (default 20)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const p = params as { query: string; project?: string; since?: string; until?: string; limit?: number };
			const effectiveCwd = p.project ?? ctx.cwd ?? process.cwd();
			const result = sessionRecall({
				query: p.query,
				project: effectiveCwd,
				since: p.since,
				until: p.until,
				limit: p.limit,
				home,
			});
			if (result.hits.length === 0) {
				const dir = sessionsDirFor(effectiveCwd, home);
				const text = existsSync(dir)
					? `session_recall: no matches for "${p.query}" (${result.scannedFiles} files scanned${result.skippedLines ? `, ${result.skippedLines} malformed lines skipped` : ""})`
					: `session_recall: no sessions found for ${dir}`;
				return { content: [{ type: "text", text }], details: { hits: 0, skippedLines: 0 } };
			}
			const text = result.hits
				.map(
					(h) =>
						`[${h.file}:${h.line}] ${h.role}${h.timestamp ? ` @ ${h.timestamp}` : ""}:\n${h.text.slice(0, 500)}`,
				)
				.join("\n\n");
			return {
				content: [{ type: "text", text: `session_recall: ${result.hits.length} hit(s)\n\n${text}` }],
				details: { hits: result.hits.length, skippedLines: result.skippedLines },
			};
		},
	}));

	pi.registerCommand("memory", {
		description: "Show memory status (two layers: file counts, skipped files, index sizes)",
		handler: async (_args, ctx) => {
			const dir = memoryDir(ctx as ExtensionContext);
			const udir = userMemoryDir(ctx as ExtensionContext);
			const { entries, skipped } = scanMemoryDir(dir);
			const user = scanMemoryDir(udir);
			let indexBytes = 0;
			let userIndexBytes = 0;
			try {
				indexBytes = byteLength(readFileSync(join(dir, "MEMORY.md"), "utf-8"));
			} catch {
				/* no index */
			}
			try {
				userIndexBytes = byteLength(readFileSync(join(udir, "MEMORY.md"), "utf-8"));
			} catch {
				/* no index */
			}
			const content = renderMemoryDiagnostics({
				userDir: udir,
				projectDir: dir,
				userScan: user,
				projectScan: { entries, skipped },
				userIndexBytes,
				projectIndexBytes: indexBytes,
				automation: automationState,
				consolidation: consolidation.state,
				yielded: { yielded: gate.state.yielded, detectedBy: gate.state.detectedBy },
				hermesDataFound:
					existsSync(join(process.env.HOME ?? home, ".pi", "agent", "pi-hermes-memory", "MEMORY.md")) ||
					existsSync(join(process.env.HOME ?? home, ".pi", "agent", "pi-hermes-memory", "USER.md")),
			});
			
			pi.sendMessage({ customType: "pi-memory-status", content, display: true });
		},
	});

	pi.registerCommand("memory-import-claude", {
		description: "Import Claude Code memories from ~/.claude/projects/<this project>/memory",
		handler: async (_args, ctx) => {
			const cwd = (ctx as ExtensionContext).cwd ?? process.cwd();
			const sanitized = cwd.replace(/[\\/]/g, "-");
			const source = join(homedir(), ".claude", "projects", sanitized, "memory");
			const report = importFromClaude(source, memoryDir(ctx as ExtensionContext));
			const text = [
				`memory-import-claude: copied ${report.copied}, skipped ${report.skipped} (idempotent)`,
				...report.notes,
			].join("\n");
			pi.sendMessage({ customType: "pi-memory-status", content: text, display: true });
		},
	});

	pi.registerCommand("memory-import-hermes", {
		description: "Migrate ALL hermes data (USER.md + MEMORY.md + failures.md + this project's store) into the two core layers; a file argument imports that single §-store",
		handler: async (args, ctx) => {
			const cctx = ctx as ExtensionContext;
			const text: string[] = [];
			if (args.trim()) {
				// legacy single-file mode
				const file = args.trim();
				const report = importFromHermes(file, memoryDir(cctx));
				text.push(`memory-import-hermes: converted ${report.copied}, skipped ${report.skipped} (idempotent)`, ...report.notes);
			} else {
				const agentDir = join(process.env.HOME ?? home, ".pi", "agent");
				const report = importHermesFull({
					agentDir,
					projectMemoryDir: memoryDir(cctx),
					userMemoryDir: userMemoryDir(cctx),
				});
				text.push(
					`memory-import-hermes: migrated ${report.copied} fact(s) — user layer: ${report.routed.user}, project layer: ${report.routed.project}, skipped: ${report.skipped} (idempotent)`,
					...report.notes,
				);
			}
			pi.sendMessage({ customType: "pi-memory-status", content: text.join("\n"), display: true });
		},
	});
}

function extractUserText(message: unknown): string | null {
	const m = message as { content?: unknown } | undefined;
	if (!m) return null;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		const texts = (m.content as Array<{ type?: string; text?: string }>)
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text!);
		if (texts.length > 0) return texts.join("\n");
	}
	return null;
}
