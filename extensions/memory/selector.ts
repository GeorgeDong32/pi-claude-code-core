
import type { Api, Model } from "@earendil-works/pi-ai";

import { RECALL_MANIFEST_MAX, RECALL_MAX_FILES } from "../../lib/context-budget.ts";
import { liftJson } from "../../lib/json-lift.ts";
import { completeText, resolveModelRef, type LlmComplete, type RegistryLike } from "./llm.ts";
import { effectiveAgeMs } from "./memdir.ts";

export const RECALL_SELECT_TIMEOUT_MS = 20_000;

export interface SelectionCandidate {
	key: string;
	file: string;
	title: string;
	description: string;
	type: string;
	layer: "user" | "project";
	mtimeMs: number;
	absPath: string;
	body?: string;
}

export interface SelectorRequest {
	query: string;
	candidates: readonly SelectionCandidate[];
	recentTools: readonly string[];
	previousUserMessage?: string;
	signal?: AbortSignal;
}

export type SelectorOutcome =
	| { kind: "selected"; keys: string[]; elapsedMs: number }
	| { kind: "empty"; elapsedMs: number }
	| { kind: "failure"; reason: string; elapsedMs: number };

export interface Selector {
	select(req: SelectorRequest): Promise<SelectorOutcome>;
}

export function resolveRecallModel(
	ref: string | undefined,
	registry: { getAll?: () => unknown[] } | undefined,
): Model<Api> | undefined {
	return resolveModelRef(ref, registry);
}

export function manifestRow(c: SelectionCandidate, now = Date.now(), content?: string): string {
	const ageMs = content === undefined ? now - c.mtimeMs : effectiveAgeMs(content, c.mtimeMs, now);
	const ageDays = Math.floor(ageMs / 86_400_000);
	const age = ageDays < 1 ? "new" : `${ageDays}d`;
	return `- [${c.layer}][${c.type}] ${c.key} (${age}): ${c.description}`;
}

export const SELECT_SYSTEM = `You are choosing which memory files to surface for a coding assistant's next turn. You will see the user's message and a manifest of memory files. Each manifest row has a key, an age, and a one-line description.

Reply with only a JSON object: {"selected": ["<key>", ...]}

Rules:
- List ONLY files that will clearly help the assistant with THIS message. Judge by the description; do not guess at contents.
- Be selective and discerning: if you are unsure a memory will help, leave it out.
- An empty list is a good answer when nothing clearly applies.
- At most ${RECALL_MAX_FILES} keys, each copied verbatim from the manifest.
- If a "Recently used tools" list is given, do not select usage-reference or API-documentation memories for those tools (the assistant is already exercising them) — but DO select memories warning about their gotchas or known issues.`;

export function parseSelection(text: string, valid: ReadonlySet<string>): string[] | null {
	return liftJson(text, (value) => {
		if (typeof value !== "object" || value === null) return null;
		const selected = (value as { selected?: unknown }).selected;
		if (!Array.isArray(selected)) return null;
		const out: string[] = [];
		for (const key of selected) {
			if (typeof key === "string" && valid.has(key) && !out.includes(key)) out.push(key);
		}
		return out;
	});
}

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
				.map((c) => manifestRow(c, Date.now(), c.body))
				.join("\n");
			const tools = req.recentTools.length > 0 ? `\n\nRecently used tools: ${req.recentTools.join(", ")}` : "";
			const previous = req.previousUserMessage ? `Previous user message:\n${req.previousUserMessage}\n\n` : "";
			const done = await completeText(
				model,
				registry,
				{
					systemPrompt: SELECT_SYSTEM,
					userPrompt: `${previous}User message:\n${req.query}\n\nMemory manifest:\n${rows}${tools}`,
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
