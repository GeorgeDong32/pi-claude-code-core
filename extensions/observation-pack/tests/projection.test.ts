import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

import { FULL_SENDS, THRESHOLD_BYTES } from "../observation.ts";
import { createProjectionState, projectContext, SENTINEL_STREAK_LIMIT, type ProjectionPorts } from "../projection.ts";

function bigResult(text: string, toolName = "bash", toolCallId = "tc-1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		isError: false,
		content: [{ type: "text", text }],
	} as ToolResultMessage;
}

function assistantMessage(): AgentMessage {
	return { role: "assistant", content: [] } as unknown as AgentMessage;
}

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
	const plain = assistantMessage();
	const outcome2 = await projectContext({ messages: [message, plain], root: "/t", state, ports });
	assert.equal(outcome2.messages[1], plain, "non-candidates pass through by reference");
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
	const { ports, stored } = fakePorts(() => true);
	const message = bigResult(BIG);
	const outcome = await projectContext({ messages: [message], root: "/t", state, ports });
	assert.equal(outcome.messages[0], message, "original bytes survive");
	assert.equal(outcome.failOpenReasons.length, 1);
	assert.match(outcome.failOpenReasons[0] ?? "", /store exploded/);
	assert.equal(stored.length, 0);
	assert.equal(outcome.replacedThisRequest, 0);
});

test("send counts recover from prior assistant messages after a restart", async () => {
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
	const b = bigResult(BIG, "grep");
	await projectContext({ messages: [a, b], root: "/t", state, ports });
	assert.equal(state.identity.size, 2, "the memo key includes toolName — no collision");
	assert.equal(stored.length, 2);
});

async function runRequests(n: number, messages: AgentMessage[], state = createProjectionState(), ports = fakePorts().ports) {
	const out = [];
	for (let i = 0; i < n; i++) out.push(await projectContext({ messages, root: "/w", state, ports }));
	return out;
}

test("OB-T01: the cached placeholder is byte-identical across requests and fresh states (CRLF, no trailing newline, unicode, long single line)", async () => {
	const variants = [
		"line1\r\nline2\r\n" + "y".repeat(THRESHOLD_BYTES),
		"中文内容\n" + "§".repeat(THRESHOLD_BYTES) + "\n✅",
		"z".repeat(THRESHOLD_BYTES * 2),
	];
	for (const text of variants) {
		const messages = [bigResult(text)];
		const stateA = createProjectionState();
		const portsA = fakePorts();
		const results = await runRequests(FULL_SENDS + 3, messages, stateA, portsA.ports);
		const placeholders = results.slice(FULL_SENDS).map((r) => (r.messages[0] as ToolResultMessage).content[0] && (r.messages[0] as ToolResultMessage).content[0]!.type === "text" ? ((r.messages[0] as ToolResultMessage).content[0] as { text: string }).text : "");
		assert.ok(placeholders.every((p) => p.length > 0));
		assert.ok(new Set(placeholders).size === 1, "placeholder identical across hot requests");
		const stateB = createProjectionState();
		const portsB = fakePorts();
		await runRequests(FULL_SENDS + 1, messages, stateB, portsB.ports);
		const fresh = (await runRequests(1, messages, stateB, portsB.ports))[0]!.messages[0] as ToolResultMessage;
		const freshText = ((fresh.content[0] as { text: string }).text);
		assert.equal(freshText, placeholders[0]);
	}
});

test("OB-T02: zero constructions during full-send; ONE at the first replacement; zero on hot requests", async () => {
	const messages = [bigResult(BIG)];
	const state = createProjectionState();
	const ports = fakePorts();
	const results = await runRequests(FULL_SENDS, messages, state, ports.ports);
	void results;
	assert.equal(state.placeholderConstructions, 0, "full-send phase never constructs");
	await runRequests(1, messages, state, ports.ports);
	assert.equal(state.placeholderConstructions, 1, "first replacement constructs once");
	await runRequests(5, messages, state, ports.ports);
	assert.equal(state.placeholderConstructions, 5 === 5 ? 1 : 1, "hot requests never re-construct");
});

test("OB-T03: isolation — same call id under different tools, multiple roots, fresh state", async () => {
	const a = bigResult(BIG, "bash");
	const b: ToolResultMessage = { ...bigResult(BIG, "read"), toolCallId: "tc-1" };
	const state = createProjectionState();
	const ports = fakePorts();
	for (let i = 0; i < FULL_SENDS + 2; i++) {
		await projectContext({ messages: [a, b], root: "/w", state, ports: ports.ports });
		await projectContext({ messages: [a, b], root: "/other", state, ports: ports.ports });
	}
	assert.equal(state.placeholderConstructions, 4, "one per (root, tool, callId) identity");
});

