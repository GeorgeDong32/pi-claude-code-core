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
			expect(typeof compactions[0].tokensBefore).toBe("number");
			expect(compactions[0].tokensBefore).toBeGreaterThan(0);
			// Draft path does NOT fire the pi compaction events (H3, S1④).
			expect(host.events.map((e) => e.name)).not.toContain("session_before_compact");
			expect(host.events.map((e) => e.name)).not.toContain("session_compact");
			// Only one provider call: the draft path performs no summary LLM call.
			expect(host.faux.state.callCount).toBe(1);
			const roles = host.sessionManager.buildSessionProjection().messages.map((m) => m.role);
			expect(roles).toEqual(["system", "compactionSummary", "assistant"]);
			// S1⑦: first extension-visible event after the draft turn_end is
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
			expect(second.roles).toEqual(["system", "user", "assistant", "toolResult"]);
			expect(second.texts[1]).toContain("SUMMARY mid-run");
			// S1⑦ mid-run: first visible event after the draft turn_end is turn_start.
			const names = host.events.map((e) => e.name);
			const firstTurnEnd = names.indexOf("turn_end");
			expect(names[firstTurnEnd + 1]).toBe("turn_start");
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
			const roles = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "message")
				.map((e) => (e as { message: { role: string } }).message.role);
			// The branch opens with pi's system entry, then the run's messages.
			expect(roles).toEqual(["system", "user", "assistant", "toolResult", "user", "assistant"]);
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
			expect(branchCompactions(host.sessionManager).length).toBe(1);
			const editEntries = host.sessionManager.getBranch().filter((e) => e.type === "context_edit");
			expect(editEntries.length).toBe(1);
			const projection = host.sessionManager.buildSessionProjection();
			expect(projection.messages.map((m) => m.role)).toEqual(["system", "compactionSummary", "assistant"]);
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

function firstUserEntryId(host: { sessionManager: SessionManager }): string {
	const entry = host.sessionManager
		.getBranch()
		.find((e) => e.type === "message" && (e as { message: { role: string } }).message.role === "user");
	if (!entry) throw new Error("no user entry on branch");
	return entry.id;
}

// ── SC-HOST-02/10 type-level half: the host-internal commit/compaction
describe("SC-HOST-02/10 host events not exposed to extensions (H3)", () => {
	it("entry_appended / compaction_start / compaction_end are not assignable to ExtensionAPI.on event names", () => {
		// ExtensionEvent is the union of every extension-visible event shape;
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
