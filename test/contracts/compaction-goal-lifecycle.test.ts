/**
 * SM-03 / APP-05: boundary compaction must neither lose goal continuation
 * nor add a checkpoint. Real AgentSession, goal and controller; only summary
 * generation is stubbed. Stop each fixture at its first checkpoint response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { AgentBeforeSettleEvent, ExtensionError, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { createCompactionHost } from "./support/compaction-host.ts";
import { clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals } from "./fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import goalExtension from "../../extensions/goal/goal.ts";
import { createGoal } from "../../extensions/goal/goal-record.ts";
import { readActiveGoalFiles, writeActiveGoalFile } from "../../extensions/goal/storage/goal-files.ts";
import {
	registerCompactionSubscriber, resetCompactionSeam, type CompactionSeamInfo,
} from "../../lib/compaction-seam.ts";

const summaryGate = vi.hoisted(() => ({ wait: undefined as Promise<void> | undefined }));
vi.mock("../../extensions/compaction/summarizer.ts", async (original) => ({
	...await original<typeof import("../../extensions/compaction/summarizer.ts")>(),
	runSummarizer: async () => {
		await summaryGate.wait;
		return { ok: true, summary: "## History\nSynthetic reviewed work.\n" + "h".repeat(500), subCalls: [], retried: false };
	},
}));

// T_n=18K: prime near 10K (precompute), target near 12K (apply), below native.
const SETTINGS = {
	mode: "on", targetPostRatio: 0.25, precomputeRatio: 0.45, applyRatio: 0.6,
	summaryTokenEstimate: 200, keepSlackTokens: 1500,
	minPrecomputeGapTurns: 0, refusedCooldownTurns: 0,
};
type Path = "baseline" | "stop" | "toolUse" | "beforeSettle" | "overridden";
type GoalState = "active" | "autoContinueOff" | "none" | "complete";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let globals: ReturnType<typeof snapshotCoreGlobals>;

beforeEach(() => {
	globals = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	resetCompactionSeam();
});
afterEach(() => {
	summaryGate.wait = undefined;
	resetCompactionSeam();
	resetCoreBusForTests();
	restoreCoreGlobals(globals);
});

async function runGoal(path: Path, state: GoalState = "active") {
	let releaseSummary = () => {};
	summaryGate.wait = path === "beforeSettle" ? new Promise<void>((resolve) => { releaseSummary = resolve; }) : undefined;
	let target = false;
	let runs = 0;
	let settled = 0;
	let slowEndCheckpoints: number | undefined;
	const timeline: string[] = [];
	const after: CompactionSeamInfo[] = [];
	const proposals: Array<{ boundary: string; stop?: string; afterCount: number }> = [];
	const requests: Array<{ settled: number; resync: number }> = [];
	const errors: ExtensionError[] = [];
	const host = await createCompactionHost({
		model: { contextWindow: 20_000, maxTokens: 1000 },
		settingsOverrides: { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 100 } },
		controllerSettings: path === "baseline" ? undefined : SETTINGS,
		envMode: null,
		probe: { registerTestTool: true },
		extraFactories: [(pi) => {
			pi.on("session_start", (_event, ctx) => {
				// Suppress startup continuation; enable it only for the target run.
				if (state !== "none") writeActiveGoalFile(ctx, createGoal({
					objective: "=== Goal ===\nObjective: finite compaction review",
					autoContinue: false, sisyphus: true,
				}, Date.now()));
			});
			pi.on("before_agent_start", (_event, ctx) => {
				if (!target) return;
				runs++;
				if (runs > 2) ctx.abort(); // Hard bound even if continuation regresses.
				if (runs > 1) {
					const goal = readActiveGoalFiles(ctx)[0];
					if (goal) writeActiveGoalFile(ctx, { ...goal, autoContinue: false });
				}
			});
			goalExtension(pi);
			registerCompactionSubscriber({
				after: (info) => { after.push(info); timeline.push("after"); },
			});
		}],
		postFactories: [(pi) => {
			const observeProposal = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
				if (!target || !event.entries.some((entry) => entry.type === "compaction")) return;
				proposals.push({
					boundary: event.type,
					stop: event.type === "turn_end" && event.message.role === "assistant" ? event.message.stopReason : undefined,
					afterCount: after.length,
				});
				if (path === "overridden" && proposals.length === 1) return { entries: [] };
			};
			pi.on("turn_end", async (event) => {
				// Finish compute after this apply point, making before_settle win.
				if (target && path === "beforeSettle") releaseSummary();
				await Promise.resolve();
				return observeProposal(event);
			});
			pi.on("agent_before_settle", observeProposal);
			pi.on("agent_end", async () => {
				if (target && path === "stop" && state === "active" && runs === 1) {
					await sleep(90); // Exercise the goal timer's busy retry.
					slowEndCheckpoints = timeline.filter((event) => event === "checkpoint").length;
				}
			});
		}],
	});
	const stopErrors = host.session.extensionRunner.onError((error) => errors.push(error));
	const unsubscribe = host.session.subscribe((event) => {
		if (!target) return;
		if (event.type === "agent_settled") { settled++; timeline.push("settled"); }
		if (event.type === "entry_appended" && event.entry.type === "compaction") timeline.push("commit");
		if (event.type === "message_start" && event.message.role === "custom"
			&& event.message.customType === "pi-goal-event"
			&& (event.message.details as { kind?: string })?.kind === "checkpoint") timeline.push("checkpoint");
	});
	try {
		host.faux.setResponses([fauxAssistantMessage("p".repeat(600))]);
		await host.session.prompt("r".repeat(state === "none" ? 30_000 : 24_000));
		expect(host.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		const goal = readActiveGoalFiles({ cwd: host.cwd })[0];
		if (goal) writeActiveGoalFile({ cwd: host.cwd }, {
			...goal, autoContinue: state !== "autoContinueOff",
			status: state === "complete" ? "complete" : "active",
		});
		target = true;
		const callsBefore = host.faux.state.callCount;
		host.faux.setResponses([
			...(path === "toolUse" ? [fauxAssistantMessage(fauxToolCall("sc_probe_tool", { value: "" }), { stopReason: "toolUse" })] : []),
			fauxAssistantMessage("f".repeat(1200)),
			fauxAssistantMessage("bounded checkpoint answer"),
		].map((message): FauxResponseStep => (context) => {
			timeline.push("request");
			const system = JSON.stringify(context.messages.filter((entry) => entry.role === "system"));
			requests.push({ settled, resync: (system.match(/\[POST-COMPACTION RESYNC/g) ?? []).length });
			return message;
		}));
		await host.session.prompt("t".repeat(6000));
		await vi.waitFor(() => expect(settled).toBe(state === "active" ? 2 : 1), { timeout: 2000, interval: 10 });
		await sleep(120); // More than two idle retries: no delayed surplus checkpoint.
		const branch = host.sessionManager.getBranch();
		const committedIds = branch.filter((entry) => entry.type === "compaction").map((entry) => entry.id);
		const checkpoints = branch.filter((entry) => entry.type === "custom_message"
			&& entry.customType === "pi-goal-event"
			&& (entry.details as { kind?: string })?.kind === "checkpoint").length;
		const discarded = branch.filter((entry) => entry.type === "custom" && entry.customType === "cc-core-compaction")
			.map((entry) => (entry as { data: { outcome?: string; reason?: string } }).data)
			.filter((data) => data.outcome === "discarded" && data.reason === "overridden").length;
		expect(errors).toEqual([]);
		expect(host.session.isStreaming).toBe(false);
		expect(host.events.some((event) => event.name === "session_before_compact")).toBe(false);
		expect(host.events.filter((event) => event.name === "turn_end").some((event) =>
			event.stopReason === "error" || event.stopReason === "aborted")).toBe(false);
		expect(after.map((info) => info.entryId)).toEqual(committedIds);
		return {
			timeline, requests, after, proposals, checkpoints, discarded, runs, settled, slowEndCheckpoints,
			calls: host.faux.state.callCount - callsBefore,
		};
	} finally {
		releaseSummary();
		try {
			await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await host.session.abort();
		} finally {
			unsubscribe();
			stopErrors();
			host.session.dispose();
			host.cleanup();
		}
	}
}

describe("SM-03 goal continuation through real host compaction", () => {
	it.each<Path>(["baseline", "stop", "toolUse", "beforeSettle", "overridden"])(
		"%s: settles, then starts exactly one checkpoint request",
		async (path) => {
			const result = await runGoal(path);
			const toolTurn = path === "toolUse" ? 1 : 0;
			expect(result.calls).toBe(2 + toolTurn);
			expect(result.checkpoints).toBe(1);
			expect(result.runs).toBe(2);
			expect(result.settled).toBe(2);
			expect(result.requests.map((request) => request.settled)).toEqual(toolTurn ? [0, 0, 1] : [0, 1]);
			expect(result.timeline.indexOf("checkpoint")).toBeGreaterThan(result.timeline.indexOf("settled"));
			expect(result.timeline.filter((event) => event === "checkpoint")).toHaveLength(1);
			expect(result.requests.map((request) => request.resync)).toEqual(
				path === "baseline" ? [0, 0] : toolTurn ? [0, 0, 1] : [0, 1]);
			expect(result.after.map((info) => info.midRun)).toEqual(
				path === "baseline" ? [] : [path === "stop" || path === "toolUse"]);
			expect(result.proposals.map((proposal) => proposal.boundary)).toEqual(
				path === "baseline" ? [] : path === "overridden" ? ["turn_end", "agent_before_settle"]
					: [path === "beforeSettle" ? "agent_before_settle" : "turn_end"]);
			if (path === "stop" || path === "toolUse") expect(result.proposals[0].stop).toBe(path === "stop" ? "stop" : "toolUse");
			expect(result.proposals.every((proposal) => proposal.afterCount === 0)).toBe(true);
			expect(result.discarded).toBe(path === "overridden" ? 1 : 0);
			if (path === "stop") expect(result.slowEndCheckpoints).toBe(0);
		},
	);

	it.each<GoalState>(["autoContinueOff", "none", "complete"])(
		"%s: a committed final-stop draft starts no checkpoint or extra request",
		async (state) => {
			const result = await runGoal("stop", state);
			expect(result.calls).toBe(1);
			expect(result.requests.map((request) => request.settled)).toEqual([0]);
			expect(result.checkpoints).toBe(0);
			expect(result.timeline).not.toContain("checkpoint");
			expect(result.runs).toBe(1);
			expect(result.settled).toBe(1);
			expect(result.after.map((info) => info.midRun)).toEqual([true]);
			expect(result.proposals.map((proposal) => proposal.stop)).toEqual(["stop"]);
			expect(result.requests[0].resync).toBe(0);
		},
	);
});
