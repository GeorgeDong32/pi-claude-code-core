/**
 * recall-eval.ts — offline recall selector evaluation spike
 * (R2, spec 2026-10-02-memory-recall-v2; NOT in CI — run by hand).
 *
 * Reads an annotation file (path via argv, kept OUTSIDE the repo — it
 * contains private conversation text) of JSONL lines:
 *
 *   {"cwd": "/Users/gd32/Coding/CherryDev", "text": "<user message>", "expected": ["memory/a.md", "user-memory/b.md"]}
 *
 * For each line: resolve that project's two memory layers, build the real
 * candidate manifest (eligibleMemories), run the real llmSelector with the
 * configured model, and score against `expected`.
 *
 * Usage:
 *   bun test/spikes/recall-eval.ts /path/to/annotations.jsonl [--model provider/id]
 *
 * Model resolution: --model flag wins; else memory.recallModel from
 * ~/.pi/agent/settings.json. Credentials come from the provider's usual env
 * var (ANTHROPIC_API_KEY / OPENAI_API_KEY / …) — this spike runs outside pi,
 * so it builds a minimal registry instead of pi's auth store.
 *
 * Output: per-line verdicts + aggregate precision / recall / latency
 * p50·p90, and the empty-selection rate (the selector's no-op posture is a
 * feature — empty-on-no-relevant is CORRECT when expected is empty).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { eligibleMemories } from "../../extensions/memory/memdir.ts";
import { resolveMemoryPaths } from "../../extensions/memory/paths.ts";
import { llmSelector } from "../../extensions/memory/selector.ts";
import type { Model, Api } from "@earendil-works/pi-ai";

interface AnnotationLine {
	cwd: string;
	text: string;
	expected: string[];
}

const PROVIDER_ENV: Record<string, string[]> = {
	anthropic: ["ANTHROPIC_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

function envRegistry(): { getApiKeyAndHeaders: (model: Model<Api>) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }> } {
	return {
		async getApiKeyAndHeaders(model) {
			const names = PROVIDER_ENV[model.provider as string] ?? [`${String(model.provider).toUpperCase().replace(/-/g, "_")}_API_KEY`];
			for (const name of names) {
				const key = process.env[name];
				if (key) return { ok: true, apiKey: key };
			}
			return { ok: false, error: `no credential env for provider "${String(model.provider)}" (tried ${names.join(", ")})` };
		},
	};
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)]!;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const file = argv.find((a) => !a.startsWith("--"));
	const modelFlag = argv.find((a) => a.startsWith("--model="))?.slice("--model=".length);
	if (!file) {
		console.error("usage: bun test/spikes/recall-eval.ts <annotations.jsonl> [--model provider/id]");
		process.exit(1);
	}

	// model: --model > memory.recallModel > error
	let spec = modelFlag;
	if (!spec) {
		try {
			const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8")) as { memory?: { recallModel?: string } };
			spec = settings.memory?.recallModel;
		} catch {
			/* no settings */
		}
	}
	if (!spec || !spec.includes("/")) {
		console.error("no model: pass --model provider/id or set memory.recallModel in ~/.pi/agent/settings.json");
		process.exit(1);
	}
	const [provider, id] = spec.split("/") as [string, string];
	const model = { provider, id } as Model<Api>;

	const lines = readFileSync(file, "utf-8")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l): AnnotationLine => JSON.parse(l));
	console.log(`recall-eval: ${lines.length} annotation(s), model ${provider}/${id}\n`);

	const selector = llmSelector({ model: () => model, registry: () => envRegistry() });
	let selectedTotal = 0;
	let relevantTotal = 0;
	let hitTotal = 0;
	let emptyCorrect = 0;
	let emptyWrong = 0;
	const latencies: number[] = [];

	for (const [i, line] of lines.entries()) {
		const paths = resolveMemoryPaths(line.cwd, homedir());
		const candidates = eligibleMemories(paths.userMemoryDir, paths.memoryDir);
		const started = Date.now();
		const outcome = await selector.select({ query: line.text, candidates, recentTools: [] });
		const wall = Date.now() - started;
		latencies.push(outcome.kind === "failure" ? wall : outcome.elapsedMs);

		const picked = outcome.kind === "selected" ? outcome.keys : [];
		const expected = new Set(line.expected ?? []);
		const hits = picked.filter((k) => expected.has(k));
		selectedTotal += picked.length;
		relevantTotal += expected.size;
		hitTotal += hits.length;
		if (picked.length === 0) {
			if (expected.size === 0) emptyCorrect++;
			else emptyWrong++;
		}
		const marks = picked.map((k) => (expected.has(k) ? `✓${k}` : `✗${k}`)).join(" ");
		const missed = [...expected].filter((k) => !picked.includes(k));
		console.log(`[${String(i + 1).padStart(2)}] ${outcome.kind.padEnd(8)} ${wall}ms  ${marks || "(empty)"}${missed.length > 0 ? `  missed: ${missed.join(", ")}` : ""}`);
		if (outcome.kind === "failure") console.log(`     failure: ${outcome.reason}`);
	}

	const precision = selectedTotal > 0 ? hitTotal / selectedTotal : 1;
	const recall = relevantTotal > 0 ? hitTotal / relevantTotal : 1;
	const sorted = [...latencies].sort((a, b) => a - b);
	console.log(`\nprecision ${((precision) * 100).toFixed(0)}%  (${hitTotal}/${selectedTotal} selected were expected)`);
	console.log(`recall    ${(recall * 100).toFixed(0)}%  (${hitTotal}/${relevantTotal} expected were selected)`);
	console.log(`empty     ${emptyCorrect} correct / ${emptyWrong} missed-something`);
	console.log(`latency   p50 ${percentile(sorted, 50)}ms  p90 ${percentile(sorted, 90)}ms  (R2 target: p90 ≤ recallWaitMs default)`);
}

void main();
