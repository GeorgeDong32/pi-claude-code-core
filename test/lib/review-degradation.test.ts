/**
 * P2-REV-03 — pi-subagents degradation path (red-green).
 *
 * Without the `subagent` tool: /review must fail fast with the install
 * hint (one-time notify) and NOT inject a review directive. All other core
 * functionality is unaffected. With the tool present, /review proceeds
 * past the gate.
 */
import { describe, expect, it, beforeEach } from "vitest";

import {
	FakeHost,
	clearCoreGlobals,
	restoreCoreGlobals,
	snapshotCoreGlobals,
} from "../contracts/fake-host.ts";
import { targets } from "../contracts/targets.ts";

let globalsSnapshot: Record<string, unknown>;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
});

function makeReviewHost(): FakeHost {
	const host = new FakeHost();
	targets.review.factory(host.asPi());
	return host;
}

async function runReview(host: FakeHost, ctx: Record<string, unknown>, args = ""): Promise<void> {
	const handler = host.commands.get("review");
	if (!handler) throw new Error("review command not registered");
	await handler(args, ctx);
}

describe("P2-REV-03 pi-subagents degradation", () => {
	it("without the subagent tool, /review refuses with the install hint and no directive", async () => {
		const host = makeReviewHost(); // toolInfos empty → subagent missing
		const ctx = host.makeCtx({ cwd: process.cwd(), ui: true });
		await host.fire("session_start", {}, ctx);

		await runReview(host, ctx);

		const directive = host.sentMessages.find(
			(m) => m.message.customType === "pi-review-directive",
		);
		expect(directive).toBeUndefined();
		const warned = host.notifications.filter((n) => n.includes("pi-subagents"));
		expect(warned.length).toBeGreaterThan(0);
		expect(warned[0]).toContain("pi install npm:pi-subagents");
	});

	it("the degradation notice is shown at most once, later calls still refuse", async () => {
		const host = makeReviewHost();
		const ctx = host.makeCtx({ cwd: process.cwd(), ui: true });
		await host.fire("session_start", {}, ctx);
		await runReview(host, ctx);
		await runReview(host, ctx);

		// install hint exactly once; the skip error on every refused call
		const hints = host.notifications.filter((n) => n.includes("pi install npm:pi-subagents"));
		expect(hints.length).toBe(1);
		const skips = host.notifications.filter((n) => n.includes("review skipped"));
		expect(skips.length).toBe(2);
		// still no directive on either call
		expect(
			host.sentMessages.filter((m) => m.message.customType === "pi-review-directive"),
		).toHaveLength(0);
	});

	it("with the subagent tool present, /review proceeds past the gate", async () => {
		const host = makeReviewHost();
		host.toolInfos.push({
			name: "subagent",
			sourceInfo: { path: "pi-subagents", source: "pi-subagents", scope: "user", origin: "top-level" },
		});
		const ctx = host.makeCtx({ cwd: process.cwd(), ui: true });
		await host.fire("session_start", {}, ctx);

		await runReview(host, ctx);
		// past the gate: no degradation warning; the run may end in "nothing
		// to review" or a dry-run echo, but never the install hint
		expect(host.notifications.filter((n) => n.includes("pi install npm:pi-subagents"))).toHaveLength(0);
	});
});
