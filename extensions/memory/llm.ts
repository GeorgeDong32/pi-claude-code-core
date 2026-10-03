/**
 * memory/llm.ts — the side-channel completion lane (V2-A §4; model-ref
 * resolution + the queue-drain lane added by spec 2026-10-03-memory-exit-flush).
 *
 * ONE independent completeSimple() call per automation tick (review /
 * correction / flush / queue drain): invisible to the conversation, never
 * triggers an agent turn, never blocks a hook (callers fire-and-forget or
 * bound the wait). No subprocess fallback — a failed call is skipped silently
 * and the next hook retries (deliberate downgrade vs hermes, documented in
 * the V2 report). The shutdown path itself stages a queue record and runs
 * ZERO LLM here (queue.ts); this lane drains it at the next session_start.
 *
 * Response contract: strict JSON in the TEXT channel —
 *   an object whose "operations" field is an array of memory ops.
 * The prompts describe the schema in prose only (no parseable example — a
 * restated schema must never parse into live operations, hermes #235).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { MemoryOp } from "./store.ts";

export type LlmComplete = typeof completeSimple;

export type OpsFailure = "no_model" | "no_auth" | "aborted" | "parse_error" | "empty" | "provider_error" | "empty_response";

export interface OpsCompletion {
	ok: boolean;
	ops: MemoryOp[];
	reason?: OpsFailure;
	error?: string;
}

export interface CompletionRequest {
	systemPrompt: string;
	userPrompt: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export const OPS_TIMEOUT_MS = 60_000;

export type RegistryLike = {
	getApiKeyAndHeaders: (model: Model<Api>) => Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
		| { ok: false; error: string }
	>;
};

/** Single authority for model-ref resolution (spec 2026-10-03 — shared by
 * the recall selector's D3 gate and the ops side-channel chain, so a third
 * copy of the matching logic can never drift in): canonical "provider/id"
 * single exact match, then a unique bare-id match. Empty / ambiguous /
 * unmatched → undefined. */
export function resolveModelRef(
	ref: string | undefined,
	registry: { getAll?: () => unknown[] } | undefined,
): Model<Api> | undefined {
	const key = ref?.trim().toLowerCase();
	if (!key || !registry?.getAll) return undefined;
	const all = registry.getAll() as Model<Api>[];
	const canonical = all.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === key);
	if (canonical.length === 1) return canonical[0];
	const byId = all.filter((m) => m.id.toLowerCase() === key);
	if (byId.length === 1) return byId[0];
	return undefined;
}

const AUTH_REJECTION = /\b(401|403)\b|unauthorized|forbidden|invalid[\s_-]*api[\s_-]*key|(token|key|credential)[\s_-]*(is[\s_-]*)?(invalid|expired|revoked)/i;

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content as Array<{ type?: string; text?: string }>) {
		if (part && part.type === "text" && typeof part.text === "string") texts.push(part.text);
	}
	return texts.join("\n");
}

/** Raw-text side-channel outcome (RV: the recall selector rides the same
 * lane — same failure vocabulary as the ops engine). */
export interface TextCompletion {
	ok: boolean;
	text: string;
	reason?: OpsFailure;
	error?: string;
}

/** One side-channel completion returning raw TEXT (RV — extracted from
 * completeMemoryOps: same auth resolution, credential-rotation retry,
 * timeout and abort discipline; completeMemoryOps now delegates here so
 * both consumers cannot drift). */