test("OB-T05: a failed ledger keeps the original bytes, commits nothing, retries correctly — and keeps the computed memo", async () => {
	const messages = [bigResult(BIG)];
	const state = createProjectionState();
	const ledger: Array<Record<string, unknown>> = [];
	let failLedger = false;
	const ports: ProjectionPorts = {
		store: async () => {},
		appendLedger: async (entry) => {
			if (failLedger && entry.event === "placeholder") throw new Error("ledger down");
			ledger.push(entry);
		},
	};
	for (let i = 0; i < FULL_SENDS; i++) await projectContext({ messages, root: "/w", state, ports });
	failLedger = true;
	const failed = await projectContext({ messages, root: "/w", state, ports });
	assert.equal(failed.replacedThisRequest, 0);
	assert.equal(failed.failOpenReasons.length, 1);
	assert.equal((failed.messages[0] as ToolResultMessage).content, messages[0]!.content, "original bytes kept");
	assert.equal(state.savedTokens, 0, "no savings committed");
	assert.equal(state.placeholderConstructions, 1, "the computed memo is KEPT (OB-01)");
	failLedger = false;
	const recovered = await projectContext({ messages, root: "/w", state, ports });
	assert.equal(recovered.replacedThisRequest, 1);
	assert.equal(state.placeholderConstructions, 1, "recovery reuses the memo");
	assert.ok(state.savedTokens > 0);
});

test("OB-T07: ledger event order and sentinel/first-savings semantics (BH-E3b: one placeholder row per object id)", async () => {
	const messages = [bigResult(BIG)];
	const state = createProjectionState();
	const ports = fakePorts();
	await runRequests(FULL_SENDS + 2, messages, state, ports.ports);
	assert.deepEqual(
		ports.ledger.map((e) => e.event),
		["full", "full", "placeholder"],
	);
	assert.equal(
		ports.ledger.filter((e) => e.event === "placeholder").length,
		1,
		"BH-E3b: one audit row for the object's first replacement — later hot requests skip the row (was: one per request)",
	);
	assert.equal(state.placeholderCount, 1);
	assert.ok(state.savedTokens > 0);
});

test("OBS-09-SITES: one sites entry per first-replacement observation, avoidedTokens = that observation's removedTokens", async () => {
	const state = createProjectionState();
	const { ports, ledger } = fakePorts();
	const a = bigResult("a".repeat(THRESHOLD_BYTES + 100), "bash", "tc-multi-a");
	const b = bigResult("b".repeat(THRESHOLD_BYTES + 4000), "grep", "tc-multi-b");
	const messages = [a, b];
	for (let i = 0; i < FULL_SENDS; i += 1) {
		const outcome = await projectContext({ messages, root: "/t", state, ports });
		assert.equal(outcome.counters, null);
	}
	const first = await projectContext({ messages, root: "/t", state, ports });
	assert.ok(first.counters, "first-replacement request publishes counters");
	assert.ok(first.counters.sites.length === 2, "one sites entry per first-replaced observation");
	const byTool = new Map(first.counters.sites.map((site) => [site.tool, site]));
	for (const site of first.counters.sites) {
		assert.deepEqual(Object.keys(site).sort(), ["avoidedTokens", "id", "tool", "toolCallId"]);
		assert.ok(site.id.startsWith("obs_"));
		assert.ok(site.avoidedTokens > 0);
	}
	assert.equal(byTool.get("bash")!.toolCallId, "tc-multi-a");
	assert.equal(byTool.get("grep")!.toolCallId, "tc-multi-b");
	assert.equal(new Set(first.counters.sites.map((site) => site.toolCallId)).size, 2);
	const placeholderRows = ledger.filter(
		(entry) => entry.event === "placeholder" && typeof entry.sendNumber === "number" && entry.sendNumber === FULL_SENDS + 1,
	);
	assert.equal(placeholderRows.length, 2);
	for (const row of placeholderRows) {
		const site = byTool.get(row.tool as string);
		assert.ok(site, `ledger row for ${String(row.tool)} has a sites entry`);
		assert.equal(site.id, row.id);
		assert.equal(site.avoidedTokens, row.removedTokens);
	}
	const distinct = new Set(first.counters.sites.map((site) => site.avoidedTokens));
	assert.equal(distinct.size, 2, "per-observation values, not one shared number");
	assert.equal(first.counters.placeholders, 2);
	assert.equal(first.counters.tokensAvoided, first.counters.sites.reduce((sum, site) => sum + site.avoidedTokens, 0));
});

