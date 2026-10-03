/**
 * memory/index.ts — the memory module wiring (RV, spec 2026-10-02-memory-recall-v2
 * — supersedes the 2026-10-01-memory-recall-fix MR wiring).
 *
 *   session_start       reconcile both layers + settings load + static yield probe
 *   before_agent_start  dynamic yield probe → policy + two-layer capped index;
 *                       RV prompt path — one recall selection per user message,
 *                       bounded by recallWaitMs; the block persists as a custom
 *                       message right after the user message (request #1 sees it)
 *   message_end         RV steer path — user messages that arrive mid-run select
 *                       with waitMs 0 (parked); custom blocks never trigger (RV-01)
 *   turn_end            RV deferred delivery (first continues=true turn_end;
 *                       sendMessage triggerTurn:false — flushed after dispatch)
 *                       + auto-consolidation trigger (V2-C) + P3 automation
 *   agent_end           RV run boundary — abort in-flight selection, drop the
 *                       held block, clear run dedup; unconsumed never leaks
 *   tool_call           guardMemoryWrites secret interceptor (both layers;
 *                       read suppression is history-derived now — RV-07)
 *   tool_result         memory_consolidate settle + stale-read staleness note
 *   agent_settled       consolidation in-flight clear
 *   registerTool        session_recall, memory_consolidate (V2-C)
 *   registerCommand     /memory (incl. RV recall status), /memory-consolidate,
 *                       /memory-import-claude, /memory-import-hermes
 *
 * NO context hook (RV: request-level projection is gone — the 30× cost and
 * the every-request re-injection of one frozen selection were the top
 * recall failures; delivery is persisted-once per user message instead).
 * Recall runs ONLY when memory.recallModel resolves (D3 — unset or
 * unresolvable = no recall, no lexical fallback). All recall session state
 * derives from the projection history (D9 — recall.ts, the deep module).
 * Injection failures NEVER block a turn (P3-ME-09): every hook body is
 * try/catch-wrapped at the boundary.
 */
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { coreBus } from "../bus.ts";
import { eligibleMemories, reconcileMemoryIndex, scanMemoryDir, scanMemoryDirCached } from "./memdir.ts";
import { resolveMemoryPaths, sessionsDirFor, gitCanonicalRoot } from "./paths.ts";
import { scopeMatches } from "./memdir.ts";
import { buildPolicyInjection, policyCompact } from "./policy.ts";
import { renderMemoryDiagnostics } from "./diagnostics.ts";
import { queueInventory } from "./queue.ts";
import { byteLength, createRecall, deriveHistory, freshnessHeader, type RecallBlock, type RecallMachine } from "./recall.ts";
import { llmSelector, resolveRecallModel } from "./selector.ts";
import { guardMemoryWrites } from "./guard.ts";
import { InjectionGate } from "./yield.ts";
import { recallTransparencyLine, sessionRecall } from "./session-recall.ts";
import { readSessionProjection } from "../modes/session-branch.ts";
import { renderSessionRecallCall, sessionRecallResultRows, type SessionRecallArgs } from "./renderers.ts";
import { renderRows } from "../../lib/tool-render.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";
import { USER_INDEX_MAX } from "./policy.ts";
import { ConsolidationTrigger, CONSOLIDATE_DIRECTIVE_TYPE, registerConsolidation } from "./consolidate.ts";
import { setupAutomation, loadMemorySettings, DEFAULT_RECALL_WAIT_MS, type AutomationState, type MemorySettings } from "./automation.ts";
import { importFromClaude, importFromHermes, importHermesFull } from "./importers.ts";

/** RV: optional test seam — wiring tests substitute the selector factory;
 * pi itself always loads the factory with a single argument. */
export interface MemoryExtensionDeps {
	selectorFactory?: typeof llmSelector;
}

