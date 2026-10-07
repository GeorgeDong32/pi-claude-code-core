/**
 * interpret.test.ts — SPEC 2026-10-07 P2-1 §5: the INTERPRET half against a
 * recording port set. Every Decision kind must reach the right port with the
 * right arguments, and effects must fire in the recorded order (track ->
 * family note -> auto denial reset). The ports themselves wrap the real gate
 * functions; their internal behavior (dialog five choices, forwarding
 * approved/denied/timeout, compliance injection) is covered end-to-end by
 * the FakePi suite and the parity golden — here we pin the DISPATCH.
 */
import { describe, expect, it } from "vitest";
import { interpretDecision, type InterpretPorts } from "./interpret.ts";
import type { BlockShape, Decision, ToolCallRequest } from "./adjudicate.ts";

interface Call {
	port: string;
	args: unknown[];
}

function recordingPorts(overrides: Partial<InterpretPorts> = {}): { ports: InterpretPorts; calls: Call[] } {
	const calls: Call[] = [];
	const rec = (port: string) => (...args: unknown[]) => {
		calls.push({ port, args });
	};
	const ports: InterpretPorts = {
		promptWithOptions: (async (call: ToolCallRequest, label: string, category: string) => {
			rec("promptWithOptions")(call, label, category);
			return { block: true, reason: `pwo:${label}:${category}` };
		}) as never,
		promptApproval: (async (call: ToolCallRequest, label: string) => {
			rec("promptApproval")(call, label);
			return { block: true, reason: `pa:${label}` };
		}) as never,
		firstSeen: (async (call: ToolCallRequest, canonicalId: string, suggestedRule: string) => {
			rec("firstSeen")(call, canonicalId, suggestedRule);
			return { block: true, reason: `fs:${canonicalId}` };
		}) as never,
		editWriteChoice: (async (call: ToolCallRequest, path: string) => {
			rec("editWriteChoice")(call, path);
			return undefined;
		}) as never,
		classifyTier3: (async (call: ToolCallRequest, tier3: { command?: string; path?: string }) => {
			rec("classifyTier3")(call, tier3);
			return undefined;
		}) as never,
		recordAutoAllow: (() => rec("recordAutoAllow")()) as never,
		trackOutsideWrite: ((call: ToolCallRequest) => rec("trackOutsideWrite")(call)) as never,
		noteFamilyAdjudication: ((call: ToolCallRequest, outcome: "rule-allow" | "session-grant") => rec("noteFamilyAdjudication")(call, outcome)) as never,
		...overrides,
	};
	return { ports, calls };
}

const call: ToolCallRequest = { ctx: { cwd: "/w", hasUI: true }, tool: "edit", input: { path: "a.ts" } };

describe("interpretDecision dispatch", () => {
	it("allow: effects fire in order track -> family note -> denial reset; plain allow fires nothing", async () => {
		const { ports, calls } = recordingPorts();
		const out = await interpretDecision(ports, call, {
			kind: "allow",
			effects: { trackOutsideWrite: true, familyAdjudication: "rule-allow", resetAutoDenialState: true },
		});
		expect(out).toBeUndefined();
		expect(calls.map((c) => c.port)).toEqual(["trackOutsideWrite", "noteFamilyAdjudication", "recordAutoAllow"]);
		expect(calls[1]!.args[1]).toBe("rule-allow");

		const plain = recordingPorts();
		await interpretDecision(plain.ports, call, { kind: "allow", effects: {} });
		expect(plain.calls).toEqual([]);
	});

	it("deny returns the block verbatim with no port traffic", async () => {
		const { ports, calls } = recordingPorts();
		const out = await interpretDecision(ports, call, { kind: "deny", reason: "no" });
		expect(out).toEqual({ block: true, reason: "no" });
		expect(calls).toEqual([]);
	});

	it("prompt flavors reach the right port with label/category/path", async () => {
		const a = recordingPorts();
		await interpretDecision(a.ports, call, { kind: "prompt", flavor: "permission-options", label: "L", category: "permission-ask" });
		expect(a.calls).toEqual([{ port: "promptWithOptions", args: [call, "L", "permission-ask"] }]);

		const b = recordingPorts();
		await interpretDecision(b.ports, call, { kind: "prompt", flavor: "approval", label: "on a.ts" });
		expect(b.calls).toEqual([{ port: "promptApproval", args: [call, "on a.ts"] }]);

		const c = recordingPorts();
		await interpretDecision(c.ports, call, { kind: "prompt", flavor: "edit-write-choice", label: "Allow edit on a.ts?", path: "a.ts" });
		expect(c.calls).toEqual([{ port: "editWriteChoice", args: [call, "a.ts"] }]);
	});

	it("firstSeen forwards canonicalId + suggestedRule; classify forwards the risk context", async () => {
		const a = recordingPorts();
		const out = await interpretDecision(a.ports, call, { kind: "firstSeen", canonicalId: "mcp_exa_search", suggestedRule: "mcp_exa_*" });
		expect(out).toEqual({ block: true, reason: "fs:mcp_exa_search" });
		expect(a.calls[0]!.args.slice(1)).toEqual(["mcp_exa_search", "mcp_exa_*"]);

		const b = recordingPorts();
		await interpretDecision(b.ports, { ...call, tool: "bash" }, { kind: "classify", tier3: { command: "rm -rf /" } });
		expect(b.calls[0]!.args[1]).toEqual({ command: "rm -rf /" });
	});

	it("the port result (Block or allow) is returned unchanged", async () => {
		const block: BlockShape = { block: true, reason: "port said no" };
		const { ports } = recordingPorts({ promptApproval: (async () => block) as never });
		const out = await interpretDecision(ports, call, { kind: "prompt", flavor: "approval", label: "x" });
		expect(out).toBe(block);
	});
});

describe("Decision exhaustiveness (compile-time union)", () => {
	it("every Decision kind has a case (a missing kind fails compilation)", () => {
		const decisions: Decision[] = [
			{ kind: "allow", effects: {} },
			{ kind: "deny", reason: "r" },
			{ kind: "prompt", flavor: "approval", label: "l" },
			{ kind: "firstSeen", canonicalId: "c", suggestedRule: "s" },
			{ kind: "classify", tier3: {} },
		];
		expect(decisions.length).toBe(5);
	});
});
