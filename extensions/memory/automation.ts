import { notify as sharedNotify } from "../ui/notify.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { registerCompactionSubscriber } from "../../lib/compaction-seam.ts";

import { completeMemoryOpsCapped, resolveModelRef, type LlmComplete, type OpsCompletion } from "./llm.ts";
import { applyMemoryOps, type MemoryOp } from "./store.ts";
import { scanMemoryDirCached } from "./memdir.ts";
import { friendlyProjectHint } from "./paths.ts";
import type { ConversationPart } from "./queue.ts";
import { clampQueueParts, QUEUE_V, writeQueueRecord } from "./queue.ts";
import { drainQueue, FLUSH_QUEUE_MS, type DrainCap, type QueueDrainPorts } from "./queue-drain.ts";
import { readJson } from "../../lib/settings.ts";
import { readBranchEntries, readSessionId } from "../modes/session-branch.ts";


export interface MemorySettings {
	automation: boolean;
	model?: string;
	recallModel?: string;
	recallWaitMs?: number;
	searchRoots?: string[];
}

export const DEFAULT_RECALL_WAIT_MS = 5_000;

export const RECALL_WAIT_MIN_MS = 1_000;
export const RECALL_WAIT_MAX_MS = 15_000;

export function loadMemorySettings(agentDir: string): MemorySettings {
	const raw = readJson<{
		memory?: { automation?: unknown; model?: unknown; recallModel?: unknown; recallWaitMs?: unknown; searchRoots?: unknown };
	}>(join(agentDir, "settings.json"), {});
	const wait = typeof raw.memory?.recallWaitMs === "number" ? raw.memory.recallWaitMs : undefined;
	const searchRoots = Array.isArray(raw.memory?.searchRoots)
		? raw.memory.searchRoots.filter((r): r is string => typeof r === "string" && r.startsWith("/"))
		: [];
	return {
		automation: raw.memory?.automation !== false,
		model: typeof raw.memory?.model === "string" ? raw.memory.model : undefined,
		recallModel: typeof raw.memory?.recallModel === "string" ? raw.memory.recallModel : undefined,
		recallWaitMs: wait === undefined ? undefined : Math.min(RECALL_WAIT_MAX_MS, Math.max(RECALL_WAIT_MIN_MS, wait)),
		...(searchRoots.length > 0 ? { searchRoots } : {}),
	};
}

export function resolveSideChannelModel(
	settings: MemorySettings,
	ctxModel: Model<Api> | undefined,
	registry: { getAll?: () => Model<Api>[] } | undefined,
): Model<Api> | undefined {
	return resolveModelRef(settings.model, registry) ?? resolveModelRef(settings.recallModel, registry) ?? ctxModel;
}


