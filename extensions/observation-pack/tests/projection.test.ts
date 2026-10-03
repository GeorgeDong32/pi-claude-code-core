/**
 * B5 (arch): the pure projection step, driven directly — no FakeHost, no pi
 * runtime, no bus. These cases were previously reachable only through a
 * ~286-line fake host; they now pin the loop, the send-count recovery
 * heuristic, fail-open, the sentinel streak, the counters, and invariant 9
 * (unaffected messages pass through BY REFERENCE; a replaced message keeps
 * every field except content). node:test, flat (no nested describe).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

import { FULL_SENDS, THRESHOLD_BYTES } from "../observation.ts";
import { createProjectionState, projectContext, SENTINEL_STREAK_LIMIT, type ProjectionPorts } from "../projection.ts";

function bigResult(text: string, toolName = "bash"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName,
		isError: false,
		content: [{ type: "text", text }],
	} as ToolResultMessage;
}

function assistantMessage(): AgentMessage {
	return { role: "assistant", content: [] } as unknown as AgentMessage;
}

/** In-memory ports: records everything, fails on demand. */
function fakePorts(failStoreFor?: (id: string) => boolean): {
	ports: ProjectionPorts;
	ledger: Array<Record<string, unknown>>;
	stored: string[];
} {
	const ledger: Array<Record<string, unknown>> = [];
	const stored: string[] = [];
	return {
		ledger,
		stored,
		ports: {
			store: async (observation) => {
				if (failStoreFor?.(observation.id)) throw new Error(`store exploded for ${observation.id}`);
				stored.push(observation.id);
			},
			appendLedger: async (entry) => {
				ledger.push(entry);
			},
		},
	};
}

const BIG = "x".repeat(THRESHOLD_BYTES + 100);

test("first FULL_SENDS requests pass the message through by reference and ledger 'full' events", async () => {
	const state = createProjectionState();
	const { ports, ledger } = fakePorts();
	const message = bigResult(BIG);
	for (let i = 0; i < FULL_SENDS; i += 1) {
		const outcome = await projectContext({ messages: [message], root: "/t", state, ports });
		assert.equal(outcome.messages.length, 1);
		// invariant 9: identity pass-through while in the full-send window
		assert.equal(outcome.messages[0], message);
		assert.equal(outcome.replacedThisRequest, 0);
		assert.equal(outcome.counters, null);
	}
	assert.equal(ledger.filter((e) => e.event === "full").length, FULL_SENDS);
	assert.equal(state.sentCounts.size, 1);
});

test("after FULL_SENDS the content is replaced; every other field survives (invariant 9)", async () => {
	const state = createProjectionState();
	const { ports, ledger } = fakePorts();
	const message = bigResult(BIG);
	const bystander = bigResult(`${BIG}`, "grep");
	for (let i = 0; i < FULL_SENDS; i += 1) {
		await projectContext({ messages: [message, bystander], root: "/t", state, ports });
	}
	const outcome = await projectContext({ messages: [message, bystander], root: "/t", state, ports });
	assert.equal(outcome.replacedThisRequest, 2);
	assert.equal(ledger.filter((e) => e.event === "placeholder").length, 2);
	// identity for a NON-candidate message:
	const plain = assistantMessage();
	const outcome2 = await projectContext({ messages: [message, plain], root: "/t", state, ports });
	assert.equal(outcome2.messages[1], plain, "non-candidates pass through by reference");
	// the replaced message keeps toolCallId/toolName/isError, only content changes
	const replaced = outcome.messages[0] as ToolResultMessage;
	assert.notEqual(replaced, message);
	assert.equal(replaced.toolCallId, message.toolCallId);
	assert.equal(replaced.toolName, message.toolName);
	assert.equal(replaced.isError, false);
	assert.equal((replaced.content[0] as { type: string }).type, "text");
	assert.match((replaced.content[0] as { text: string }).text, /obs_/);
});

test("counters publish exactly on the first-replacement request, cumulative afterwards null", async () => {
	const state = createProjectionState();
	const { ports } = fakePorts();
	const message = bigResult(BIG);
	for (let i = 0; i < FULL_SENDS; i += 1) {
		const o = await projectContext({ messages: [message], root: "/t", state, ports });
		assert.equal(o.counters, null);
	}
	const first = await projectContext({ messages: [message], root: "/t", state, ports });
	assert.ok(first.counters);
	assert.equal(first.counters.placeholders, 1);
	assert.ok(first.counters.tokensAvoided > 0);
	const second = await projectContext({ messages: [message], root: "/t", state, ports });
	assert.equal(second.counters, null, "only the first replacement publishes");
});

test("a throwing store fails open for that message only (OBS-08)", async () => {
	const state = createProjectionState();
	const { ports, stored } = fakePorts(() => true); // store always throws
	const message = bigResult(BIG);
	const outcome = await projectContext({ messages: [message], root: "/t", state, ports });
	assert.equal(outcome.messages[0], message, "original bytes survive");
	assert.equal(outcome.failOpenReasons.length, 1);
	assert.match(outcome.failOpenReasons[0] ?? "", /store exploded/);
	assert.equal(stored.length, 0);
	assert.equal(outcome.replacedThisRequest, 0);
});

