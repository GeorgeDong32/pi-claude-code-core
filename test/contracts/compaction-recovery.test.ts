/*
 * Smart Compaction truncation-recovery host contracts (SPEC SC §4.1 H12,
 * §4.4 BLK-1; contract row SC-HOST-07).
 *
 * BLK-1 is the INV-11 cornerstone: proposing a draft at the turn_end of a
 * recoverable length-stop response SWALLOWS the host's compact-and-retry
 * recovery, because _checkCompaction treats the last assistant as
 * "older than the latest compaction" and skips. Both halves are pinned on
 * a REAL AgentSession + faux provider:
 *   baseline (no draft)  → recovery happens (green, host as it is);
 *   hazard   (with draft)→ recovery swallowed (green — this IS the hazard).
 * The protected counterpart (controller declines to propose at that
 * boundary; recovery preserved) is an expected-failure until W3/W4.
 *
 * Fixture note (spike finding, backfilled to spec §4.3): the conversation
 * must exceed keepRecentTokens or prepareCompaction returns undefined
 * BEFORE emitting anything — a silently-too-small fixture fails for a
 * different reason than the one under test.
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { compactionDraft, createCompactionHost } from "./support/compaction-host.ts";

const BIG = "x".repeat(16000);
const recoverySettings = { compaction: { enabled: true, reserveTokens: 16000, keepRecentTokens: 100 } };

describe("SC-HOST-07 truncation recovery vs boundary drafts (H12, BLK-1)", () => {
	it("BLK-1 baseline (no draft): recoverable length-stop triggers overflow compact-and-retry — 3 provider calls", async () => {
		const host = await createCompactionHost({
			settingsOverrides: recoverySettings,
			probe: {},
		});
		try {
			host.faux.setResponses([
				// usage.output (≈4K chars/4) < model.maxTokens (16384) → recoverable.
				fauxAssistantMessage(`${BIG} cut short`, { stopReason: "length" }),
				fauxAssistantMessage("## Summary\n- did things\n- more things"),
				fauxAssistantMessage("recovered answer"),
			]);
			await host.session.prompt("do something long");
			const before = host.events.find((e) => e.name === "session_before_compact");
			expect(before?.reason).toBe("overflow");
			expect(before?.willRetry).toBe(true);
			expect(host.events.find((e) => e.name === "session_compact")).toBeDefined();
			// Original call + summary + retry = 3 (§4.4 smoke).
			expect(host.faux.state.callCount).toBe(3);
			// H12: turn_end.outcome groups stopReason "length" as "completed".
			expect(host.events.filter((e) => e.name === "turn_end").every((e) => e.outcome === "completed")).toBe(true);
		} finally {
			host.cleanup();
		}
	});

	it("BLK-1 hazard (draft at the length turn_end): recovery is swallowed — 1 provider call, message stays truncated", async () => {
		const host = await createCompactionHost({
			settingsOverrides: recoverySettings,
			probe: {
				turnEndDraft: (event) =>
					event.message?.stopReason === "length" ? [compactionDraft("SUMMARY-HAZARD", event.messageEntryId)] : undefined,
			},
		});
		try {
			host.faux.setResponses([
				fauxAssistantMessage(`${BIG} cut short`, { stopReason: "length" }),
				fauxAssistantMessage("never used"),
			]);
			await host.session.prompt("do something long");
			// The draft compaction made the length-stop assistant "older than
			// the latest compaction": _checkCompaction returned false, no
			// overflow recovery, no retry.
			expect(host.events.map((e) => e.name)).not.toContain("session_before_compact");
			expect(host.events.map((e) => e.name)).not.toContain("session_compact");
			expect(host.faux.state.callCount).toBe(1);
			// The final assistant state on the branch is still the truncated one.
			const turns = host.events.filter((e) => e.name === "turn_end");
			expect(turns.length).toBe(1);
			expect(turns[0].stopReason).toBe("length");
			// …and our draft DID commit — the compaction exists.
			const compactions = host.sessionManager.getBranch().filter((e) => e.type === "compaction");
			expect(compactions.length).toBe(1);
		} finally {
			host.cleanup();
		}
	});

	it("agent_before_settle fires AFTER _checkCompaction (H12 ordering half)", async () => {
		const host = await createCompactionHost({
			settingsOverrides: recoverySettings,
			probe: {},
		});
		try {
			host.faux.setResponses([
				fauxAssistantMessage(`${BIG} cut short`, { stopReason: "length" }),
				fauxAssistantMessage("## Summary\n- ok"),
				fauxAssistantMessage("recovered answer"),
			]);
			await host.session.prompt("do something long");
			const names = host.events.map((e) => e.name);
			const lastBeforeSettle = names.lastIndexOf("agent_before_settle");
			// The FIRST run's overflow compaction happened before any
			// agent_before_settle of the same run.
			const firstRunSettle = names.indexOf("agent_before_settle");
			const compactIndex = names.indexOf("session_compact");
			expect(firstRunSettle).toBeGreaterThan(-1);
			expect(compactIndex).toBeGreaterThan(-1);
			expect(compactIndex).toBeLessThan(firstRunSettle);
			expect(lastBeforeSettle).toBeGreaterThan(compactIndex);
		} finally {
			host.cleanup();
		}
	});

	it("after a completed recovery, a subsequent boundary draft still commits (post-recovery viability, BLK-1 protection precondition)", async () => {
		let recovered = false;
		const host = await createCompactionHost({
			settingsOverrides: recoverySettings,
			probe: {
				// Propose only on the SECOND run's turn_end (after recovery).
				turnEndDraft: (event) => {
					if (event.message?.stopReason === "length") return undefined;
					if (recovered) return [compactionDraft("SUMMARY post-recovery", event.messageEntryId)];
					recovered = true;
					return undefined;
				},
			},
		});
		try {
			host.faux.setResponses([
				fauxAssistantMessage(`${BIG} cut short`, { stopReason: "length" }),
				fauxAssistantMessage("## Summary\n- ok"),
				fauxAssistantMessage("recovered answer"),
			]);
			await host.session.prompt("do something long");
			// …recovery finished; now a fresh run proposes a draft normally.
			host.faux.setResponses([fauxAssistantMessage("second run answer")]);
			await host.session.prompt("second run");
			const compactions = host.sessionManager.getBranch().filter((e) => e.type === "compaction");
			// 1 native (recovery) + 1 draft (second run).
			expect(compactions.length).toBe(2);
			expect((compactions[1] as { summary: string }).summary).toBe("SUMMARY post-recovery");
		} finally {
			host.cleanup();
		}
	});
});
