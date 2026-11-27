import { describe, expect, it } from "vitest";

import type { Api, Model } from "@earendil-works/pi-ai";

import { completeText, type LlmComplete } from "../../extensions/memory/llm.ts";
import { renderMemoryDiagnostics } from "../../extensions/memory/diagnostics.ts";

const MODEL = { provider: "test", id: "m" } as Model<Api>;
const REGISTRY = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) } as never;

const hanging: LlmComplete = (_model, _request, opts) => {
	const signal = (opts as { signal?: AbortSignal }).signal;
	if (signal?.aborted) return Promise.reject(new Error("This operation was aborted"));
	return new Promise<never>((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
	});
};

describe("CH E7 llm timeout vs abort", () => {
	it("the internal timer reports `timeout`, not `aborted`", async () => {
		const out = await completeText(MODEL, REGISTRY, { systemPrompt: "s", userPrompt: "u", timeoutMs: 40 }, { complete: hanging });
		expect(out.ok).toBe(false);
		expect(out.reason).toBe("timeout");
	});

	it("an externally supplied abort still reports `aborted`", async () => {
		const external = new AbortController();
		const pending = completeText(MODEL, REGISTRY, { systemPrompt: "s", userPrompt: "u", signal: external.signal }, { complete: hanging });
		await new Promise((r) => setTimeout(r, 20));
		external.abort();
		const out = await pending;
		expect(out.ok).toBe(false);
		expect(out.reason).toBe("aborted");
	});

	it("/memory diagnostics surface the timeout reason verbatim", () => {
		const text = renderMemoryDiagnostics(minimalDiagnostics("timeout"));
		expect(text).toContain("(last: timeout)");
	});
});

function minimalDiagnostics(lastReason: string) {
	return {
		userDir: "/u",
		projectDir: "/p",
		userScan: { entries: [], skipped: 0 },
		projectScan: { entries: [], skipped: 0 },
		userIndexBytes: 0,
		projectIndexBytes: 0,
		automation: { enabled: false, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0 },
		consolidation: { lastReason: null },
		yielded: { yielded: false },
		hermesDataFound: false,
		misplaced: [],
		recall: {
			status: "on" as const,
			model: "test/m",
			waitMs: 4000,
			sessionFiles: 0,
			sessionBytes: 0,
			stats: { selections: 0, empties: 0, failures: 1, late: 0, lastReason, deliveries: 0 },
		},
		queue: null,
	};
}