const STRONG: RegExp[] = [
	/don'?t do that/i,
	/not like that/i,
	/^I said\b/i,
	/^I told you\b/i,
	/we already discussed/i,
	/^please don'?t/i,
	/^that'?s not what I/i,
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


const REVIEW_SYSTEM = `You extract durable memories from coding-agent conversations and save them as operations.

Save only what survives this session and applies to THIS repository: project facts, conventions, corrections, failures and tool quirks (layer "project"). Corrections and failures use type "feedback" and carry a bracketed category prefix in the description, e.g. [correction], [tool-quirk], [insight], [convention], [failure].
Do not save task progress, transient state, the user's current requirements, unresolved questions or pending confirmations (save only settled decisions and verified facts), anything derivable from the code or git history, or secrets.

Respond with JSON only, no markdown fences: a single object whose operations field is an array. Each operation object carries an action of add, replace or remove; a layer of "project"; for add also name (kebab slug), description (a single line, a noun phrase of at most 80 characters carrying the topic keywords — not a sentence), type (feedback, project or reference) and body; for replace also file, body and old_text quoting an exact substring of the CURRENT file shown below; for remove also file. When the conversation contradicts an existing memory, replace it instead of adding a duplicate. If nothing is durable, return an empty operations array.`;

const CORRECTION_SYSTEM = `The user just corrected the agent. Decide the durable PROJECT memory to save: a wrong assumption the agent made, a project convention, or an environment/tool fact.
If an existing memory below is now wrong, replace that file (quote its exact text in old_text); otherwise add. Also include one feedback-type memory capturing the correction itself with a [correction] prefix in its description.
Respond with JSON only, no markdown fences: a single object whose operations field is an array (same fields as described). If the correction is purely transient (a typo, a one-off task detail, or a request about the current task only), return an empty operations array.`;

const FLUSH_SYSTEM = `The session is being compressed or closed and is about to lose context. Save durable PROJECT facts worth remembering — prioritize corrections and recurring patterns over task-specific detail. Never save task progress, the user's current requirements, unresolved questions or pending confirmations.
Respond with JSON only, no markdown fences: a single object whose operations field is an array (add, replace or remove; layer "project"; add carries name, description (noun phrase, at most 80 characters), type, body; replace carries file, body and an exact old_text quote from the current file; remove carries file). If nothing is durable, return an empty operations array.`;

export function projectKeyForDir(projectDir: string): string | undefined {
	const key = friendlyProjectHint(projectDir);
	return key.length >= 3 ? key : undefined;
}

function routingGuidance(projectKey: string | undefined): string {
	const repo = projectKey ? `Current repository: ${projectKey}.` : "";
	return `\n\n${repo} All operations go to layer "project" — the cross-project user layer is retired; never target it. WHAT NOT TO SAVE: task progress or transient state; the user's current requirements, unresolved questions or pending confirmations; anything derivable from the code or git history; step-by-step debugging recipes for one-off incidents; secrets.`;
}


export interface AutomationState {
	enabled: boolean;
	reviews: number;
	corrections: number;
	flushes: number;
	opsApplied: number;
	descRewritten?: number;
	lastReview?: string;
	lastCorrection?: string;
	lastFlush?: string;
	lastError?: string;
}

export interface AutomationDeps {
	complete?: LlmComplete;
}

export type { ConversationPart } from "./queue.ts";

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

function allConversationParts(ctx: ExtensionContext, perMessageCap = 2000): ConversationPart[] {
	const parts: ConversationPart[] = [];
	try {
		const entries = readBranchEntries(ctx.sessionManager) as Array<{ type?: string; message?: unknown }>;
		for (const entry of entries) {
			if (entry?.type !== "message" || !entry.message) continue;
			const role = (entry.message as { role?: string }).role;
			if (role !== "user" && role !== "assistant") continue;
			const text = getMessageText(entry.message).trim();
			if (!text) continue;
			parts.push({ role, text: text.length > perMessageCap ? `${text.slice(0, perMessageCap)}…` : text });
		}
	} catch {
	}
	return parts;
}

export function conversationParts(ctx: ExtensionContext, limit: number): ConversationPart[] {
	const collected: ConversationPart[] = [];
	try {
		const entries = readBranchEntries(ctx.sessionManager) as Array<{ type?: string; message?: unknown }>;
		for (let i = entries.length - 1; i >= 0 && collected.length < limit; i -= 1) {
			const entry = entries[i];
			if (entry?.type !== "message" || !entry.message) continue;
			const role = (entry.message as { role?: string }).role;
			if (role !== "user" && role !== "assistant") continue;
			const text = getMessageText(entry.message).trim();
			if (!text) continue;
			collected.push({ role, text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text });
		}
	} catch {
	}
	return collected.reverse();
}

function countToolCalls(message: unknown): number {
	const m = message as { content?: unknown } | undefined;
	if (!m || !Array.isArray(m.content)) return 0;
	return (m.content as Array<{ type?: string }>).filter((p) => p?.type === "toolCall").length;
}

function memoryDigest(dirs: { project: string }): string {
	const files = scanMemoryDirCached(dirs.project).files;
	if (files.length === 0) return "(no memories yet)";
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
	return `--- Current PROJECT memory files (${dirs.project}) ---\n${chunks.join("\n---\n")}`;
}

export interface AutomationArgs {
	gate: { state: { yielded: boolean } };
	dirs: (ctx?: { cwd?: string }) => { project: string; projectsDir: string; agentDir: string };
	isDirectiveTurn?: () => boolean;
	settings: () => MemorySettings;
	state: AutomationState;
	deps?: AutomationDeps;
}

// The host hands out stale ctx objects after a /new or /resume — a
// throwing ui accessor must never break the turn hook.
export function automationNotify(ctx: ExtensionContext, message: string): void {
	try {
		sharedNotify(ctx, message, "info");
	} catch {
	}
}

let unregisterMemorySeam: (() => void) | undefined;

export function setupAutomation(pi: ExtensionAPI, args: AutomationArgs): { drainPending: (ctx: ExtensionContext) => void } {
	const { gate, dirs, state } = args;
	const isDirectiveTurn = args.isDirectiveTurn ?? (() => false);
	const deps = args.deps ?? {};

	let pendingCorrection: string | undefined;
	let turnsSinceCorrection = 3;
	let correctionInFlight = false;
	let turnsSinceReview = 0;
	let toolCallsSinceReview = 0;
	let userTurnCount = 0;
	let reviewInFlight = false;
	let reviewCursorParts = 0;
	let modelWroteMemory = false;
	let sessionAbort = new AbortController();
	const drainBlacklist = new Set<string>();

	const REVIEW_TURNS = 10;
	const REVIEW_MAX_PARTS = 60;
	const REVIEW_TOOL_CALLS = 15;
	const CORRECTION_COOLDOWN_TURNS = 3;
	const FLUSH_QUEUE_MS = 20_000;
	const QUEUE_DRAIN_MAX = 5;
	const QUEUE_MAX_ATTEMPTS = 3;

	const sideChannelModel = (ctx: ExtensionContext): Model<Api> | undefined =>
		resolveSideChannelModel(args.settings(), ctx.model, ctx.modelRegistry as unknown as { getAll?: () => Model<Api>[] });

	const linkedSignal = (extra?: AbortSignal): AbortSignal | undefined => {
		if (!extra) return sessionAbort.signal;
		const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
		return any ? any([sessionAbort.signal, extra]) : sessionAbort.signal;
	};

	const buildOpsUserPrompt = (d: { project: string }, parts: ConversationPart[]): string =>
		[
			memoryDigest(d),
			"",
			"--- Conversation ---",
			parts.map((p) => `[${p.role === "user" ? "USER" : "ASSISTANT"}]: ${p.text}`).join("\n\n") || "(empty)",
		].join("\n");

	async function runOps(
		kind: "review" | "correction",
		ctx: ExtensionContext,
		systemPrompt: string,
		parts: ConversationPart[],
		timeoutMs?: number,
		extraSignal?: AbortSignal,
	): Promise<number> {
		const model = sideChannelModel(ctx);
		const projectKey = projectKeyForDir(dirs(ctx).project);
		const request = {
			systemPrompt: systemPrompt + routingGuidance(projectKey),
			userPrompt: buildOpsUserPrompt({ project: dirs(ctx).project }, parts),
			timeoutMs,
			signal: linkedSignal(extraSignal),
		};
		let completion: Awaited<ReturnType<typeof completeMemoryOpsCapped>>;
		try {
			completion = await completeMemoryOpsCapped(model, ctx.modelRegistry as never, request, { complete: deps.complete });
		} catch (err) {
			state.lastError = `${kind}: ${err instanceof Error ? err.message : String(err)}`;
			return 0;
		}
		if (!completion.ok) {
			if (completion.reason !== "empty") state.lastError = `${kind}: ${completion.reason ?? "failed"}${completion.error ? ` (${completion.error.slice(0, 200)})` : ""}`;
			return 0;
		}
		if (completion.ops.length === 0) return 0;
		state.descRewritten = (state.descRewritten ?? 0) + (completion.rewritten ?? 0);
		const outcome = applyMemoryOps(completion.ops as MemoryOp[], { project: dirs(ctx).project });
		state.opsApplied += outcome.applied;
		if (outcome.error) state.lastError = `${kind}: ${outcome.error}`;
		return outcome.applied;
	}

	const notify = automationNotify;

	pi.on("tool_call", (event, ctx: ExtensionContext) => {
		try {
			const e = event as { toolName?: string; input?: Record<string, unknown> };
			if (e.toolName !== "write" && e.toolName !== "edit") return;
			const path = e.input?.path;
			if (typeof path !== "string") return;
			const project = dirs(ctx).project;
			if (path === project || path.startsWith(`${project}/`)) {
				modelWroteMemory = true;
			}
		} catch {
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
		}
	});

	pi.on("turn_end", (event, ctx: ExtensionContext) => {
		try {
			if (gate.state.yielded || !state.enabled) return;
			if (isDirectiveTurn()) return;

			turnsSinceReview++;
			toolCallsSinceReview += countToolCalls((event as { message?: unknown }).message);

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
					.catch(() => { })
					.finally(() => {
						correctionInFlight = false;
					});
			} else {
				turnsSinceCorrection++;
			}

		} catch {
		}
	});

	const stageUnextractedTail = (ctx: ExtensionContext, label: string): number => {
		if (gate.state.yielded || !state.enabled) return 0;
		if (userTurnCount < 3) return 0;
		const allParts = allConversationParts(ctx);
		const unextracted = reviewCursorParts > allParts.length ? allParts : allParts.slice(reviewCursorParts);
		const parts = clampQueueParts(unextracted);
		if (parts.length === 0) return 0;
		const d = dirs(ctx);
		writeQueueRecord(d.agentDir, {
			v: QUEUE_V,
			sessionId: sessionIdOf(ctx),
			projectsDir: d.projectsDir,
			projectKey: projectKeyForDir(d.project),
			cwd: ctx.cwd ?? process.cwd(),
			savedAt: Date.now(),
			attempts: 0,
			parts,
		});
		state.flushes++;
		state.lastFlush = `${label}: ${parts.length} part(s)`;
		return parts.length;
	};

	pi.on("agent_end", (_event, ctx: ExtensionContext) => {
		try {
			if (gate.state.yielded || !state.enabled) return;
			const reviewDue = turnsSinceReview >= REVIEW_TURNS || toolCallsSinceReview >= REVIEW_TOOL_CALLS;
			if (!reviewDue || userTurnCount < 3 || reviewInFlight || sessionAbort.signal.aborted) return;
			if (modelWroteMemory) {
				modelWroteMemory = false;
				reviewCursorParts = allConversationParts(ctx).length;
				state.reviews++;
				state.lastReview = "skipped — model wrote memory this window";
				return;
			}
			const allParts = allConversationParts(ctx);
			const from = Math.max(reviewCursorParts, allParts.length - REVIEW_MAX_PARTS);
			const parts = reviewCursorParts > allParts.length ? [] : allParts.slice(from);
			if (parts.length === 0) {
				turnsSinceReview = 0;
				toolCallsSinceReview = 0;
				return;
			}
			turnsSinceReview = 0;
			toolCallsSinceReview = 0;
			reviewInFlight = true;
			reviewCursorParts = Math.max(reviewCursorParts, allParts.length);
			void runOps("review", ctx, REVIEW_SYSTEM, parts)
				.then((applied) => {
					state.reviews++;
					state.lastReview = applied > 0 ? `saved ${applied} op(s)` : "nothing durable";
					if (applied > 0) notify(ctx, `💾 memory auto-reviewed (${applied} op${applied === 1 ? "" : "s"})`);
				})
				.catch(() => { })
				.finally(() => {
					reviewInFlight = false;
				});
		} catch {
		}
	});

	const stageForCompaction = (ctx: ExtensionContext, label: string): void => {
		try {
			stageUnextractedTail(ctx, label);
		} catch (err) {
			state.lastError = `${label}: ${err instanceof Error ? err.message : String(err)}`;
		}
	};

	pi.on("session_before_compact", (event, ctx: ExtensionContext) => {
		const signal = (event as { signal?: AbortSignal }).signal;
		if (signal?.aborted) return;
		stageForCompaction(ctx, "compact-queued");
	});

	let seamCtx: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		seamCtx = ctx;
	});

	unregisterMemorySeam?.();
	unregisterMemorySeam = registerCompactionSubscriber({
		before: () => {
			if (seamCtx) stageForCompaction(seamCtx, "boundary-draft");
		},
	});

	// The host reuses the factory's closures across /new,/resume,/fork;
	// without the reset a dead AbortController would silently kill all
	// automation after the first in-process session switch.
	pi.on("session_start", () => {
		try {
			pendingCorrection = undefined;
			turnsSinceCorrection = 3;
			correctionInFlight = false;
			turnsSinceReview = 0;
			toolCallsSinceReview = 0;
			userTurnCount = 0;
			reviewInFlight = false;
			reviewCursorParts = 0;
			modelWroteMemory = false;
			drainBlacklist.clear();
			if (!sessionAbort.signal.aborted) sessionAbort.abort();
			sessionAbort = new AbortController();
		} catch {
		}
	});

	const drainPending = (ctx: ExtensionContext): void => {
		try {
			if (gate.state.yielded || !state.enabled) return;
			const d = dirs(ctx);
			const cap: DrainCap = {
				d,
				model: sideChannelModel(ctx),
				registry: ctx.modelRegistry as never,
				projectKey: projectKeyForDir(d.project),
				complete: deps.complete as LlmComplete | undefined,
			};
			drainPendingRecords(cap).catch((err) => {
				state.lastError = `session-start drain: ${err instanceof Error ? err.message : String(err)}`;
			});
		} catch {
		}
	};

	const drainPorts = (): QueueDrainPorts => ({
		complete: async (cap, parts) => {
			const completion = await completeMemoryOpsCapped(
				cap.model,
				cap.registry,
				{
					systemPrompt: FLUSH_SYSTEM + routingGuidance(cap.projectKey),
					userPrompt: buildOpsUserPrompt({ project: cap.d.project }, clampQueueParts(parts)),
					timeoutMs: FLUSH_QUEUE_MS,
				},
				{ complete: cap.complete },
			);
			state.descRewritten = (state.descRewritten ?? 0) + (completion.rewritten ?? 0);
			return completion;
		},
		blacklistHas: (key) => drainBlacklist.has(key),
		blacklistAdd: (key) => drainBlacklist.add(key),
	});

	async function drainPendingRecords(cap: DrainCap): Promise<void> {
		const result = await drainQueue(cap, drainPorts());
		for (const msg of result.drops) state.lastError = msg;
		for (const summary of result.summaries) {
			if (summary.applied > 0) {
				state.opsApplied += summary.applied;
				state.flushes++;
				state.lastFlush = summary.lastFlush;
			}
			if (summary.lastError) state.lastError = summary.lastError;
		}
	}

	// The host awaits shutdown handlers serially with no timeout, and a
	// real call on the session model measurably stalls every long-session
	// exit for the full 10s budget.
	pi.on("session_shutdown", (event, ctx: ExtensionContext) => {
		try {
			const reason = (event as { reason?: string }).reason;
			if (reason !== "reload") stageUnextractedTail(ctx, "queued");
		} catch {
		} finally {
			sessionAbort.abort();
		}
	});

	return { drainPending };
}

function sessionIdOf(ctx: ExtensionContext): string {
	return readSessionId(ctx.sessionManager) ?? "unknown";
}