export async function completeText(
	model: Model<Api> | undefined,
	registry: RegistryLike | undefined,
	request: CompletionRequest,
	deps: { complete?: LlmComplete } = {},
): Promise<TextCompletion> {
	const complete = deps.complete ?? completeSimple;
	if (!model || !registry?.getApiKeyAndHeaders) return { ok: false, text: "", reason: "no_model" };

	const auth = await registry.getApiKeyAndHeaders(model).catch(() => undefined);
	if (!auth || !auth.ok) return { ok: false, text: "", reason: "no_auth", error: auth && !auth.ok ? auth.error : "no auth" };
	const hasCredential = Boolean(auth.apiKey) || Object.entries(auth.headers ?? {}).some(([k, v]) => /^(authorization|x-api-key)$/i.test(k) && v);
	if (!hasCredential) return { ok: false, text: "", reason: "no_auth" };

	const controller = new AbortController();
	const timeoutMs = request.timeoutMs ?? OPS_TIMEOUT_MS;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onExternalAbort = () => controller.abort();
	request.signal?.addEventListener("abort", onExternalAbort, { once: true });
	if (request.signal?.aborted) controller.abort();

	let requestAuth = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
	try {
		const call = () =>
			complete(
				model,
				{
					systemPrompt: request.systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: request.userPrompt }], timestamp: Date.now() }],
				} as never,
				{ apiKey: requestAuth.apiKey, headers: requestAuth.headers, env: requestAuth.env, signal: controller.signal, reasoning: "off" } as never,
			);

		let response;
		try {
			response = await call();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!controller.signal.aborted && AUTH_REJECTION.test(message)) {
				// credentials may have rotated — re-resolve once, retry only if changed
				const rotated = await registry.getApiKeyAndHeaders(model).catch(() => undefined);
				if (rotated?.ok) {
					const next = { apiKey: rotated.apiKey, headers: rotated.headers, env: rotated.env };
					if (JSON.stringify(next) !== JSON.stringify(requestAuth)) {
						requestAuth = next;
						response = await call();
					}
				}
			}
			if (!response) throw err;
		}

		if (request.signal?.aborted || controller.signal.aborted) return { ok: false, text: "", reason: "aborted" };
		if (response.stopReason === "error") {
			return { ok: false, text: "", reason: "provider_error", error: response.errorMessage };
		}

		const text = textFromContent((response as { content?: unknown }).content).trim();
		if (!text) return { ok: false, text: "", reason: "empty_response" };
		return { ok: true, text };
	} catch (err) {
		if (controller.signal.aborted) return { ok: false, text: "", reason: "aborted" };
		return { ok: false, text: "", reason: "provider_error", error: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
		request.signal?.removeEventListener("abort", onExternalAbort);
	}
}

/** Run one side-channel completion and parse it into memory ops. */
export async function completeMemoryOps(
	model: Model<Api> | undefined,
	registry: RegistryLike | undefined,
	request: CompletionRequest,
	deps: { complete?: LlmComplete } = {},
): Promise<OpsCompletion> {
	const done = await completeText(model, registry, request, deps);
	if (!done.ok) return { ok: false, ops: [], reason: done.reason, error: done.error };
	const ops = parseOperations(done.text);
	if (ops === null) return { ok: false, ops: [], reason: "parse_error" };
	if (ops.length === 0) return { ok: true, ops: [], reason: "empty" };
	return { ok: true, ops };
}

// ─── strict-JSON extraction (no thinking-channel recovery) ───

/** String- and escape-aware balanced {...} spans, innermost-last usable. */
function balancedObjectSpans(text: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	const open: number[] = [];
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") open.push(i);
		else if (ch === "}") {
			const start = open.pop();
			if (start !== undefined) spans.push([start, i]);
		}
	}
	return spans;
}

const VALID_ACTIONS = new Set(["add", "replace", "remove"]);
const VALID_LAYERS = new Set(["user", "project"]);

/** Normalize one raw item into a MemoryOp; null when malformed. */
function normalizeOp(raw: unknown): MemoryOp | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const action = r.action;
	const layer = r.layer ?? r.target; // hermes-style "target" tolerated on import
	if (typeof action !== "string" || !VALID_ACTIONS.has(action)) return null;
	if (typeof layer !== "string" || !VALID_LAYERS.has(layer)) return null;
	const op: MemoryOp = { action: action as MemoryOp["action"], layer: layer as MemoryOp["layer"] };
	for (const key of ["file", "name", "description", "type", "body", "old_text"] as const) {
		const v = r[key];
		if (typeof v === "string" && v.length > 0) op[key] = v;
	}
	return op;
}

/** Parse model text into ops. null = unparsable (parse_error); [] = parsed,
 * nothing to do (a normal outcome, not an error). */
export function parseOperations(text: string): MemoryOp[] | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	// 1. fenced ```json blocks (last first — the answer trails any preamble)
	const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!.trim());
	for (let i = fences.length - 1; i >= 0; i--) {
		try {
			const parsed: unknown = JSON.parse(fences[i]!);
			const ops = opsFromPayload(parsed);
			if (ops !== null) return ops;
		} catch {
			/* keep scanning */
		}
	}
	// 2. whole-text parse
	try {
		const ops = opsFromPayload(JSON.parse(trimmed));
		if (ops !== null) return ops;
	} catch {
		/* fall through */
	}
	// 3. trailing balanced object containing an operations array
	for (const [start, end] of balancedObjectSpans(trimmed).reverse()) {
		try {
			const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
			const ops = opsFromPayload(parsed);
			if (ops !== null) return ops;
		} catch {
			/* keep scanning */
		}
	}
	return null;
}

function opsFromPayload(parsed: unknown): MemoryOp[] | null {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const operations = (parsed as { operations?: unknown }).operations;
	if (!Array.isArray(operations)) return null;
	const ops = operations.map(normalizeOp).filter((o): o is MemoryOp => o !== null);
	return ops;
}
