import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/recall-aggregate.mjs", import.meta.url));

function synthSession(userTurns: number, blockEvery: number): string {
	const lines: string[] = [];
	for (let i = 0; i < userTurns; i++) {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: `user message ${i}`, timestamp: i + 1 } }));
		if (i > 0 && i % blockEvery === 0) {
			lines.push(
				JSON.stringify({
					type: "message",
					message: {
						role: "custom",
						customType: "pi-memory-recall",
						content: [{ type: "text", text: "block" }],
						timestamp: i + 1.5,
						details: { v: 1, delivery: "immediate", model: "CPA/model-fast", files: ["memory/a.md"], bytes: 1024, elapsedMs: 3000 },
					},
				}),
			);
		}
	}
	return lines.join("\n") + "\n";
}

describe("recall-aggregate smoke over sparse deliveries (B spec §5 row 8)", () => {
	it("parses a sparse-delivery session (pre-B dense shape vs post-B sparse shape) with unchanged output shape", () => {
		const dir = mkdtempSync(join(tmpdir(), "rc-agg-smoke-"));
		try {
			const sessionDir = join(dir, "2026-10-20T00-00-00-000Z_smoke");
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(join(sessionDir, "session.jsonl"), synthSession(30, 5));
			const result = spawnSync("node", [script, dir], { encoding: "utf8" });
			expect(result.status).toBe(0);
			const out = result.stdout;
			expect(out).toContain("sessions scanned: 1 jsonl file(s)");
			expect(out).toContain("delivery: immediate");
			expect(out).toContain("selector elapsedMs:");
			expect(out).toContain("landing position");
			expect(out).toContain("waitMs recommendation");
			expect(out).toMatch(/immediate \d+ \/ deferred \d+/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still parses the pre-B dense shape (regression: block every turn)", () => {
		const dir = mkdtempSync(join(tmpdir(), "rc-agg-smoke-"));
		try {
			const sessionDir = join(dir, "2026-10-19T00-00-00-000Z_dense");
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(join(sessionDir, "session.jsonl"), synthSession(8, 1));
			const result = spawnSync("node", [script, dir], { encoding: "utf8" });
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("sessions scanned: 1 jsonl file(s)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
