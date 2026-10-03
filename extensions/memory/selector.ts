/**
 * memory/selector.ts — the LLM manifest judge for recall v2
 * (spec 2026-10-02-memory-recall-v2, RV-12/13, D3/D6).
 *
 * A TRUE external seam: the machine (recall.ts) only ever talks to the
 * Selector interface, so tests substitute a fake and the real llmSelector
 * stays unexercised except in its own suite. The selector reads ONE
 * manifest (key + age + description per candidate, newest first), knows
 * the recently-used tool list, and answers with keys — it never sees file
 * bodies (bodies are the machine's business, so prompt size stays flat in
 * corpus size).
 *
 * Model policy (D3): the wiring resolves `memory.recallModel` BEFORE the
 * machine runs; no model = no recall at all. Resolution is exact
 * `provider/id` first, then a unique bare id — ambiguity and misses both
 * mean "off", never a fallback to the session model (a fallback would
 * silently spend the user's main-model budget on recall).
 *
 * Prompt wording is written for this repo (mechanism-aligned with the CC
 * selector study, no proprietary text). Timeout discipline rides the
 * shared llm.ts lane (completeText).
 */

import type { Api, Model } from "@earendil-works/pi-ai";

import { RECALL_MANIFEST_MAX } from "../../lib/context-budget.ts";
import { completeText, resolveModelRef, type LlmComplete, type RegistryLike } from "./llm.ts";

/** Selector-side hard timeout — longer than any configured waitMs so a
 * deferred (timed-out) selection can still land before run end. */
export const RECALL_SELECT_TIMEOUT_MS = 20_000;

export interface SelectionCandidate {
	/** Canonical block key: `user-memory/<file>` | `memory/<file>`. */
	key: string;
	file: string;
	title: string;
	description: string;
	type: string;
	layer: "user" | "project";
	mtimeMs: number;
	/** Absolute path on disk (truncation notes point here). */
	absPath: string;
}

export interface SelectorRequest {
	query: string;
	candidates: readonly SelectionCandidate[];
	recentTools: readonly string[];
	signal?: AbortSignal;
}

export type SelectorOutcome =
	| { kind: "selected"; keys: string[]; elapsedMs: number }
	| { kind: "empty"; elapsedMs: number }
	| { kind: "failure"; reason: string; elapsedMs: number };

export interface Selector {
	select(req: SelectorRequest): Promise<SelectorOutcome>;
}

/** Resolve `memory.recallModel` per D3: exact provider/id, then unique
 * bare id; undefined/ambiguous/missing → undefined (recall OFF).
 * Delegates to the single authority in llm.ts (spec 2026-10-03). */
export function resolveRecallModel(
	ref: string | undefined,
	registry: { getAll?: () => unknown[] } | undefined,
): Model<Api> | undefined {
	return resolveModelRef(ref, registry);
}

/** One manifest row (RV-12): `- [layer][type] key (age): description`. */
export function manifestRow(c: SelectionCandidate, now = Date.now()): string {
	const ageDays = Math.floor((now - c.mtimeMs) / 86_400_000);
	const age = ageDays < 1 ? "new" : `${ageDays}d`;
	return `- [${c.layer}][${c.type}] ${c.key} (${age}): ${c.description}`;
}

/** Selector system prompt — precision-first posture, empty list is a good
 * answer (D6), recentTools anti-noise rule (RV-13). */
export const SELECT_SYSTEM = `You are choosing which memory files to surface for a coding assistant's next turn. You will see the user's message and a manifest of memory files. Each manifest row has a key, an age, and a one-line description.

Reply with only a JSON object: {"selected": ["<key>", ...]}

Rules:
- List ONLY files that will clearly help the assistant with THIS message. Judge by the description; do not guess at contents.
- Be selective and discerning: if you are unsure a memory will help, leave it out.
- An empty list is a good answer when nothing clearly applies.
- At most 5 keys, each copied verbatim from the manifest.
- If a "Recently used tools" list is given, do not select usage-reference or API-documentation memories for those tools (the assistant is already exercising them) — but DO select memories warning about their gotchas or known issues.`;

/** Parse the selector's reply into known keys; null = unparsable. */
export function parseSelection(text: string, valid: ReadonlySet<string>): string[] | null {
	const trimmed = text.trim();
	const attempts: string[] = [];
	for (const m of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) attempts.push(m[1]!.trim());
	attempts.push(trimmed);
	// first balanced {...} span as the last resort
	const start = trimmed.indexOf("{");
	if (start >= 0) {
		let depth = 0;
		for (let i = start; i < trimmed.length; i++) {
			if (trimmed[i] === "{") depth++;
			else if (trimmed[i] === "}") {
				depth--;
				if (depth === 0) {
					attempts.push(trimmed.slice(start, i + 1));
					break;
				}
			}
		}
	}
	for (const attempt of attempts) {
		try {
			const parsed: unknown = JSON.parse(attempt);
			if (typeof parsed !== "object" || parsed === null) continue;
			const selected = (parsed as { selected?: unknown }).selected;
			if (!Array.isArray(selected)) continue;
			const out: string[] = [];
			for (const key of selected) {
				if (typeof key === "string" && valid.has(key) && !out.includes(key)) out.push(key);
			}
			return out;
		} catch {
			/* keep scanning */
		}
	}
	return null;
}

/** Build the real selector over the shared side-channel lane. */
export function llmSelector(deps: {
	model: () => Model<Api> | undefined;
	registry: () => RegistryLike | undefined;
	complete?: LlmComplete;
}): Selector {
	return {
		async select(req) {
			const started = Date.now();
			if (req.candidates.length === 0) return { kind: "empty", elapsedMs: 0 };
			const model = deps.model();
			const registry = deps.registry();
			if (!model || !registry) return { kind: "failure", reason: "no_model", elapsedMs: Date.now() - started };

			const rows = req.candidates
				.slice()
				.sort((a, b) => b.mtimeMs - a.mtimeMs)
				.slice(0, RECALL_MANIFEST_MAX)
				.map((c) => manifestRow(c))
				.join("\n");
			const tools = req.recentTools.length > 0 ? `\n\nRecently used tools: ${req.recentTools.join(", ")}` : "";
			const done = await completeText(
				model,
				registry,
				{
					systemPrompt: SELECT_SYSTEM,
					userPrompt: `User message:\n${req.query}\n\nMemory manifest:\n${rows}${tools}`,
					timeoutMs: RECALL_SELECT_TIMEOUT_MS,
					signal: req.signal,
				},
				{ complete: deps.complete },
			);
			const elapsedMs = Date.now() - started;
			if (!done.ok) return { kind: "failure", reason: done.reason ?? "error", elapsedMs };
			const keys = parseSelection(done.text, new Set(req.candidates.map((c) => c.key)));
			if (keys === null) return { kind: "failure", reason: "parse_error", elapsedMs };
			if (keys.length === 0) return { kind: "empty", elapsedMs };
			return { kind: "selected", keys, elapsedMs };
		},
	};
}
