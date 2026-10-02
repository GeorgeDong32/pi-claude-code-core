/*
 * memory-llm-selector.test.ts — the real llmSelector over a fake CompleteText
 * (spec 2026-10-02-memory-recall-v2 §8 cases 12–15). Model resolution is
 * asserted directly (D3: no session-model fallback).
 */
import { describe, expect, it } from "vitest";

import type { Api, Model } from "@earendil-works/pi-ai";

import { RECALL_MANIFEST_MAX } from "../../lib/context-budget.ts";
import { llmSelector, manifestRow, parseSelection, resolveRecallModel, type SelectionCandidate } from "../../extensions/memory/selector.ts";
import type { LlmComplete } from "../../extensions/memory/llm.ts";

const NOW = Date.now();
const MODEL = { provider: "test", id: "sel-1" } as Model<Api>;

function candidate(key: string, mtimeMs = NOW): SelectionCandidate {
	return {
		key,
		file: key.split("/").pop()!,
		title: key.split("/").pop()!.replace(/\.md$/, ""),
		description: `description of ${key}`,
		type: "project",
		layer: key.startsWith("user-memory/") ? "user" : "project",
		mtimeMs,
		absPath: `/tmp/x/${key}`,
	};
}

function withComplete(complete: LlmComplete) {
	return llmSelector({ model: () => MODEL, registry: () => ({ getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) }) as never, complete });
}

describe("RV llmSelector (spec §8)", () => {
	it("12: manifest rows are ordered newest-first, capped at 200, carry layer/type/age; query and recentTools reach the prompt", async () => {
		const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
		const complete: LlmComplete = async (_model, request) => {
			const r = request as unknown as { systemPrompt: string; messages: Array<{ content: Array<{ type: string; text: string }> }> };
			calls.push({ systemPrompt: r.systemPrompt, userPrompt: r.messages[0]!.content[0]!.text });
			return { stopReason: "stop", content: [{ type: "text", text: '{"selected":[]}' }] } as never;
		};
		const candidates = [
			candidate("memory/old.md", NOW - 40 * 86_400_000),
			candidate("user-memory/new.md", NOW - 1000),
			...Array.from({ length: 250 }, (_, i) => candidate(`memory/f${i}.md`, NOW - 200 * 86_400_000 - i)),
		];
		const selector = withComplete(complete);
		const out = await selector.select({ query: "the user question", candidates, recentTools: ["bash", "edit"] });
		expect(out.kind).toBe("empty");
		const prompt = calls[0]!.userPrompt;
		const lines = prompt.split("\n").filter((l) => l.startsWith("- ["));
		expect(lines.length).toBe(RECALL_MANIFEST_MAX);
		expect(lines[0]).toContain("user-memory/new.md");
		expect(lines[0]).toContain("(new)");
		expect(lines[1]).toContain("(40d)");
		expect(prompt).toContain("the user question");
		expect(prompt).toContain("Recently used tools: bash, edit");
		expect(calls[0]!.systemPrompt).toContain("empty list");
		expect(manifestRow(candidate("user-memory/x.md", NOW - 3 * 86_400_000)).startsWith("- [user][project] user-memory/x.md (3d): ")).toBe(true);
	});

	it("13: parses pure JSON, fenced JSON and noise-surrounded JSON; unknown keys dropped; empty list legal", async () => {
		const valid = new Set(["memory/a.md", "memory/b.md"]);
		expect(parseSelection('{"selected":["memory/a.md"]}', valid)).toEqual(["memory/a.md"]);
		expect(parseSelection('```json\n{"selected": ["memory/b.md", "memory/ghost.md"]}\n```', valid)).toEqual(["memory/b.md"]);
		expect(parseSelection('Sure thing:\n{"selected": ["memory/a.md","memory/a.md"]} done', valid)).toEqual(["memory/a.md"]);
		expect(parseSelection('{"selected":[]}', valid)).toEqual([]);
		expect(parseSelection("total garbage", valid)).toBeNull();
	});

	it("14: provider error / parse failure surface as failure outcomes (empty answers stay empty)", async () => {
		const failing: LlmComplete = async () => ({ stopReason: "error", errorMessage: "boom" }) as never;
		const out1 = await withComplete(failing).select({ query: "q text here", candidates: [candidate("memory/a.md")], recentTools: [] });
		expect(out1.kind).toBe("failure");

		const garbage: LlmComplete = async () => ({ stopReason: "stop", content: [{ type: "text", text: "not json at all" }] }) as never;
		const out2 = await withComplete(garbage).select({ query: "q text here", candidates: [candidate("memory/a.md")], recentTools: [] });
		expect(out2.kind).toBe("failure");
		if (out2.kind === "failure") expect(out2.reason).toBe("parse_error");

		const noAuth = llmSelector({ model: () => MODEL, registry: () => ({ getApiKeyAndHeaders: async () => ({ ok: false, error: "nope" }) }) as never });
		const out3 = await noAuth.select({ query: "q text here", candidates: [candidate("memory/a.md")], recentTools: [] });
		expect(out3.kind).toBe("failure");
		if (out3.kind === "failure") expect(out3.reason).toBe("no_auth");
	});

	it("15: model resolution — exact provider/id, unique bare id, ambiguous/missing undefined, never the session model", () => {
		const models = [
			{ provider: "test", id: "sel-1" },
			{ provider: "other", id: "sel-1" }, // ambiguous bare id
			{ provider: "test", id: "main" },
		] as unknown as Model<Api>[];
		const registry = { getAll: () => models };
		expect(resolveRecallModel("test/sel-1", registry)).toBe(models[0]);
		expect(resolveRecallModel("test/main", registry)).toBe(models[2]);
		expect(resolveRecallModel("sel-1", registry)).toBeUndefined(); // two hits → ambiguous
		expect(resolveRecallModel("nope/x", registry)).toBeUndefined();
		expect(resolveRecallModel(undefined, registry)).toBeUndefined();
		expect(resolveRecallModel("test/sel-1", undefined)).toBeUndefined();
	});
});
