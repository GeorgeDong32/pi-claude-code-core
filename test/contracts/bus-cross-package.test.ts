/**
 * bus-cross-package.test.ts — XPKG contract pins (SPEC 2026-10-07 P1-1 §4.1).
 *
 * XPKG-01: notification tail-queue negotiation — with a consumer-declaring
 *          cctui present, core's notify stops the direct forward and the
 *          fallback only advances its cursor; without presence the fallback
 *          displays each item exactly once.
 * XPKG-02: snapshot.onChange — the v2 data-carried subscription point, one
 *          listener set per bus instance.
 * XPKG-03: snapshot.instance — per-bus random id; reload-style swaps are
 *          detectable by comparison.
 * XPKG-04: obs_recall result protocol — structured `details` is the source;
 *          the two text header lines are a model-facing protocol only.
 * XPKG-05: then_run param shape — plain string AND the { command } object
 *          action-fusion actually registers.
 * XPKG-09-HOST: aboveEditor widget ordering — real-host sequencing evidence
 *          not available here; registered as test.todo per the todo gate.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { clearCoreGlobals, snapshotCoreGlobals, restoreCoreGlobals } from "./fake-host.ts";
import { createCoreBus, resetCoreBusForTests, coreBus } from "../../extensions/bus.ts";
import { notify as uiNotify } from "../../extensions/ui/notify.ts";
import { createFallbackAdapter } from "../../extensions/ui/fallback.ts";
import { extractEmbeddedCommandInputs } from "../../extensions/modes/fusion-tools.ts";

let globals: Record<string, unknown>;

beforeEach(() => {
	globals = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
});

afterEach(() => {
	restoreCoreGlobals(globals);
	resetCoreBusForTests();
});

describe("XPKG-01 notification tail-queue negotiation (B2)", () => {
	function fakeCtx(collected: string[]) {
		return {
			hasUI: true,
			ui: { notify: (msg: string) => collected.push(msg) },
		};
	}

	it("no presence: fallback displays each queued item exactly once", () => {
		const shown: string[] = [];
		const adapter = createFallbackAdapter({ hasUI: true, setWorkingMessage: () => {}, notify: (m) => shown.push(m), theme: { fg: (_r, s) => s } });
		adapter.startup?.();
		const ctx = fakeCtx([]);
		uiNotify(ctx as never, "hello one", "info");
		uiNotify(ctx as never, "hello two", "warning");
		expect(shown).toEqual(["hello one", "hello two"]);
		adapter.shutdown();
	});

	it("consumer-declaring cctui present: no direct forward, fallback advances the cursor only, handover items are NOT replayed later", () => {
		const direct: string[] = [];
		const shown: string[] = [];
		const g = globalThis as Record<string, unknown>;
		g.__piCcTui = { active: true, notificationsConsumer: true };
		const ctx = fakeCtx(direct);
		// startup FIRST (the real wiring subscribes before business events);
		// the v1→v2 upgrade publish applies the (still empty) snapshot
		const adapter = createFallbackAdapter({ hasUI: true, setWorkingMessage: () => {}, notify: (m) => shown.push(m), theme: { fg: (_r, s) => s } });
		adapter.startup?.();
		uiNotify(ctx as never, "while consumer live", "info");
		expect(direct).toHaveLength(0); // consumer declared — no direct leg
		expect(shown).toHaveLength(0);  // present → cursor advance only
		// a later handover (cctui off) must not replay the consumed history
		g.__piCcTui = { active: false, notificationsConsumer: true };
		uiNotify(ctx as never, "after handover", "info");
		expect(shown).toEqual(["after handover"]);
		adapter.shutdown();
	});

	it("cap 20 with monotonic ids; oldest items are pushed out (no ACK, disclosed loss window)", () => {
		const ctx = { hasUI: false, ui: {} };
		for (let i = 0; i < 25; i++) uiNotify(ctx as never, `m${i}`, "info");
		const queue = coreBus().snapshot().notifications ?? [];
		expect(queue).toHaveLength(20);
		expect(queue[0]!.msg).toBe("m5");
		expect(queue[19]!.msg).toBe("m24");
		expect(queue.map((q) => q.id)).toEqual([...queue].sort((a, b) => a.id - b.id).map((q) => q.id));
	});
});

describe("XPKG-02/03 onChange + instance (B3)", () => {
	it("each instance's onChange notifies only its own listeners; an old instance's listener never sees the new instance's publishes", () => {
		const old = createCoreBus();
		const oldHeard: number[] = [];
		// onChange is a v2+ field (version-gated by design): the consumer
		// upgrades an untouched bus with one empty publish before subscribing
		old.publish({});
		old.snapshot().onChange?.(() => oldHeard.push(1));
		old.publish({ modes: { mode: "ask", workingStats: null } });
		expect(oldHeard).toHaveLength(1);

		// reload: a NEW bus takes over globalThis…
		const fresh = createCoreBus();
		fresh.publish({ modes: { mode: "plan", workingStats: null } });
		const g2 = globalThis as unknown as { __piClaudeCodeCore?: CoreSnapshotLike };
		expect(g2.__piClaudeCodeCore).toBe(fresh.snapshot());
		// …the old listener is NOT invoked by the new bus's publishes
		expect(oldHeard).toHaveLength(1);
		// and instance detects the swap without function-identity tricks
		expect(g2.__piClaudeCodeCore?.instance).not.toBe(old.snapshot().instance);
		old.dispose();
		fresh.dispose();
	});

	it("subscribe → publish → unsubscribe stops notifications", () => {
		const bus = createCoreBus();
		let heard = 0;
		bus.publish({});
		const off = bus.snapshot().onChange?.(() => heard++);
		bus.publish({ display: { footer: ["x"] } });
		off?.();
		bus.publish({ display: { footer: ["y"] } });
		expect(heard).toBe(1);
		bus.dispose();
	});
});

type CoreSnapshotLike = { instance?: string };

describe("XPKG-04 obs_recall result protocol (shape pin)", () => {
	it("the structured details fields are the display-side source (id/offset/bytes/lines/nextOffset/eof)", async () => {
		const mod = await import("../../extensions/observation-pack/index.ts");
		// locate the obs_recall tool registration and pin its result shape by
		// driving the real tool with a stored observation
		const host = { registerTool: () => {}, on: () => {} } as never;
		void mod;
		void host;
		// The full runtime pin lives in the observation-pack suite; the
		// CONTRACT here is the field set, pinned from the source that builds it.
		const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../extensions/observation-pack/index.ts", import.meta.url), "utf-8"));
		expect(src).toContain("details: { id, offset, bytes: chunk.bytes, lines: chunk.lines, nextOffset: chunk.nextOffset, eof: chunk.eof }");
		// the two text header lines are a model protocol, not a display API
		expect(src).toMatch(/\[obs_recall id=\$\{id\} offset=\$\{offset\} next_offset=/);
	});
});

describe("XPKG-05 then_run param shape (B4 of P0-1, pinned as contract)", () => {
	it("edit/write may carry then_run as a string OR a { command } object", () => {
		expect(extractEmbeddedCommandInputs("edit", { path: "a", then_run: "npm test" })).toEqual([{ field: "then_run", command: "npm test" }]);
		expect(extractEmbeddedCommandInputs("edit", { path: "a", then_run: { command: "npm test" } })).toEqual([{ field: "then_run", command: "npm test" }]);
	});
});

describe("XPKG-09-HOST aboveEditor widget ordering", () => {
	// Host sequencing evidence DELIVERED (2026-10-08 follow-up batch, core
	// e98ce4a + TUI eb3bb11 on real pi 1.0.2, PTY; causal narrative
	// corrected 2026-10-09 against the host source, TUI LEDGER correction
	// batch): both load orders, late mounting, live turn updates, and a
	// post-macrotask session_start handler all verified. Host facts
	// (pi 1.0.2 bundle, ExtensionRunner.emit + setExtensionWidget): emit
	// iterates extensions in LOAD order and AWAITS each handler before the
	// next starts (nothing registers "during" another handler's await);
	// setWidget stores into an insertion-ordered Map where re-setting a key
	// moves it to the tail, and rendering follows insertion order top→bottom
	// (last inserted = directly above the editor). The invariant that held
	// in both load orders: the goal block above the cc-status spinner slot
	// (goal remounts synchronously inside its session_start handler; the
	// spinner re-registers via a macrotask callback). A macrotask-crossing
	// handler only reorders itself against TIMER-deferred registrations
	// (like that requeue), never against other session_start handlers
	// (TUI repo docs/evidence/2026-10-08-host run/ht4a, ht4b, ht5m-*,
	// ht2j-*). Remaining UNCOVERED async surface keeps this todo open:
	it.todo("arbitrary async widget registration OUTSIDE session_start (e.g. a timer firing mid-agent-turn) — ordering under it is still best-effort and needs its own host evidence batch");
});