test("send counts recover from prior assistant messages after a restart", async () => {
	// fresh state (simulated restart): priorAssistantCounts heuristic must
	// fast-forward the candidate past FULL_SENDS on its very first request.
	const state = createProjectionState();
	const { ports } = fakePorts();
	const message = bigResult(BIG);
	const history = [message, assistantMessage(), assistantMessage(), assistantMessage()];
	const outcome = await projectContext({ messages: history, root: "/t", state, ports });
	assert.ok(outcome.replacedThisRequest >= 1, `expected recovery replacement, got ${outcome.replacedThisRequest}`);
});

test("sentinel trips after the streak limit and never repeats", async () => {
	const state = createProjectionState();
	const { ports } = fakePorts();
	const message = bigResult(BIG);
	for (let i = 0; i < FULL_SENDS; i += 1) {
		await projectContext({ messages: [message], root: "/t", state, ports });
	}
	// store succeeds (so eligibility is counted), but the LEDGER throws: the
	// message keeps its original bytes, nothing packs — the exact CMP-04
	// "projection looks ineffective" signature.
	const ledgerBroken: ProjectionPorts = {
		store: async () => {},
		appendLedger: async () => {
			throw new Error("ledger disk full");
		},
	};
	let warned = 0;
	for (let i = 0; i < SENTINEL_STREAK_LIMIT + 2; i += 1) {
		const outcome = await projectContext({ messages: [message], root: "/t", state, ports: ledgerBroken });
		if (outcome.sentinelWarning !== null) warned += 1;
	}
	assert.equal(warned, 1, "warns exactly once, then stays quiet");
	assert.equal(state.sentinelWarned, true);
});

// ── C1 (arch review 2026-10-03): identity memo + stored set ──

test("C1: a repeated message is analyzed and stored exactly once (steady-state requests cost one Map.get)", async () => {
	const state = createProjectionState();
	let storeCalls = 0;
	const ports: ProjectionPorts = {
		store: async () => {
			storeCalls += 1;
		},
		appendLedger: async () => {},
	};
	const message = bigResult(BIG);
	for (let i = 0; i < FULL_SENDS + 3; i += 1) {
		await projectContext({ messages: [message], root: "/t", state, ports });
	}
	assert.equal(storeCalls, 1, "ports.store fires once for the process, not once per request");
	assert.equal(state.identity.size, 1);
	assert.ok(state.stored.size === 1);
});

test("C1: ineligible candidates are memoized as null and never re-analyzed", async () => {
	const state = createProjectionState();
	const { ports } = fakePorts();
	const small = { ...bigResult("tiny"), toolCallId: "tc-small" } as ToolResultMessage;
	for (let i = 0; i < 3; i += 1) {
		const outcome = await projectContext({ messages: [small], root: "/t", state, ports });
		assert.equal(outcome.messages[0], small, "passes through by reference every time");
	}
	assert.equal(state.identity.size, 1, "one memo entry");
	assert.equal(state.identity.get("/t\0bash\0tc-small"), null, "memoized as ineligible");
});

test("C1: a failed store is not memoized — the next request retries (OBS-08 fail-open preserved)", async () => {
	const state = createProjectionState();
	let failFirst = true;
	let storeCalls = 0;
	const ports: ProjectionPorts = {
		store: async () => {
			storeCalls += 1;
			if (failFirst) {
				failFirst = false;
				throw new Error("disk full");
			}
		},
		appendLedger: async () => {},
	};
	const message = bigResult(BIG);
	const first = await projectContext({ messages: [message], root: "/t", state, ports });
	assert.equal(first.failOpenReasons.length, 1);
	assert.equal(first.messages[0], message, "fail-open keeps the original bytes");
	assert.equal(state.stored.size, 0, "a failed store is not recorded");
	const second = await projectContext({ messages: [message], root: "/t", state, ports });
	assert.equal(second.failOpenReasons.length, 0);
	assert.equal(storeCalls, 2, "the retry actually reached ports.store");
	assert.equal(state.stored.size, 1);
});

test("C1: cold start (new state) recomputes once — per-process memo, not per-request", async () => {
	let storeCalls = 0;
	const ports: ProjectionPorts = {
		store: async () => {
			storeCalls += 1;
		},
		appendLedger: async () => {},
	};
	const message = bigResult(BIG);
	await projectContext({ messages: [message], root: "/t", state: createProjectionState(), ports });
	await projectContext({ messages: [message], root: "/t", state: createProjectionState(), ports });
	assert.equal(storeCalls, 2, "each fresh state pays the one-time analysis again (restart semantics)");
});

test("C1: same toolCallId under different toolNames keeps separate identities", async () => {
	const state = createProjectionState();
	const { ports, stored } = fakePorts();
	const a = bigResult(BIG, "bash");
	const b = bigResult(BIG, "grep"); // same fixed toolCallId "tc-1", different toolName
	await projectContext({ messages: [a, b], root: "/t", state, ports });
	assert.equal(state.identity.size, 2, "the memo key includes toolName — no collision");
	assert.equal(stored.length, 2);
});
