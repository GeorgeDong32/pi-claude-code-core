import { notify as sharedNotify } from "../ui/notify.ts";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { coreBus } from "../bus.ts";
import { eligibleMemories, listMemoryFiles, scanMemoryDir, scanMemoryDirCached } from "./memdir.ts";
import { reindex } from "./writer.ts";
import { friendlyProjectHint } from "./paths.ts";
import { resolveMemoryPaths, sessionsDirFor, gitCanonicalRoot } from "./paths.ts";
import { buildPolicyInjection, descriptionTooLong, DESCRIPTION_MAX, policyCompact } from "./policy.ts";
import { knowledgeSearch, lookupTool, searchTool } from "./lookup.ts";
import { appendMemoryStatsEntry, emptyCounters, MEMORY_STATS_ENTRY_TYPE, type MemoryStatsCounters } from "./stats-entry.ts";
import { renderMemoryDiagnostics } from "./diagnostics.ts";
import { queueInventory } from "./queue.ts";
import { byteLength, createRecall, deriveHistory, freshnessHeader, type RecallBlock, type RecallMachine } from "./recall.ts";
import { llmSelector, resolveRecallModel } from "./selector.ts";
import { guardMemoryToolCall, sessionHome, type GuardVerdict } from "./guard.ts";
import { matchProtectedPath, protectedPathBlockReason, protectedPathFiles } from "./protected-paths.ts";
import { newestSnapshot, snapshotLayer, snapshotRoot, type SnapshotManifest } from "./snapshot.ts";
import { sanitizePath } from "./paths.ts";
import { createHash } from "node:crypto";
import { InjectionGate } from "./yield.ts";
import { recallTransparencyLine, sessionRecall } from "./session-recall.ts";
import { readSessionProjection } from "../modes/session-branch.ts";
import {
	knowledgeSearchResultRows,
	memoryLookupResultRows,
	renderKnowledgeSearchCall,
	renderMemoryLookupCall,
	renderSessionRecallCall,
	sessionRecallResultRows,
	type KnowledgeSearchArgs,
	type MemoryLookupArgs,
	type SessionRecallArgs,
} from "./renderers.ts";
import { renderRows } from "../../lib/tool-render.ts";
import { registerConsolidation } from "./consolidate.ts";

import { setupAutomation, loadMemorySettings, DEFAULT_RECALL_WAIT_MS, type AutomationState, type MemorySettings } from "./automation.ts";
import { importFromClaude, importFromHermes, importHermesFull } from "./importers.ts";

export interface MemoryExtensionDeps {
	selectorFactory?: typeof llmSelector;
}

