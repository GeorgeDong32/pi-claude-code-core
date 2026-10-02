/**
 * memory/automation.ts — the automatic maintenance hooks (V2-A, §4).
 *
 * Replaces hermes's correction-detector / background-review / session-flush
 * with the same cadence, one shared side-channel lane (llm.ts) and one
 * shared ops engine (store.ts):
 *
 *   message_end (user)   correction regex gate (EN + CJK) → pending flag
 *   turn_end             correction (≤1 per 3 turns) + review (≥10 turns or
 *                        ≥15 tool calls, ≥3 user turns warmup), both
 *                        fire-and-forget with in-flight guards; directive
 *                        turns are excluded from accounting
 *   session_before_compact  flush, awaited, 60s, follows event.signal
 *   session_shutdown     flush (reason≠reload), awaited, 10s, silent
 *
 * Everything is silent-failure (P3-ME-09): a hook must never throw, and a
 * failed side-channel call is recorded for /memory diagnostics and retried
 * by the next tick. All hooks are suppressed while yielded to hermes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { completeMemoryOps, type LlmComplete, type OpsCompletion } from "./llm.ts";
import { applyMemoryOps, type MemoryOp } from "./store.ts";
import type { ConsolidationTrigger } from "./consolidate.ts";
import { scanMemoryDirCached } from "./memdir.ts";

// ─── settings (two knobs, DESIGN-MEMORY-V2 §4) ───

export interface MemorySettings {
	/** all automatic maintenance (default true) */
	automation: boolean;
	/** side-channel model override "provider/id" (default: session model) */
	model?: string;
	/** RV-18/D3: recall selector model "provider/id" — REQUIRED for recall;
	 * unset / unresolvable = recall stays off (no lexical fallback). */
	recallModel?: string;
	/** RV-18/D4: per-message selector wait budget in ms (default 4000). */
	recallWaitMs?: number;
}

/** The default wait budget for the prompt-path selector race (D4, v1.2:
 * 0 — never block the screen on the selector; blocks deliver via pi's
 * pending-custom-message flush at the first turn_end instead. Users who
 * want request-#1 recall can still configure a positive budget). */
export const DEFAULT_RECALL_WAIT_MS = 0;

/** Clamp bounds for memory.recallWaitMs (RV-18). */
export const RECALL_WAIT_MIN_MS = 0;
export const RECALL_WAIT_MAX_MS = 15_000;

export function loadMemorySettings(agentDir: string): MemorySettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as { memory?: { automation?: unknown; model?: unknown; recallModel?: unknown; recallWaitMs?: unknown } };
		const wait = typeof raw.memory?.recallWaitMs === "number" ? raw.memory.recallWaitMs : undefined;
		return {
			automation: raw.memory?.automation !== false,
			model: typeof raw.memory?.model === "string" ? raw.memory.model : undefined,
			recallModel: typeof raw.memory?.recallModel === "string" ? raw.memory.recallModel : undefined,
			recallWaitMs: wait === undefined ? undefined : Math.min(RECALL_WAIT_MAX_MS, Math.max(RECALL_WAIT_MIN_MS, wait)),
		};
	} catch {
		return { automation: true };
	}
}

/** Resolve the side-channel model: settings override (single exact match)
 * falling back to the session model. */
export function resolveSideChannelModel(
	settings: MemorySettings,
	ctxModel: Model<Api> | undefined,
	registry: { getAll?: () => Model<Api>[] } | undefined,
): Model<Api> | undefined {
	const ref = settings.model?.trim().toLowerCase();
	if (ref && registry?.getAll) {
		const all = registry.getAll();
		const canonical = all.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === ref);
		if (canonical.length === 1) return canonical[0] as Model<Api>;
		const byId = all.filter((m) => m.id.toLowerCase() === ref);
		if (byId.length === 1) return byId[0] as Model<Api>;
	}
	return ctxModel;
}

// ─── correction gate: EN strong/weak/negative (hermes-proven) + CJK ───

const STRONG: RegExp[] = [
	/don'?t do that/i,
	/not like that/i,
	/^I said\b/i,
	/^I told you\b/i,
	/we already discussed/i,
	/^please don'?t/i,
	/^that'?s not what I/i,
	// CJK — hermes had none; this user's corrections are mostly Chinese
	/不对/,
	/不是这样/,
	/不是我要的/,
	/我(之前|刚才|早就)说过/,
	/别再/,
	/不要再/,
	/又(错|搞错)了/,
	/^记住[:：]/,
	/^以后(都|请|要|记得)/,
];