export default function memoryExtension(pi: ExtensionAPI, extensionDeps: MemoryExtensionDeps = {}): void {
	const home = homedir();
	// resolve the agent dir at call time so HOME overrides (tests) apply
	const gate = new InjectionGate(join(process.env.HOME ?? home, ".pi", "agent"));

	let degradedNotified = false;
	let memoryDirWritable = true;
	let memorySettings: MemorySettings = { automation: true };
	const automationState: AutomationState = { enabled: true, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0, routed: 0 };
	// RV: the recall machine (recall.ts deep module) — ALL session state
	// derives from the projection history on every call (D9); the wiring
	// only routes events. The machine exists only while memory.recallModel
	// resolves (D3: no model, no recall — no lexical fallback).
	let recallMachine: RecallMachine | null = null;
	let recallModelLabel = "";
	let recallOffNotified = false;
	let promptMessagePending = false;

	/** RV/D9: the history snapshot — the projection's message list. */
	function historyFor(ctx: ExtensionContext): readonly unknown[] {
		// quickwin-4 (arch review): ONE defensive sessionManager reader — the
		// local hand-rolled cast moved to modes/session-branch.ts.
		return readSessionProjection(ctx.sessionManager);
	}

	/** The persisted custom message shape for a delivered recall block. */
	function makeRecallMessage(block: RecallBlock) {
		return {
			customType: block.customType,
			content: [{ type: "text" as const, text: block.text }],
			display: false,
			details: block.details,
		};
	}

	/** Ensure the machine exists for THIS settings+registry (creating it on
	 * whichever path needs it first — prompt or steer). Null when recall is
	 * off (unset/unresolvable recallModel — D3). */
	function ensureRecallMachine(ctx: ExtensionContext): RecallMachine | null {
		if (!memorySettings.recallModel) return null;
		const registry = ctx.modelRegistry as { getAll?: () => unknown[] } | undefined;
		const model = resolveRecallModel(memorySettings.recallModel, registry);
		if (!model) {
			if (!recallOffNotified) {
				recallOffNotified = true;
				console.log(`pi-memory: recallModel "${memorySettings.recallModel}" unresolvable — recall off`);
			}
			return null;
		}
		const label = `${(model as unknown as { provider: string }).provider}/${(model as unknown as { id: string }).id}`;
		if (!recallMachine || recallModelLabel !== label) {
			recallModelLabel = label;
			recallMachine = createRecall({
				selector: (extensionDeps.selectorFactory ?? llmSelector)({ model: () => model, registry: () => ctx.modelRegistry as never }),
				modelLabel: label,
				files: () => eligibleMemories(userMemoryDir(ctx), memoryDir(ctx), gitCanonicalRoot(ctx.cwd ?? process.cwd()) ?? undefined),
				cwd: ctx.cwd ?? process.cwd(),
				// spec v1.2: immediate delivery the moment a parked selection
				// completes — pi queues it as a pending custom message and flushes
				// at the next turn_end (request #2 within the run, next turn's
				// request #1 otherwise). Never blocks the screen.
				deliver: (block) => {
					pi.sendMessage(makeRecallMessage(block), { triggerTurn: false });
				},
			});
		}
		return recallMachine;
	}

	/** RV-16: user-layer files that mention a known project key (from
	 * ~/.pi/agent/projects/*) and carry no `paths:` scoping — surfaced by
	 * /memory as misplaced candidates. */
	function misplacedUserFiles(udir: string): Array<{ file: string; key: string }> {
		try {
			const projectsRoot = join(process.env.HOME ?? home, ".pi", "agent", "projects");
			if (!existsSync(projectsRoot)) return [];
			const keys = new Set(
				readdirSync(projectsRoot)
					.map((d) => (d.replace(/^-+/, "").split("-").pop() ?? ""))
					.filter((k) => k.length >= 4),
			);
			const out: Array<{ file: string; key: string }> = [];
			for (const f of scanMemoryDirCached(udir).files) {
				if (f.entry.paths) continue;
				const haystack = `${f.entry.title} ${f.entry.description} ${f.body}`.toLowerCase();
				for (const key of keys) {
					if (haystack.includes(key.toLowerCase())) {
						out.push({ file: f.entry.file, key });
						break;
					}
				}
			}
			return out;
		} catch {
			return [];
		}
	}

	/** Resolve settings → model → machine, then run one selection. Null when
	 * recall is off (unset/unresolvable recallModel) or nothing qualified. */
	async function recallBlockFor(text: string, ctx: ExtensionContext, waitMs: number): Promise<RecallBlock | null> {
		const machine = ensureRecallMachine(ctx);
		if (!machine) return null;
		return machine.onUserMessage(text, () => historyFor(ctx), waitMs);
	}

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
			// spec 2026-10-03 §2 drain: settings are loaded and the yield probe
			// has settled at this point — fire the background queue drain for
			// this project (never awaited on the startup path).
			automation.drainPending(ctx);
		} catch {
			/* never block session start */
		}
	});


	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		try {
			// RV run boundary (defensive — agent_end owns the real reset; this
			// covers drivers where agent_end never fired)
			recallMachine?.abort();
			promptMessagePending = true;
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
			const waitMs = memorySettings.recallWaitMs ?? DEFAULT_RECALL_WAIT_MS;
			if (!memoryDirWritable) {
				notifyOnce(ctx, "memory dir not writable — running policy-only");
				// policy-only: the index derives from the (unwritable) dir and
				// cannot be trusted to match, so inject just the policy block.
				// Recall still runs — it only READS (an unwritable dir simply
				// yields no candidates).
				const degradedBlock = await recallBlockFor(event.prompt ?? "", ctx, waitMs);
				return degradedBlock
					? { systemPrompt: `${event.systemPrompt ?? ""}\n\n${policyCompact(dir)}`, message: makeRecallMessage(degradedBlock) }
					: { systemPrompt: `${event.systemPrompt ?? ""}\n\n${policyCompact(dir)}` };
			}
			const userScan = scanMemoryDirCached(udir);
			const projectScan = scanMemoryDirCached(dir);
			const skippedTotal = userScan.skipped + projectScan.skipped;
			// RV-14: user-layer entries with `paths:` only render their index
			// rows (and pinned bodies) when the session's git canonical root
			// matches — scoped memories stay invisible elsewhere.
			const root = gitCanonicalRoot(ctx.cwd ?? process.cwd()) ?? undefined;
			const scopedUserFiles = userScan.files.filter((f) => !f.entry.paths || scopeMatches(root, f.entry.paths));
			const injection = buildPolicyInjection(
				{ entries: scopedUserFiles.map((f) => ({ ...f.entry })), files: scopedUserFiles.map((f) => ({ entry: f.entry, body: f.body })) },
				projectScan.files.map((f) => ({ ...f.entry })),
				dir,
			) + (skippedTotal > 0 ? `\n<!-- memory: ${skippedTotal} file(s) skipped (invalid frontmatter) -->` : "");
			const systemPrompt = `${event.systemPrompt ?? ""}\n\n${injection}`;
			// RV-01/03 prompt path: one selection per real user message, bounded
			// by waitMs; a block persists as a custom message right after the
			// user message (request #1 sees it — S4).
			const block = await recallBlockFor(event.prompt ?? "", ctx, waitMs);
			return block ? { systemPrompt, message: makeRecallMessage(block) } : { systemPrompt };
		} catch {
			return undefined; // injection failure never blocks the turn
		}
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		try {
			const name = typeof event.toolName === "string" ? event.toolName : "";
			const input = (event.input ?? {}) as Record<string, unknown>;
			// RV-07: read suppression is HISTORY-derived now (recall.ts
			// deriveHistory resolves read toolCalls against cwd) — no live
			// tracking here. This hook only guards writes.
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
	pi.on("turn_end", (event, ctx: ExtensionContext) => {
		try {
			if (gate.state.yielded) return; // hermes owns memory while present
			consolidation.onTurnEnd(memoryDir(ctx), userMemoryDir(ctx));
		} catch {
			/* never block the turn */
		}
	});
	pi.on("agent_end", () => {
		try {
			// spec v1.2: NO abort here — an in-flight selection for this run may
			// still complete and deliver (appends when not streaming → next
			// turn's request #1 sees it). Latest-wins supersede happens at the
			// NEXT user message (before_agent_start abort), not at run end.
			promptMessagePending = false;
		} catch {
			/* never block */
		}
	});
	pi.on("message_end", (event, ctx: ExtensionContext) => {
		try {
			if (gate.state.yielded) return;
			const message = (event as { message?: { role?: string; customType?: string } }).message;
			// RV-01: real user messages only (custom blocks — recall injections,
			// consolidation directives, goal continuations — never trigger).
			if (!message || message.role !== "user" || message.customType) return;
			if (promptMessagePending) {
				// the prompt path already selected for this message at
				// before_agent_start — just clear the flag
				promptMessagePending = false;
				return;
			}
			// steer / followUp arrived mid-run: never block the run — waitMs 0
			// parks the result for the next continues=true turn_end. The machine
			// is created here too (the steer path may run before any idle prompt).
			const text = extractUserText(message);
			if (text === null) return;
			const steerMachine = ensureRecallMachine(ctx);
			if (!steerMachine) return;
			void steerMachine.onUserMessage(text, () => historyFor(ctx), 0);
		} catch {
			/* never block the run */
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

	// ── V2-A automatic maintenance: correction / review / flush + queue drain ──
	const automation = setupAutomation(pi, {
		gate,
		dirs: (ctx) => {
			const p = resolveMemoryPaths(ctx?.cwd ?? process.cwd(), process.env.HOME ?? home);
			return { project: p.memoryDir, user: p.userMemoryDir, projectsDir: p.projectsDir, agentDir: p.agentDir };
		},
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
			const result = await sessionRecall({
				query: p.query,
				project: effectiveCwd,
				since: p.since,
				until: p.until,
				limit: p.limit,
				home,
			});
			const footer = `\n\n${recallTransparencyLine(result)}`;
			if (result.hits.length === 0) {
				const dir = sessionsDirFor(effectiveCwd, home);
				const text = existsSync(dir)
					? `session_recall: no matches for "${p.query}" (${result.scannedFiles} files scanned${result.skippedLines ? `, ${result.skippedLines} malformed lines skipped` : ""})${footer}`
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
				content: [{ type: "text", text: `session_recall: ${result.hits.length} hit(s)\n\n${text}${footer}` }],
				details: { hits: result.hits.length, skippedLines: result.skippedLines },
			};
		},
// TR C: compact rows — hit count + first pointer instead of the wall
		// of excerpts (the full text still reaches the model untouched).
		renderCall: (args, theme) => renderSessionRecallCall(args as SessionRecallArgs, theme as never),
		renderResult: (result, _options, theme) =>
			renderRows(sessionRecallResultRows(result), theme as never),
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
			const cctx = ctx as ExtensionContext;
			// Panel accuracy fix (2026-10-03): re-attempt machine creation before
			// reporting — the panel used to read the last before_agent_start's
			// result and label a fresh session (no agent turn yet) as
		// "recallModel unresolvable" even when the ref resolves fine.
			ensureRecallMachine(cctx);
			const derived = deriveHistory(historyFor(cctx), cctx.cwd ?? process.cwd());
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
				recall: {
					status: recallMachine ? "on" : "off",
					reason: recallMachine ? undefined : memorySettings.recallModel ? "recallModel unresolvable" : "memory.recallModel not set",
					model: recallModelLabel || undefined,
					waitMs: memorySettings.recallWaitMs ?? DEFAULT_RECALL_WAIT_MS,
					sessionFiles: derived.surfaced.size,
					sessionBytes: derived.bytesUsed,
					stats: recallMachine?.stats ?? { selections: 0, empties: 0, failures: 0, lastReason: null, deliveries: 0 },
				},
				misplaced: misplacedUserFiles(udir),
				queue: queueInventory(resolveMemoryPaths(cctx.cwd ?? process.cwd(), process.env.HOME ?? home).agentDir),
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
