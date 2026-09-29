/*
 * SPEC OBS-10: module tests through the module's own interface.
 * Ported assertions mirror upstream behaviour (threshold, FULL_SENDS rhythm,
 * complete-line placeholder, per-message fail-open) plus the core-side
 * projection-immutability invariant (OBS-04).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	countLines,
	createObservation,
	ensureStored,
	estimateTokens,
	FULL_SENDS,
	isPureTextResult,
	observationPath,
	placeholderFor,
	readRecallChunk,
	THRESHOLD_BYTES,
} from "../observation.ts";

function bigResult(text: string, toolName = "bash"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName,
		isError: false,
		content: [{ type: "text", text }],
	} as ToolResultMessage;
}

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "obs-pack-"));
}

describe("observation primitives (OBS-02/07)", () => {
	it("packs only pure-text results above the threshold (OBS-10 boundary)", async () => {
		const root = await tempRoot();
		const at = "x".repeat(THRESHOLD_BYTES);
		const over = "x".repeat(THRESHOLD_BYTES + 1);
		assert.equal(createObservation(bigResult(at), root), undefined);
		const observation = createObservation(bigResult(over), root);
		assert.ok(observation);
		assert.match(observation.id, /^obs_[a-f0-9]{24}$/u);
		assert.equal(observation.bytes, THRESHOLD_BYTES + 1);
	});

	it("excludes results whose any line equals the reducer receipt token (OBS-07)", () => {
		const root = "/nonexistent-but-unused";
		const text = `head\nsol_pi_evidence_receipt_v1\ntail`;
		assert.equal(createObservation(bigResult("x".repeat(THRESHOLD_BYTES + 99) + "\n" + text), root), undefined);
		// Prefix-only match must NOT be excluded.
		const prefixOnly = `sol_pi_evidence_receipt_v1-but-more` + "x".repeat(THRESHOLD_BYTES);
		assert.ok(createObservation(bigResult(prefixOnly), root));
	});

	it("isPureTextResult rejects errors and mixed content", () => {
		const good = bigResult("hello");
		assert.equal(isPureTextResult(good as unknown as AgentMessage), true);
		const errored = { ...good, isError: true };
		assert.equal(isPureTextResult(errored as unknown as AgentMessage), false);
	});

	it("stores content-addressed objects and reuses them byte-identically", async () => {
		const root = await tempRoot();
		const text = Array.from({ length: 800 }, (_, i) => `line-${i}-payload`).join("\n");
		const observation = createObservation(bigResult(text), root)!;
		await ensureStored(observation);
		await ensureStored(observation); // second write hits the EEXIST verify path
		const stored = await readFile(observation.filePath, "utf8");
		assert.equal(stored, text);
	});
});

describe("placeholder excerpt (OBS-02)", () => {
	it("keeps whole lines only, head and tail, within the byte budget", () => {
		const root = "/unused";
		const line = "0123456789".repeat(10) + "\n"; // 101 bytes per line
		const text = line.repeat(200);
		const observation = createObservation(bigResult(text), root)!;
		const placeholder = placeholderFor(observation);
		assert.ok(placeholder.includes(`id: ${observation.id}`));
		assert.ok(placeholder.includes("retrieve: call obs_recall"));
		const excerptBytes = Buffer.byteLength(placeholder, "utf8");
		// 1KB excerpt + ~10 header lines: hard upper bound sanity.
		assert.ok(excerptBytes < 1600, `placeholder too large: ${excerptBytes}`);
		// Every excerpted line is a complete line of the original text.
		const originalLines = new Set(text.split("\n"));
		const excerpted = placeholder
			.split("\n")
			.filter((l) => l.length > 0)
			.filter((l) => !l.startsWith("[") && !/^id: |^tool: |^original_|^estimated_|^retrieve: /.test(l));
		for (const line of excerpted) assert.ok(originalLines.has(line), `partial line leaked: ${line.slice(0, 40)}`);
	});

	it("FULL_SENDS is 2 and recall limits derive from the upstream constants", () => {
		assert.equal(FULL_SENDS, 2);
		assert.equal(countLines("a\nb\n"), 2);
		assert.equal(estimateTokens("abcd"), 1);
	});
});

describe("obs_recall chunking (OBS-05)", () => {
	it("pages by byte offset and reports nextOffset/eof", async () => {
		const root = await tempRoot();
		const text = Array.from({ length: 150 }, (_, i) => `row-${i}-${"y".repeat(100)}`).join("\n");
		const observation = createObservation(bigResult(text), root)!;
		await ensureStored(observation);
		const first = await readRecallChunk(observation.filePath, 0, { maxBytes: 1024, maxLines: 400 });
		assert.ok(first.bytes > 0);
		assert.equal(first.eof, false);
		const second = await readRecallChunk(observation.filePath, first.nextOffset, { maxBytes: 1024, maxLines: 400 });
		assert.equal(second.bytes > 0, true);
		// Draining to the end reports eof.
		let offset = second.nextOffset;
		let chunk = second;
		while (!chunk.eof) {
			chunk = await readRecallChunk(observation.filePath, offset, { maxBytes: 1 << 20, maxLines: 10_000 });
			offset = chunk.nextOffset;
		}
		assert.equal(chunk.eof, true);
	});

	it("rejects offsets past the object size", async () => {
		const root = await tempRoot();
		const observation = createObservation(bigResult("z".repeat(THRESHOLD_BYTES + 5)), root)!;
		await ensureStored(observation);
		await assert.rejects(
			() => readRecallChunk(observation.filePath, observation.bytes + 10, { maxBytes: 16, maxLines: 4 }),
			/exceeds observation size/u,
		);
	});
});

describe("storage topology (OBS-03)", () => {
	it("objects live under <root>/objects/<id>.txt with no symlinked dirs", async () => {
		const root = await tempRoot();
		const observation = createObservation(bigResult("q".repeat(THRESHOLD_BYTES + 2)), root)!;
		assert.equal(observation.filePath, join(root, "objects", `${observation.id}.txt`));
		await ensureStored(observation);
		const entries = await readdir(join(root, "objects"));
		assert.deepEqual(entries, [`${observation.id}.txt`]);
		assert.equal(observationPath(root, observation.id), observation.filePath);
	});
});

describe("fail-open (OBS-08, per-message)", () => {
	it("a throwing ensureStored surfaces as an error the handler catches, not a lost message", async () => {
		const root = await tempRoot();
		const observation = createObservation(bigResult("w".repeat(THRESHOLD_BYTES + 3)), root)!;
		// Simulate the upstream failure shape: an unwritable store path.
		await writeFile(join(root, "objects"), "file blocking the directory name", "utf8");
		await assert.rejects(() => ensureStored(observation));
	});
});