const WEAK: RegExp[] = [/^no[,.\s!]/i, /^wrong[,.\s!]/i, /^actually[,.\s]/i, /^stop[,.\s!]/i, /^错了[,，。!\s]/];

const NEGATIVE: RegExp[] = [
	/^no worries/i,
	/^no problem/i,
	/^no thanks/i,
	/^no need/i,
	/actually.{0,10}(looks? great|perfect|good|correct|right)/i,
	/^stop.{0,5}(there|here|for now)/i,
	/^没问题/,
	/^不用了/,
	/其实(很好|没问题|是对的)/,
];

const DIRECTIVE_WORDS = /\b(use|don'?t|dont|do|try|make|run|install|add|remove|delete|change|fix|put|set|write|go|stop|start|the|that|this|it)\b/i;

/** Two-pass gate: negative suppresses, strong always fires, weak fires only
 * with a directive clause after it. */
export function isCorrection(text: string): boolean {
	const t = text.trim();
	if (!t || t.length > 2000) return false;
	for (const p of NEGATIVE) if (p.test(t)) return false;
	for (const p of STRONG) if (p.test(t)) return true;
	for (const p of WEAK) {
		const m = p.exec(t);
		if (m && m.index === 0) {
			const remainder = t.slice(m[0].length).trim();
			if (DIRECTIVE_WORDS.test(remainder) || /^[\u4e00-\u9fa5]/.test(remainder)) return true;
		}
	}
	return false;
}

// ─── prompts (prose schema only — never a parseable operations example) ───

const REVIEW_SYSTEM = `You extract durable memories from coding-agent conversations and save them as operations.

Save only what survives this session: user persona/preferences/work style (layer "user"), project facts, conventions, corrections, failures and tool quirks for THIS repository (layer "project"). Corrections and failures use type "feedback" and carry a bracketed category prefix in the description, e.g. [correction], [tool-quirk], [insight], [convention], [failure].
Do not save task progress, transient state, or secrets.

Respond with JSON only, no markdown fences: a single object whose operations field is an array. Each operation object carries an action of add, replace or remove; a layer of user or project; for add also name (kebab slug), description (one line), type (user, feedback, project or reference) and body; for replace also file, body and old_text quoting an exact substring of the CURRENT file shown below; for remove also file. When the conversation contradicts an existing memory, replace it instead of adding a duplicate. If nothing is durable, return an empty operations array.`;

const CORRECTION_SYSTEM = `The user just corrected the agent. Decide the durable memory to save: priority is a user preference ("don't do X", "always Y"), then a wrong assumption the agent made, then an environment fact.
If an existing memory below is now wrong, replace that file (quote its exact text in old_text); otherwise add. Also include one feedback-type memory capturing the correction itself with a [correction] prefix in its description.
Respond with JSON only, no markdown fences: a single object whose operations field is an array (same fields as described). If the correction is purely transient (a typo, a one-off task detail), return an empty operations array.`;

const FLUSH_SYSTEM = `The session is being compressed or closed and is about to lose context. Save anything worth remembering — prioritize user preferences, corrections, and recurring patterns over task-specific detail.
Respond with JSON only, no markdown fences: a single object whose operations field is an array (add, replace or remove; layer user or project; add carries name, description, type, body; replace carries file, body and an exact old_text quote from the current file; remove carries file). If nothing is durable, return an empty operations array.`;

/** RV-15: derive a friendly project key from the project memory dir
 * (~/.pi/agent/projects/-Users-gd32-Coding-CherryDev/memory → "CherryDev").
 * Heuristic tail-segment — good enough to anchor write-side routing and
 * prompt guidance; worktree dirs surface the worktree name (acceptable). */
export function projectKeyForDir(projectDir: string): string | undefined {
	const base = projectDir.replace(/\/memory$/, "").split("/").pop() ?? "";
	const key = base.replace(/^-+/, "").split("-").pop() ?? "";
	return key.length >= 3 ? key : undefined;
}

/** RV-15: write-side routing + WHAT-NOT-TO-SAVE guidance appended to every
 * automation system prompt (own wording; the current project anchors the
 * layer decision). */
function routingGuidance(projectKey: string | undefined): string {
	const repo = projectKey ? `Current repository: ${projectKey}.` : "";
	return `\n\n${repo} Routing rules: a memory that only applies to THIS repository (its workflows, conventions, failures, tool quirks met inside it) goes to layer "project" — never "user". Layer "user" is only for what holds in EVERY project (identity, communication style, machine-level facts, behavior of cross-project tools). A preference that would contradict another project's workflow is project-scoped, not global; if a user-layer file must stay out of most projects, add a paths: ["~/some/dir/**"] line to its frontmatter. WHAT NOT TO SAVE: task progress or transient state; anything derivable from the code or git history; step-by-step debugging recipes for one-off incidents; secrets.`;
}

// ─── state surfaced to /memory ───

export interface AutomationState {
	enabled: boolean;
	reviews: number;
	corrections: number;
	flushes: number;
	opsApplied: number;
	/** RV-15: user→project routed writes (write-side guard). */
	routed: number;
	lastRouted?: string;
	lastReview?: string;
	lastCorrection?: string;
	lastFlush?: string;
	lastError?: string;
}

export interface AutomationDeps {
	complete?: LlmComplete;
	now?: () => number;
}

interface ConversationPart {
	role: "user" | "assistant";
	text: string;
}

function getMessageText(message: unknown): string {
	const m = message as { role?: string; content?: unknown } | undefined;
	if (!m || (m.role !== "user" && m.role !== "assistant")) return "";
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return (m.content as Array<{ type?: string; text?: string }>)
		.filter((p) => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text!)
		.join("\n");
}

/** Full conversation snapshot (user/assistant text, per-message cap). */
function allConversationParts(ctx: ExtensionContext, perMessageCap = 2000): ConversationPart[] {
	const parts: ConversationPart[] = [];
	try {
		const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; message?: unknown }>;
		for (const entry of entries) {
			if (entry?.type !== "message" || !entry.message) continue;
			const role = (entry.message as { role?: string }).role;
			if (role !== "user" && role !== "assistant") continue;
			const text = getMessageText(entry.message).trim();
			if (!text) continue;
			parts.push({ role, text: text.length > perMessageCap ? `${text.slice(0, perMessageCap)}…` : text });
		}
	} catch {
		/* stale session manager → empty snapshot */
	}
	return parts;
}

