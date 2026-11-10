/*
 * SC-MET-01 / INV-7: aggregate only the new display-only measurement rows.
 * Session files may contain private messages and truncated writes; neither
 * their content nor their paths may appear in the aggregate report.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectCompactionMetrics } from "../../scripts/compaction-metrics.mjs";
import { COMPACTION_METRICS_ENTRY_TYPE } from "../../extensions/compaction/metrics.ts";

describe("SC-MET-01 runtime metric collector", () => {
	it("streams only metrics, ignores message bodies/old ST-01/unknown versions, and dedupes input paths", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sc-metrics-"));
		try {
			const file = join(dir, "session.jsonl");
			const data = { v: 1, at: 100, event: "applied", proposalId: "p", tokens: 75, tn: 100 };
			writeFileSync(file, [
				JSON.stringify({ type: "message", message: { role: "user", content: "PRIVATE-MESSAGE" } }),
				JSON.stringify({ type: "custom", customType: "cc-core-compaction", data: { outcome: "applied" } }),
				JSON.stringify({ type: "custom", customType: COMPACTION_METRICS_ENTRY_TYPE, data }),
				JSON.stringify({ type: "custom", customType: COMPACTION_METRICS_ENTRY_TYPE, data: { ...data, v: 2 } }),
				"{PRIVATE-INCOMPLETE",
			].join("\n"));
			const report = await collectCompactionMetrics([dir, file, dir]);
			expect(report.filesRead).toBe(1);
			expect(report.earlyCommits).toBe(1);
			expect(report.malformedLines).toBe(1);
			expect(report.observedEarlyTakeoverRate).toBe(1);
			expect(report.counterfactualM1Available).toBe(false);
			expect(JSON.stringify(report)).not.toContain("PRIVATE");
			expect(JSON.stringify(report)).not.toContain(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
