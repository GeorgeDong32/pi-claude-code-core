/*
 * Smart Compaction boundary-draft host contracts (SPEC SC §4.1 H3/H4/H5/H15,
 * §4.3 S1, §4.4 BLK-2 baselines; contract rows SC-HOST-02/03/10).
 *
 * All scenarios drive a REAL AgentSession with a faux provider through the
 * H16 scaffold (support/compaction-host.ts). W0 deliverable per spec §6:
 * the baselines pin host behaviour as it IS — green now; the protected
 * assertions live in compaction-protection.test.ts as expected-failures
 * until W3/W4 land.
 *
 * Recorded deviations vs the §4.4 smoke table (backfilled into the spec):
 * the first extension-visible event after a RUN-END draft commit is
 * `agent_end` (then agent_before_settle, agent_settled), not agent_settled
 * alone — the one-off smoke probe did not subscribe to agent_end. The §5.2
 * default reconcile trigger set already contains agent_end, so no spec
 * requirement changes; both observations are within the set.
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	SessionManager,
	type CompactionEntry,
} from "@earendil-works/pi-coding-agent";
import { compactionDraft, contextCapturingResponse, createCompactionHost } from "./support/compaction-host.ts";

function branchCompactions(sm: SessionManager): CompactionEntry[] {
	return sm.getBranch().filter((e) => e.type === "compaction") as CompactionEntry[];
}

describe("SC-HOST-02 boundary draft commit (H3/H4, S1①②④⑦)", () => {
	it("run-end turn_end draft: compaction entry lands (fromHook), projection rebuilt, no pi compaction events", async () => {
		const host = await createCompactionHost({
			probe: { turnEndDraft: (event) => [compactionDraft("SUMMARY run-end", event.messageEntryId)] },
		});
		try {
			host.faux.setResponses([fauxAssistantMessage("a plain answer")]);
			await host.session.prompt("first user message");
			const compactions = branchCompactions(host.sessionManager);
			expect(compactions.length).toBe(1);
			expect(compactions[0].fromHook).toBe(true);
			expect(compactions[0].summary).toBe("SUMMARY run-end");
			// tokensBefore is RE-ESTIMATED by the host from the projection (H3),
			// not taken from the draft (which carries none).
			expect(typeof compactions[0].tokensBefore).toBe("number");
			expect(compactions[0].tokensBefore).toBeGreaterThan(0);
			// Draft path does NOT fire the pi compaction events (H3, S1④).
			expect(host.events.map((e) => e.name)).not.toContain("session_before_compact");
			expect(host.events.map((e) => e.name)).not.toContain("session_compact");
			// Only one provider call: the draft path performs no summary LLM call.
			expect(host.faux.state.callCount).toBe(1);
			// Projection: system + compactionSummary + kept tail (S1①).
			const roles = host.sessionManager.buildSessionProjection().messages.map((m) => m.role);
			expect(roles).toEqual(["system", "compactionSummary", "assistant"]);
			// S1⑦: first extension-visible event after the draft turn_end is
			// agent_end (deviation note in the file header).
			const names = host.events.map((e) => e.name);
			const turnEndIndex = names.lastIndexOf("turn_end");
			expect(names.slice(turnEndIndex + 1)).toEqual(["agent_end", "agent_before_settle", "agent_settled"]);
		} finally {
			host.cleanup();
		}
	});

	it("mid-run tool-turn draft: next provider request in the SAME run uses the shrunk projection (H4, S1②⑦)", async () => {
		const host = await createCompactionHost({
			probe: {
				registerTestTool: true,
				// Draft only on the toolUse turn — one compaction per run.
				turnEndDraft: (event) =>
					event.message?.stopReason === "toolUse" ? [compactionDraft("SUMMARY mid-run", event.messageEntryId)] : undefined,
			},
		});
		try {
			host.faux.setResponses([
				contextCapturingResponse(
					host,
					fauxAssistantMessage(
						[{ type: "toolCall", id: "tc1", name: "sc_probe_tool", arguments: { value: "x" } }],
						{ stopReason: "toolUse" },
					),
				),
				contextCapturingResponse(host, fauxAssistantMessage("done after tools")),
			]);
			await host.session.prompt("run the probe tool");
			expect(branchCompactions(host.sessionManager).length).toBe(1);
			expect(host.requestContexts.length).toBe(2);
			const second = host.requestContexts[1];
			// system, user(=summary), assistant(toolUse), toolResult — the same
			// 4-message shape the §4.4 smoke observed; tool call/result pair intact.
			expect(second.roles).toEqual(["system", "user", "assistant", "toolResult"]);
			expect(second.texts[1]).toContain("SUMMARY mid-run");
			// S1⑦ mid-run: first visible event after the draft turn_end is turn_start.
			const names = host.events.map((e) => e.name);
			const firstTurnEnd = names.indexOf("turn_end");
			expect(names[firstTurnEnd + 1]).toBe("turn_start");
			// Draft path fired no pi compaction events here either.
			expect(names).not.toContain("session_compact");
		} finally {
			host.cleanup();
		}
	});

	it("queued steer survives a mid-run draft commit (S1⑤)", async () => {
		const host = await createCompactionHost({
			probe: {
				registerTestTool: true,
				turnEndDraft: (event) => {
					if (event.message?.stopReason !== "toolUse") return undefined;
					void host.session.steer("steered direction");
					return [compactionDraft("SUMMARY steer", event.messageEntryId)];
				},
			},
		});
		try {
			host.faux.setResponses([
				fauxAssistantMessage([{ type: "toolCall", id: "tc1", name: "sc_probe_tool", arguments: { value: "x" } }], { stopReason: "toolUse" }),
				contextCapturingResponse(host, fauxAssistantMessage("final answer")),
			]);
			await host.session.prompt("run the probe tool");
			// The steer landed on the branch as a user message after the toolResult.
			const roles = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "message")
				.map((e) => (e as { message: { role: string } }).message.role);
			// The branch opens with pi's system entry, then the run's messages.
			expect(roles).toEqual(["system", "user", "assistant", "toolResult", "user", "assistant"]);
			// And it reached the provider in the post-compaction request.
			expect(host.requestContexts[0].texts).toContain("steered direction");
		} finally {
			host.cleanup();
		}
	});

	it("resume-equivalent: a fresh SessionManager seeded with the branch projects the compaction correctly (S1⑥)", async () => {
		const host = await createCompactionHost({
			probe: { turnEndDraft: (event) => [compactionDraft("SUMMARY resume", event.messageEntryId)] },
		});
		try {
			host.faux.setResponses([fauxAssistantMessage("answer one")]);
			await host.session.prompt("user turn one");
			const branch = host.sessionManager.getBranch();
			// A NEW manager seeded with the same entries is what /resume replays
			// through; the full PTY /resume remains a W9 real-host item.
			const resumed = SessionManager.inMemory(host.cwd, undefined, branch as never);
			const projection = buildSessionProjection(resumed.getBranch());
			expect(projection.messages.map((m) => m.role)).toEqual(["system", "compactionSummary", "assistant"]);
			expect(branchCompactions(resumed).length).toBe(1);
		} finally {
			host.cleanup();
		}
	});

	it("agent_before_settle draft lands the same way, and a queued followUp survives it (S1 variant + S1⑤)", async () => {
		let settled = false;
		const host = await createCompactionHost({
			probe: {
				beforeSettleDraft: (event) => {
					// Queue a follow-up right before proposing the settle draft —
					// it must survive the compaction (delivered as the settle
					// continuation and/or its own user entry; the exact
					// interleaving is pi queue mechanics, not this contract).
					if (settled) return undefined;
					settled = true;
					void host.session.followUp("follow up after settle");
					return [compactionDraft("SUMMARY settle", event.messageEntryId ?? "seed-kept")];
				},
			},
		});
		try {
			host.faux.setResponses([
				fauxAssistantMessage("plain stop turn"),
				fauxAssistantMessage("continuation answer"),
				fauxAssistantMessage("final answer"),
			]);
			await host.session.prompt("hello");
			const compactions = branchCompactions(host.sessionManager);
			expect(compactions.length).toBe(1);
			expect(compactions[0].fromHook).toBe(true);
			expect(compactions[0].summary).toBe("SUMMARY settle");
			expect(host.events.map((e) => e.name)).not.toContain("session_compact");
			// S1⑤: the followUp content survived the settle-boundary compaction —
			// it is on the branch AFTER the compaction entry…
			const branch = host.sessionManager.getBranch();
			const compactionIndex = branch.findIndex((e) => e.type === "compaction");
			const followUpEntry = branch
				.slice(compactionIndex + 1)
				.find((e) => (e as { message?: { role: string; content?: Array<{ text?: string }> } }).message?.role === "user");
			expect(followUpEntry).toBeDefined();
			const followUpText = ((followUpEntry as { message: { content: Array<{ text?: string }> } }).message.content ?? [])
				.map((b) => b.text ?? "")
				.join("");
			expect(followUpText).toContain("follow up after settle");
			// …and no turn ended in a script-exhausted provider error.
			const stops = host.events.filter((e) => e.name === "turn_end").map((e) => e.stopReason);
			expect(stops).not.toContain("error");
		} finally {
			host.cleanup();
		}
	});
});

describe("SC-HOST-03 emitBoundary entries replacement semantics (H5, BLK-2 baselines)", () => {
	it("BLK-2(a) baseline: a LATER turn_end handler returning entries:[] silently drops our draft", async () => {
		const host = await createCompactionHost({
			probe: {
				turnEndDraft: () => [compactionDraft("SUMMARY ours", "whatever")],
				extraTurnEndHandlers: [() => ({ entries: [] })],
			},
		});
		try {
			host.faux.setResponses([fauxAssistantMessage("answer")]);
			await host.session.prompt("hello");
			// Last-returner-wins: the override handler ran after ours and
			// replaced the entries — nothing committed, and NO event tells us.
			expect(branchCompactions(host.sessionManager).length).toBe(0);
			const names = host.events.map((e) => e.name);
			expect(names).not.toContain("session_compact");
			expect(names).not.toContain("session_before_compact");
		} finally {
			host.cleanup();
		}
	});

	it("BLK-2(b) baseline: a LATER handler appending context_edit targeting the compressed-away region has no projection effect (H15, SC-HOST-10)", async () => {
		const host = await createCompactionHost({
			probe: {
				// Keep only the LAST assistant; the first user turn is compressed away.
				turnEndDraft: (event) => [compactionDraft("SUMMARY with edit conflict", event.messageEntryId)],
				extraTurnEndHandlers: [
					(event) => ({
						entries: [
							...(event.entries ?? []),
							{ type: "context_edit", targetId: firstUserEntryId(host), replacement: null },
						],
					}),
				],
			},
		});
		try {
			host.faux.setResponses([fauxAssistantMessage("answer one")]);
			await host.session.prompt("user turn one");
			// Compaction committed; the context_edit entry exists on the branch.
			expect(branchCompactions(host.sessionManager).length).toBe(1);
			const editEntries = host.sessionManager.getBranch().filter((e) => e.type === "context_edit");
			expect(editEntries.length).toBe(1);
			// But the edit targeted a pre-cut entry: the projection still shows
			// the compaction summary and the kept tail — nothing resurrected.
			const projection = host.sessionManager.buildSessionProjection();
			expect(projection.messages.map((m) => m.role)).toEqual(["system", "compactionSummary", "assistant"]);
			// The pre-cut user text does NOT reappear anywhere in the projection.
			const texts = projection.messages
				.map((m) => {
					const message = m as { content?: Array<{ text?: string }> | string };
					return Array.isArray(message.content)
						? message.content.map((b) => String(b.text ?? "")).join("")
						: String(message.content ?? "");
				})
				.join("");
			expect(texts).not.toContain("user turn one");
		} finally {
			host.cleanup();
		}
	});
});

/** Entry id of the FIRST user message on the branch (a compressed-away target). */
function firstUserEntryId(host: { sessionManager: SessionManager }): string {
	const entry = host.sessionManager
		.getBranch()
		.find((e) => e.type === "message" && (e as { message: { role: string } }).message.role === "user");
	if (!entry) throw new Error("no user entry on branch");
	return entry.id;
}

// ── SC-HOST-02/10 type-level half: the host-internal commit/compaction
// events are NOT extension-visible. Compile-time pin (CB2-B6 style): the
// contracts tsc pass turns red if a future pi adds them to ExtensionAPI.on. ──
describe("SC-HOST-02/10 host events not exposed to extensions (H3)", () => {
	it("entry_appended / compaction_start / compaction_end are not assignable to ExtensionAPI.on event names", () => {
		// ExtensionEvent is the union of every extension-visible event shape;
		// its `type` field enumerates the on() event names.
		type EventTypeName = import("@earendil-works/pi-coding-agent").ExtensionEvent["type"];
		type HasEntryAppended = "entry_appended" extends EventTypeName ? true : false;
		type HasCompactionStart = "compaction_start" extends EventTypeName ? true : false;
		type HasCompactionEnd = "compaction_end" extends EventTypeName ? true : false;
		const pinEntryAppended: false = null as unknown as HasEntryAppended;
		const pinCompactionStart: false = null as unknown as HasCompactionStart;
		const pinCompactionEnd: false = null as unknown as HasCompactionEnd;
		void pinEntryAppended;
		void pinCompactionStart;
		void pinCompactionEnd;
	});
});