export default function memoryExtension(pi: ExtensionAPI, extensionDeps: MemoryExtensionDeps = {}): void {
	const home = homedir();
	const gate = new InjectionGate(join(process.env.HOME ?? home, ".pi", "agent"));

	let degradedNotified = false;
	let memoryDirWritable = true;
	let memorySettings: MemorySettings = { automation: true };
	const automationState: AutomationState = { enabled: true, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0 };
	const stats: MemoryStatsCounters = emptyCounters();
	let descWarned = false;
	function indexBytesFor(ctx: ExtensionContext): { bytes: number; rows: number } {
		const text = injectionFor(ctx);
		const at = text.indexOf("# Project memory index");
		const section = at >= 0 ? text.slice(at) : "";
		return { bytes: byteLength(section), rows: (section.match(/^-/gm) ?? []).length };
	}
	function descriptionViolations(dir: string): string[] {
		return scanMemoryDir(dir).entries.filter((e) => descriptionTooLong(e.description)).map((e) => e.file.replace(/\.md$/, ""));
	}
	let recallMachine: RecallMachine | null = null;
	let recallModelLabel = "";
	let recallOffNotified = false;
	let sessionStartedAtMs = 0;
	// Mid-session memory writes must not flip the system prompt and kill the
	// KV cache — the policy block is rebuilt only at session start or after
	// a compaction.
	let injectionCache: { text: string; compactions: number; writable: boolean } | null = null;
	let consolidationDirectiveActive = false;
	let consolidationLastReason: string | null = null;

	function historyFor(ctx: ExtensionContext): readonly unknown[] {
		return readSessionProjection(ctx.sessionManager);
	}

	function countCompactions(ctx: ExtensionContext): number {
		let n = 0;
		for (const m of historyFor(ctx) as Array<{ role?: string }>) {
			if (m?.role === "compactionSummary") n += 1;
		}
		return n;
	}

	function makeRecallMessage(block: RecallBlock) {
		return {
			customType: block.customType,
			content: [{ type: "text" as const, text: block.text }],
			display: false,
			details: block.details,
		};
	}

	function ensureRecallMachine(ctx: ExtensionContext): RecallMachine | null {
		if (!memorySettings.recallModel) {
			if (recallMachine) {
				recallMachine.dispose();
				recallMachine = null;
				recallModelLabel = "";
			}
			return null;
		}
		const registry = ctx.modelRegistry as { getAll?: () => unknown[] } | undefined;
		const model = resolveRecallModel(memorySettings.recallModel, registry);
		if (!model) {
			if (!recallOffNotified) {
				recallOffNotified = true;
				console.log(`pi-memory: recallModel "${memorySettings.recallModel}" unresolvable — recall off`);
			}
			if (recallMachine) {
				recallMachine.dispose();
				recallMachine = null;
				recallModelLabel = "";
			}
			return null;
		}
		const label = `${(model as unknown as { provider: string }).provider}/${(model as unknown as { id: string }).id}`;
		if (!recallMachine || recallModelLabel !== label) {
			recallMachine?.dispose();
			recallModelLabel = label;
			recallMachine = createRecall({
				selector: (extensionDeps.selectorFactory ?? llmSelector)({ model: () => model, registry: () => ctx.modelRegistry as never }),
				modelLabel: label,
				files: () =>
					eligibleMemories(memoryDir(ctx)).filter((f) => f.mtimeMs < sessionStartedAtMs),
				cwd: ctx.cwd ?? process.cwd(),
				diagnose: (message) => console.log(`pi-memory: recall ${message}`),
			});
		}
		return recallMachine;
	}

	function misplacedUserFiles(udir: string): Array<{ file: string; key: string }> {
		try {
			const projectsRoot = join(process.env.HOME ?? home, ".pi", "agent", "projects");
			if (!existsSync(projectsRoot)) return [];
			const keys = new Set(
				readdirSync(projectsRoot)
					.map((d) => friendlyProjectHint(d))
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

	function injectionFor(ctx: ExtensionContext): string {
		const dir = memoryDir(ctx);
		if (!memoryDirWritable) return policyCompact(dir);
		const compactions = countCompactions(ctx);
		if (injectionCache && injectionCache.compactions === compactions && injectionCache.writable === memoryDirWritable) {
			return injectionCache.text;
		}
		const projectScan = scanMemoryDirCached(dir);
		const pinned = scanMemoryDirCached(userMemoryDir(ctx)).files.filter((f) => f.entry.pinned);
		const text =
			buildPolicyInjection(
				{ entries: pinned.map((f) => ({ ...f.entry })), files: pinned.map((f) => ({ entry: f.entry, body: f.body })) },
				projectScan.files.map((f) => ({ ...f.entry })),
				dir,
			) + (projectScan.skipped > 0 ? `\n<!-- memory: ${projectScan.skipped} file(s) skipped (invalid frontmatter) -->` : "");
		injectionCache = { text, compactions, writable: memoryDirWritable };
		return text;
	}

	async function recallBlockFor(text: string, ctx: ExtensionContext, waitMs: number): Promise<RecallBlock | null> {
		const machine = ensureRecallMachine(ctx);
		if (!machine) return null;
		return machine.onUserMessage(text, () => historyFor(ctx), waitMs);
	}

	function memoryDir(ctx?: { cwd?: string }): string {
		return resolveMemoryPaths(ctx?.cwd ?? process.cwd(), process.env.HOME ?? home).memoryDir;
	}

	function userMemoryDir(ctx?: { cwd?: string }): string {
		return resolveMemoryPaths(ctx?.cwd ?? process.cwd(), process.env.HOME ?? home).userMemoryDir;
	}

	function notifyOnce(ctx: ExtensionContext | undefined, msg: string): void {
		if (degradedNotified) return;
		degradedNotified = true;
		if (ctx?.hasUI) sharedNotify(ctx, msg, "warning");
	}

	let warnedMisfiles = new Set<string>();
	let protectedBaseline = new Map<string, string | null>();
	let bypassNoticeShown = false;

	const sha256Of = (file: string): string | null => {
		try {
			return createHash("sha256").update(readFileSync(file)).digest("hex");
		} catch {
			return null;
		}
	};

	const DELETION_SPIKE_FILES = 3;
	const BYTES_DROP_RATIO = 0.3;

	const snapshotBothLayers = (ctx: ExtensionContext): void => {
		try {
			const homeNow = sessionHome();
			snapshotLayer(userMemoryDir(ctx), snapshotRoot(homeNow, "user"));
			snapshotLayer(memoryDir(ctx), snapshotRoot(homeNow, `project-${sanitizePath(gitCanonicalRoot(ctx.cwd ?? process.cwd()) ?? (ctx.cwd ?? process.cwd()))}`));
		} catch {
		}
	};

	let consolidationUsedThisSession = false;
	const checkMassDeletion = (ctx: ExtensionContext): void => {
		try {
			if (consolidationUsedThisSession) return;
			const homeNow = sessionHome();
			const layers: Array<{ label: string; dir: string; root: string }> = [
				{ label: "user", dir: userMemoryDir(ctx), root: snapshotRoot(homeNow, "user") },
				{ label: "project", dir: memoryDir(ctx), root: snapshotRoot(homeNow, `project-${sanitizePath(gitCanonicalRoot(ctx.cwd ?? process.cwd()) ?? (ctx.cwd ?? process.cwd()))}`) },
			];
			for (const layer of layers) {
				const snap = newestSnapshot(layer.root);
				if (!snap) continue;
				const current = listMemoryFiles(layer.dir);
				const snapFiles = snap.manifest.files.filter((f) => f.file !== "MEMORY.md").map((f) => f.file);
				const deleted = snapFiles.filter((f) => !current.includes(f));
				const snapBytes = (m: SnapshotManifest) => m.files.filter((f) => f.file !== "MEMORY.md").reduce((a, f) => a + f.bytes, 0);
				const currentBytes = current.reduce((a, f) => {
					try {
						return a + statSync(join(layer.dir, f)).size;
					} catch {
						return a;
					}
				}, 0);
				const dropped = snapBytes(snap.manifest) > 0 && currentBytes < snapBytes(snap.manifest) * (1 - BYTES_DROP_RATIO);
				if (deleted.length >= DELETION_SPIKE_FILES || dropped) {
					if (ctx?.hasUI) {
						sharedNotify(
							ctx,
							`memory ${layer.label} layer lost ${deleted.length} file(s)${dropped ? ` and ${Math.round((1 - currentBytes / Math.max(1, snapBytes(snap.manifest))) * 100)}% of its bytes` : ""} this session without memory_consolidate — rollback snapshots live under ${layer.root}`,
							"warning",
						);
					}
					return;
				}
			}
		} catch {
		}
	};

	const baselineProtectedFiles = (ctx: ExtensionContext): void => {
		try {
			protectedBaseline = new Map(
				protectedPathFiles({ home: sessionHome(), cwd: ctx.cwd ?? process.cwd() }).map((f) => [f, sha256Of(f)] as const),
			);
		} catch {
			protectedBaseline = new Map<string, string | null>();
		}
	};

	const checkProtectedFiles = (ctx: ExtensionContext): void => {
		try {
			if (bypassNoticeShown || protectedBaseline.size === 0) return;
			const changed: string[] = [];
			for (const [file, was] of protectedBaseline) {
				if (sha256Of(file) !== was) changed.push(file);
			}
			if (changed.length === 0) return;
			bypassNoticeShown = true;
			if (ctx?.hasUI) {
				sharedNotify(
					ctx,
					`Protected files changed outside the tool guard: ${changed.join(", ")} — if this was not your own manual edit, review them.`,
					"warning",
				);
			}
		} catch {
		}
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		try {
			warnedMisfiles = new Set();
			bypassNoticeShown = false;
			descWarned = false;
			Object.assign(stats, emptyCounters());
			automationState.descRewritten = 0;
			consolidationUsedThisSession = false;
			consolidationDirectiveActive = false;
			consolidationLastReason = null;
			baselineProtectedFiles(ctx);
			sessionStartedAtMs = Date.now();
			injectionCache = null;
			snapshotBothLayers(ctx);
			recallMachine?.dispose();
			recallMachine = null;
			recallModelLabel = "";
			recallOffNotified = false;
			gate.probeStatic();
			memorySettings = loadMemorySettings(join(process.env.HOME ?? home, ".pi", "agent"));
			automationState.enabled = memorySettings.automation;
			try {
				mkdirSync(memoryDir(ctx), { recursive: true });
			} catch {
			}
			reindex(memoryDir(ctx));
			if (!descWarned) {
				const violations = descriptionViolations(memoryDir(ctx));
				if (violations.length > 0) {
					descWarned = true;
					if (ctx?.hasUI) {
						sharedNotify(
							ctx,
							`${violations.length} memory description(s) exceed ${DESCRIPTION_MAX} chars — rewrite them as noun phrases when touched: ${violations.slice(0, 4).join(", ")}${violations.length > 4 ? ", …" : ""}`,
							"warning",
						);
					}
				}
			}
			try {
				accessSync(memoryDir(ctx), fsConstants.W_OK);
				memoryDirWritable = true;
			} catch {
				memoryDirWritable = false;
			}
			coreBus().publish({
				memory: { yielded: gate.state.yielded, ...(gate.state.yielded ? { dir: memoryDir(ctx) } : {}) },
			});
			automation.drainPending(ctx);
		} catch {
		}
	});


	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		try {
			// pi 1.2.0: before_agent_start also fires for custom-message runs
			// (sendMessage triggerTurn:true — goal continuation, review directive,
			// memory-consolidation directive, modes refinement) with messageType
			// "custom" and no `prompt`. Recall runs ONLY on user runs — the task
			// boundary is a real user message; custom runs get the (stable,
			// cached) injection but never a selection.
			const isUserRun = event.messageType === "user";
			if (isUserRun) recallMachine?.abort();
			const wasYielded = gate.state.yielded;
			gate.probePrompt(event.systemPrompt ?? "");
			if (gate.state.yielded !== wasYielded) {
				coreBus().publish({
					memory: { yielded: gate.state.yielded, ...(gate.state.yielded ? { dir: memoryDir(ctx) } : {}) },
				});
			}
			if (gate.state.yielded) return undefined;
			if (!memoryDirWritable) notifyOnce(ctx, "memory dir not writable — running policy-only");
			const systemPrompt = `${event.systemPrompt ?? ""}\n\n${injectionFor(ctx)}`;
			const waitMs = memorySettings.recallWaitMs ?? DEFAULT_RECALL_WAIT_MS;
			const block = isUserRun ? await recallBlockFor(event.prompt, ctx, waitMs) : null;
			if (block) stats.recallInjections++;
			return block ? { systemPrompt, message: makeRecallMessage(block) } : { systemPrompt };
		} catch {
			return undefined;
		}
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		try {
			const name = typeof event.toolName === "string" ? event.toolName : "";
			const input = (event.input ?? {}) as Record<string, unknown>;
			const target = typeof input.path === "string" ? input.path : "";
			const protectedHit = matchProtectedPath(target, { home: sessionHome(), cwd: ctx.cwd ?? process.cwd() });
			if (protectedHit) {
				return { block: true, reason: protectedPathBlockReason(protectedHit) };
			}
			const verdict: GuardVerdict = guardMemoryToolCall(name, input, {
				projectDir: memoryDir(ctx),
				userDir: userMemoryDir(ctx),
				childSession: process.env.PI_SUBAGENT_CHILD === "1",
			});
			if (verdict.block) {
				return { block: true, reason: verdict.reason };
			}
			if (verdict.warn !== undefined && !warnedMisfiles.has(verdict.warn)) {
				warnedMisfiles.add(verdict.warn);
				if (ctx?.hasUI) sharedNotify(ctx, verdict.warn, "warning");
			}
		} catch {
		}
		return undefined;
	});

	registerConsolidation(
		pi,
		(ctx) => ({ project: memoryDir(ctx) }),
		{
			onDirectiveSent: (reason) => {
				consolidationDirectiveActive = true;
				consolidationLastReason = reason;
			},
			onApplied: () => {
				consolidationUsedThisSession = true;
			},
		},
	);
	pi.on("agent_end", (_event, ctx: ExtensionContext) => {
		try {
			checkMassDeletion(ctx);
			checkProtectedFiles(ctx);
		} catch {
		}
		try {
			const index = indexBytesFor(ctx);
			appendMemoryStatsEntry(pi, {
				v: 1,
				indexBytes: index.bytes,
				indexRows: index.rows,
				descTooLong: descriptionViolations(memoryDir(ctx)).length,
				...stats,
				descRewritten: automationState.descRewritten ?? 0,
			});
			Object.assign(stats, emptyCounters());
			automationState.descRewritten = 0;
		} catch {
		}
	});
	pi.on("tool_result", (event, ctx: ExtensionContext) => {
		try {
			if ((event as { toolName?: string }).toolName === "memory_consolidate") {
				consolidationUsedThisSession = true;
			}
			const e = event as { toolName?: string; input?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> };
			if (e.toolName === "read" && typeof e.input?.path === "string") {
				const path = e.input.path;
				if ([userMemoryDir(ctx), memoryDir(ctx)].some((d) => path === d || path.startsWith(`${d}/`))) {
					stats.memoryReads++;
					const header = (() => {
						try {
							return freshnessHeader(statSync(path).mtimeMs, readFileSync(path, "utf8"));
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
		}
		return undefined;
	});
	pi.on("session_shutdown", (_event, _ctx: ExtensionContext) => {
		try {
			recallMachine?.dispose();
			recallMachine = null;
			recallModelLabel = "";
		} catch {
		}
	});
	pi.on("agent_settled", () => {
		try {
			consolidationDirectiveActive = false;
		} catch {
		}
	});

	const automation = setupAutomation(pi, {
		gate,
		dirs: (ctx) => {
			const p = resolveMemoryPaths(ctx?.cwd ?? process.cwd(), process.env.HOME ?? home);
			return { project: p.memoryDir, projectsDir: p.projectsDir, agentDir: p.agentDir };
		},
		isDirectiveTurn: () => consolidationDirectiveActive,
		settings: () => memorySettings,
		state: automationState,
	});

	pi.registerTool(defineTool({
		name: "session_recall",
		label: "Session Recall",
		exposure: "codemode",
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
		renderCall: (args, theme) => renderSessionRecallCall(args as SessionRecallArgs, theme as never),
		renderResult: (result, _options, theme) =>
			renderRows(sessionRecallResultRows(result), theme as never),
	}));
	pi.registerTool({
		...lookupTool(memoryDir, () => {
			stats.lookups++;
		}),
		renderCall: (args, theme) => renderMemoryLookupCall(args as MemoryLookupArgs, theme as never),
		renderResult: (result, _options, theme) => renderRows(memoryLookupResultRows(result), theme as never),
	});
	pi.registerTool({
		...searchTool(
			(ctx) => ({
				home,
				memoryDir: memoryDir(ctx),
				searchRoots: memorySettings.searchRoots,
				sessionSearch: async (input) => {
					const r = await sessionRecall({ ...input, home });
					return { hits: r.hits, scannedFiles: r.scannedFiles };
				},
			}),
			() => {
				stats.searches++;
			},
		),
		renderCall: (args, theme) => renderKnowledgeSearchCall(args as KnowledgeSearchArgs, theme as never),
		renderResult: (result, _options, theme) => renderRows(knowledgeSearchResultRows(result), theme as never),
	});

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
			}
			try {
				userIndexBytes = byteLength(readFileSync(join(udir, "MEMORY.md"), "utf-8"));
			} catch {
			}
			const cctx = ctx as ExtensionContext;
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
				consolidation: { lastReason: consolidationLastReason },
				yielded: { yielded: gate.state.yielded, detectedBy: gate.state.detectedBy },
				recall: {
					status: recallMachine ? "on" : "off",
					reason: recallMachine ? undefined : memorySettings.recallModel ? "recallModel unresolvable" : "memory.recallModel not set",
					model: recallModelLabel || undefined,
					waitMs: memorySettings.recallWaitMs ?? DEFAULT_RECALL_WAIT_MS,
					sessionFiles: derived.surfaced.size,
					sessionBytes: derived.bytesUsed,
					stats: recallMachine?.stats ?? { selections: 0, empties: 0, failures: 0, late: 0, lastReason: null, deliveries: 0 },
				},
				misplaced: misplacedUserFiles(udir),
				queue: queueInventory(resolveMemoryPaths(cctx.cwd ?? process.cwd(), process.env.HOME ?? home).agentDir),
				hermesDataFound:
					existsSync(join(process.env.HOME ?? home, ".pi", "agent", "pi-hermes-memory", "MEMORY.md")) ||
					existsSync(join(process.env.HOME ?? home, ".pi", "agent", "pi-hermes-memory", "USER.md")),
			});
			
			pi.sendMessage({
				customType: "pi-memory-status",
				content,
				details: { command: "/memory" },
				display: true,
			});
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
			pi.sendMessage({
				customType: "pi-memory-status",
				content: text,
				details: { command: "/memory-import-claude" },
				display: true,
			});
		},
	});

	pi.registerCommand("memory-import-hermes", {
		description: "Migrate ALL hermes data (USER.md + MEMORY.md + failures.md + this project's store) into the project memory layer; a file argument imports that single §-store",
		handler: async (args, ctx) => {
			const cctx = ctx as ExtensionContext;
			const text: string[] = [];
			if (args.trim()) {
				const file = args.trim();
				const report = importFromHermes(file, memoryDir(cctx));
				text.push(`memory-import-hermes: converted ${report.copied}, skipped ${report.skipped} (idempotent)`, ...report.notes);
			} else {
				const agentDir = join(process.env.HOME ?? home, ".pi", "agent");
				const report = importHermesFull({
					agentDir,
					projectMemoryDir: memoryDir(cctx),
				});
				text.push(
					`memory-import-hermes: migrated ${report.copied} fact(s) into the project layer — skipped: ${report.skipped} (idempotent; the user layer is retired, everything lands in the project store)`,
					...report.notes,
				);
			}
			pi.sendMessage({
				customType: "pi-memory-status",
				content: text.join("\n"),
				details: { command: "/memory-import-hermes" },
				display: true,
			});
		},
	});
}