test("OBS-09-SITES: later requests keep counters null — no sites payload", async () => {
	const state = createProjectionState();
	const { ports } = fakePorts();
	const message = bigResult(BIG);
	for (let i = 0; i < FULL_SENDS; i += 1) {
		await projectContext({ messages: [message], root: "/t", state, ports });
	}
	const first = await projectContext({ messages: [message], root: "/t", state, ports });
	assert.ok(first.counters);
	assert.equal(first.counters.sites.length, 1);
	assert.equal(first.counters.sites[0].tool, "bash");
	assert.equal(first.counters.sites[0].toolCallId, "tc-1");
	for (let i = 0; i < 3; i += 1) {
		const later = await projectContext({ messages: [message], root: "/t", state, ports });
		assert.equal(later.counters, null, "only the first replacement publishes counters/sites");
	}
});

test("BH-E3a: obs_recall results are exempt from projection — never analyzed, stored, ledgered, or packed", async () => {
	const state = createProjectionState();
	const { ports, ledger, stored } = fakePorts();
	const recall = bigResult(`${"r".repeat(THRESHOLD_BYTES + 100)}\n[obs_recall id=obs_4b1d7b39d6c8a2f1e0a3b5c7 offset=0]`, "obs_recall", "tc-recall");
	const regular = bigResult(BIG, "bash", "tc-1");
	const messages = [recall, regular];
	for (let i = 0; i < FULL_SENDS; i += 1) {
		const outcome = await projectContext({ messages, root: "/t", state, ports });
		assert.equal(outcome.messages[0], recall, "obs_recall results pass through by reference");
	}
	const outcome = await projectContext({ messages, root: "/t", state, ports });
	assert.equal(outcome.messages[0], recall, "obs_recall results are never replaced, at any request age");
	assert.equal(
		(outcome.messages[1] as { content: Array<{ type: string; text: string }> }).content[0].text.includes("obs_"),
		true,
		"the regular result beside it still projects",
	);
	assert.equal(stored.length, 1, "only the regular result is stored");
	assert.equal(
		ledger.filter((entry) => entry.event === "full").length,
		FULL_SENDS,
		"no full-send ledger rows for the recall result",
	);
	assert.ok(ledger.every((entry) => entry.tool === "bash"), "no ledger row ever references obs_recall");
	assert.equal(state.identity.size, 1, "the recall result is not even memoized as a candidate");
});

test("BH-E3b: the placeholder ledger row is written once per object id per process, not per request", async () => {
	const state = createProjectionState();
	const { ports, ledger } = fakePorts();
	const message = bigResult(BIG);
	let lastReplaced = -1;
	for (let i = 0; i < FULL_SENDS + 3; i += 1) {
		const outcome = await projectContext({ messages: [message], root: "/t", state, ports });
		lastReplaced = outcome.replacedThisRequest;
	}
	const placeholderRows = ledger.filter((entry) => entry.event === "placeholder");
	assert.equal(placeholderRows.length, 1, "BH-E3b: exactly one audit row for the first replacement");
	assert.equal(placeholderRows[0].sendNumber, FULL_SENDS + 1, "the row still records the first-replacement send number");
	assert.ok(String(placeholderRows[0].id).startsWith("obs_"));
	assert.equal(state.sentCounts.get(`/t\0${placeholderRows[0].id}`), FULL_SENDS + 3);
	assert.equal(lastReplaced, 1);
});

test("BH-E3c: a message that throws in the candidate check fails open for itself; other messages still project", async () => {
	const state = createProjectionState();
	const { ports } = fakePorts();
	const malformed = { role: "toolResult", toolCallId: "tc-bad", toolName: "bash", isError: false } as unknown as ToolResultMessage;
	const good = bigResult(BIG, "bash", "tc-good");
	let outcome: Awaited<ReturnType<typeof projectContext>> | undefined;
	for (let i = 0; i < FULL_SENDS + 1; i += 1) {
		outcome = await projectContext({ messages: [malformed, good], root: "/t", state, ports });
	}
	assert.equal(outcome!.failOpenReasons.length, 1, "the malformed message fails open for itself, every request");
	assert.equal(outcome!.replacedThisRequest, 1, "the healthy message still projected");
	assert.equal(outcome!.messages[0], malformed, "the malformed message keeps its place, unprojected");
	assert.notEqual(outcome!.messages[1], good, "the healthy one was replaced");
});
