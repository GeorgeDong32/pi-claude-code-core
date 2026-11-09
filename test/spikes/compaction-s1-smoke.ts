/*
 * W0 scratch spike: verify the H16 host recipe end-to-end before freezing
 * it into test/contracts/support/compaction-host.ts. Throwaway driver —
 * conclusions are backfilled into spec §4.3 by the W0 task.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { createCompactionHost, compactionDraft, contextCapturingResponse } from "../contracts/support/compaction-host.ts";

async function main() {
	// Scenario A (S1 run-end): plain stop turn, turn_end returns a draft.
	const host = await createCompactionHost({
		probe: { turnEndDraft: (event) => [compactionDraft("SUMMARY-A", event.messageEntryId)] },
	});
	try {
		host.faux.setResponses([fauxAssistantMessage("hello there")]);
		await host.session.prompt("first user message");
		const names = host.events.map((e) => e.name);
		console.log("A events:", names.join(","));
		const branch = host.sessionManager.getBranch();
		const compaction = branch.filter((e: any) => e.type === "compaction");
		console.log("A compaction entries:", compaction.length, JSON.stringify(compaction.map((c) => ({ fromHook: (c as CompactionEntry).fromHook, chars: (c as CompactionEntry).summary.length }))));
		console.log("A callCount:", host.faux.state.callCount);
		assert.equal(compaction.length, 1);
		assert.equal((compaction[0] as CompactionEntry).fromHook, true);
		assert.equal(names.includes("session_before_compact"), false);
		assert.equal(names.includes("session_compact"), false);
		// projection: system, compactionSummary, ... ?
		const projection = host.sessionManager.buildSessionProjection();
		console.log("A projection roles:", projection.messages.map((m: any) => m.role).join(","));
	} finally {
		host.cleanup();
	}

	// Scenario B (S1 mid-run): tool turn, draft at turn_end, context shrinks.
	const host2 = await createCompactionHost({
		probe: {
			registerTestTool: true,
			turnEndDraft: (event) => [compactionDraft("SUMMARY-B", event.messageEntryId)],
		},
	});
	try {
		host2.faux.setResponses([
			fauxAssistantMessage([{ type: "toolCall", id: "tc1", name: "sc_probe_tool", arguments: { value: "x" } }], { stopReason: "toolUse" }),
			contextCapturingResponse(host2, fauxAssistantMessage("after tools done")),
		]);
		await host2.session.prompt("run a tool");
		const names2 = host2.events.map((e) => e.name);
		console.log("B events:", names2.join(","));
		const compaction2 = host2.sessionManager.getBranch().filter((e: any) => e.type === "compaction");
		console.log("B compaction entries:", compaction2.length);
		console.log("B requestContexts:", JSON.stringify(host2.requestContexts.map((c) => c.roles)));
		assert.equal(compaction2.length, 1);
		assert.ok(host2.requestContexts.length >= 2);
	} finally {
		host2.cleanup();
	}
	console.log("SMOKE-OK");
}

main().catch((err) => {
	console.error("SMOKE FAILED", err);
	process.exit(1);
});