/** Last-N window (correction/flush use fixed windows). */
function conversationParts(ctx: ExtensionContext, limit: number): ConversationPart[] {
	return allConversationParts(ctx).slice(-limit);
}

function countToolCalls(message: unknown): number {
	const m = message as { content?: unknown } | undefined;
	if (!m || !Array.isArray(m.content)) return 0;
	return (m.content as Array<{ type?: string }>).filter((p) => p?.type === "toolCall").length;
}

/** Current memory digest for prompts: whole files, per-layer budget, so the
 * model can quote exact old_text anchors and avoid duplicates. */
function memoryDigest(dirs: { user: string; project: string }): string {
	const sections: string[] = [];
	for (const [label, dir] of [["USER", dirs.user], ["PROJECT", dirs.project]] as const) {
		const files = scanMemoryDirCached(dir).files;
		if (files.length === 0) continue;
		const chunks: string[] = [];
		let bytes = 0;
		for (const f of files) {
			const body = f.body.length > 3000 ? `${f.body.slice(0, 3000)}…` : f.body;
			if (bytes + body.length > 6000) {
				chunks.push(`(…${files.length - chunks.length} more files omitted)`);
				break;
			}
			chunks.push(body);
			bytes += body.length;
		}
		sections.push(`--- Current ${label} memory files (${dir}) ---\n${chunks.join("\n---\n")}`);
	}
	return sections.length > 0 ? sections.join("\n\n") : "(no memories yet)";
}

export interface AutomationArgs {
	gate: { state: { yielded: boolean } };
	dirs: (ctx?: { cwd?: string }) => { project: string; user: string };
	trigger: ConsolidationTrigger;
	settings: () => MemorySettings;
	state: AutomationState;
	deps?: AutomationDeps;
}

export function setupAutomation(pi: ExtensionAPI, args: AutomationArgs): void {
	const { gate, dirs, trigger, state } = args;
	const deps = args.deps ?? {};

	let pendingCorrection: string | undefined;
	let turnsSinceCorrection = 3; // start at threshold → first correction can fire
	let correctionInFlight = false;
	let turnsSinceReview = 0;
	let toolCallsSinceReview = 0;
	let userTurnCount = 0;
	let reviewInFlight = false;
	// AD5 (OPT-3): extraction cursor — only messages beyond the last review
	// are processed (no window overlap); shrinks (fork/compact) reset it.
	let reviewCursorParts = 0;
	// AD5: the main model writing memory this window means it already
	// captured what mattered — a second extraction pass would duplicate
	let modelWroteMemory = false;
	const sessionAbort = new AbortController();

	const REVIEW_TURNS = 10;
	const REVIEW_TOOL_CALLS = 15;
	const CORRECTION_COOLDOWN_TURNS = 3;
	const FLUSH_COMPACT_MS = 60_000;
	const FLUSH_SHUTDOWN_MS = 10_000;

	const sideChannelModel = (ctx: ExtensionContext): Model<Api> | undefined =>
		resolveSideChannelModel(args.settings(), ctx.model, ctx.modelRegistry as unknown as { getAll?: () => Model<Api>[] });

	/** Combine the session-abort signal with an event signal (compact Esc). */
	const linkedSignal = (extra?: AbortSignal): AbortSignal | undefined => {
		if (!extra) return sessionAbort.signal;
		const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
		return any ? any([sessionAbort.signal, extra]) : sessionAbort.signal;
	};

	async function runOps(
		kind: "review" | "correction" | "flush",
		ctx: ExtensionContext,
		systemPrompt: string,
		parts: ConversationPart[],
		timeoutMs?: number,
		extraSignal?: AbortSignal,
	): Promise<number> {
		const model = sideChannelModel(ctx);
		const projectKey = projectKeyForDir(dirs(ctx).project);
		const routedNotes: string[] = [];
		const request = {
			systemPrompt: systemPrompt + routingGuidance(projectKey),
			userPrompt: [
				memoryDigest(dirs(ctx)),
				"",
				"--- Conversation ---",
				parts.map((p) => `[${p.role === "user" ? "USER" : "ASSISTANT"}]: ${p.text}`).join("\n\n") || "(empty)",
			].join("\n"),
			timeoutMs,
			signal: linkedSignal(extraSignal),
		};
		let completion: OpsCompletion;
		try {
			completion = await completeMemoryOps(model, ctx.modelRegistry as never, request, { complete: deps.complete });
		} catch (err) {
			state.lastError = `${kind}: ${err instanceof Error ? err.message : String(err)}`;
			return 0;
		}
		if (!completion.ok) {
			if (completion.reason !== "empty") state.lastError = `${kind}: ${completion.reason ?? "failed"}${completion.error ? ` (${completion.error.slice(0, 200)})` : ""}`;
			return 0;
		}
		if (completion.ops.length === 0) return 0;
		const outcome = applyMemoryOps(completion.ops as MemoryOp[], dirs(ctx), { projectKey, routedNotes });
		if (routedNotes.length > 0) {
			state.routed += routedNotes.length;
			state.lastRouted = routedNotes.join("; ");
		}
		state.opsApplied += outcome.applied;
		if (outcome.error) state.lastError = `${kind}: ${outcome.error}`;
		return outcome.applied;
	}

	const notify = (ctx: ExtensionContext, message: string): void => {
		try {
			ctx.ui?.notify?.(message, "info");
		} catch {
			/* stale ctx */
		}
	};

	pi.on("tool_call", (event, ctx: ExtensionContext) => {
		try {
			const e = event as { toolName?: string; input?: Record<string, unknown> };
			if (e.toolName !== "write" && e.toolName !== "edit") return;
			const path = e.input?.path;
			if (typeof path !== "string") return;
			const d = dirs(ctx);
			if (path === d.user || path.startsWith(`${d.user}/`) || path === d.project || path.startsWith(`${d.project}/`)) {
				modelWroteMemory = true;
			}
		} catch {
			/* never block */
		}
	});

	pi.on("message_end", (event) => {
		try {
			if (gate.state.yielded || !state.enabled) return;
			const message = (event as { message?: unknown }).message;
			if (!message) return;
			if ((message as { role?: string }).role !== "user") return;
			userTurnCount++;
			const text = getMessageText(message);
			if (text && isCorrection(text)) pendingCorrection = text;
		} catch {
			/* never block */
		}
	});

	pi.on("turn_end", (event, ctx: ExtensionContext) => {
		try {
			if (gate.state.yielded || !state.enabled) return;
			if (trigger.directiveTurnActive) return; // consolidation turns don't count

			turnsSinceReview++;
			toolCallsSinceReview += countToolCalls((event as { message?: unknown }).message);

			// correction: rate-limited, fire-and-forget
			const correction = pendingCorrection;
			pendingCorrection = undefined;
			if (correction && turnsSinceCorrection >= CORRECTION_COOLDOWN_TURNS && !correctionInFlight) {
				turnsSinceCorrection = 0;
				correctionInFlight = true;
				const parts = conversationParts(ctx, 6);
				void runOps("correction", ctx, CORRECTION_SYSTEM, parts)
					.then((applied) => {
						state.corrections++;
						state.lastCorrection = applied > 0 ? `saved ${applied} op(s)` : "nothing durable";
						if (applied > 0) notify(ctx, `🔧 correction captured — memory updated (${applied} op${applied === 1 ? "" : "s"})`);
					})
					.catch(() => { /* P3-ME-09: fire-and-forget capture must never block the turn */ })
					.finally(() => {
						correctionInFlight = false;
					});
			} else {
				turnsSinceCorrection++;
			}

			// review: turn OR tool-call threshold, warmup, single in-flight
			const reviewDue = turnsSinceReview >= REVIEW_TURNS || toolCallsSinceReview >= REVIEW_TOOL_CALLS;
			if (reviewDue && userTurnCount >= 3 && !reviewInFlight && !sessionAbort.signal.aborted) {
				turnsSinceReview = 0;
				toolCallsSinceReview = 0;
				// AD5 mutex: the model wrote memory itself this window — skip
				// the extraction pass (advance the cursor so it never replays)
				if (modelWroteMemory) {
					modelWroteMemory = false;
					reviewCursorParts = allConversationParts(ctx).length;
					state.reviews++;
					state.lastReview = "skipped — model wrote memory this window";
					return;
				}
				reviewInFlight = true;
				const allParts = allConversationParts(ctx);
				const parts = reviewCursorParts > allParts.length ? allParts : allParts.slice(reviewCursorParts);
				reviewCursorParts = allParts.length;
				void runOps("review", ctx, REVIEW_SYSTEM, parts)
					.then((applied) => {
						state.reviews++;
						state.lastReview = applied > 0 ? `saved ${applied} op(s)` : "nothing durable";
						if (applied > 0) notify(ctx, `💾 memory auto-reviewed (${applied} op${applied === 1 ? "" : "s"})`);
					})
					.catch(() => { /* P3-ME-09: fire-and-forget capture must never block the turn */ })
					.finally(() => {
						reviewInFlight = false;
					});
			}
		} catch {
			/* never block the turn */
		}
	});

	pi.on("session_before_compact", async (event, ctx: ExtensionContext) => {
		try {
			if (gate.state.yielded || !state.enabled) return;
			if (userTurnCount < 3) return;
			const signal = (event as { signal?: AbortSignal }).signal;
			if (signal?.aborted) return;
			const parts = conversationParts(ctx, 60);
			if (parts.length === 0) return;
			const applied = await runOps("flush", ctx, FLUSH_SYSTEM, parts, FLUSH_COMPACT_MS, signal);
			state.flushes++;
			state.lastFlush = `compact: ${applied} op(s)`;
			if (applied > 0) notify(ctx, `💾 memory flush before compact saved ${applied} op(s)`);
		} catch {
			/* compaction must never be blocked by a failed flush */
		}
	});

	pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
		try {
			const reason = (event as { reason?: string }).reason;
			if (reason === "reload") return;
			if (gate.state.yielded || !state.enabled) return;
			if (userTurnCount < 3) return;
			const parts = conversationParts(ctx, 60);
			if (parts.length === 0) return;
			// bounded silent flush — errors are diagnostics, never UI at shutdown
			const applied = await runOps("flush", ctx, FLUSH_SYSTEM, parts, FLUSH_SHUTDOWN_MS);
			state.flushes++;
			state.lastFlush = `shutdown: ${applied} op(s)`;
		} catch {
			/* never block shutdown */
		} finally {
			sessionAbort.abort(); // cancel any in-flight side-channel work
		}
	});
}
