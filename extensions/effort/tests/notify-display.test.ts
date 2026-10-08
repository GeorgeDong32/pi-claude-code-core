/**
 * Real-entry notification display regression (2026-10-08 follow-up §2).
 *
 * createEffortUi().notify is the ONLY notification path every effort
 * business call funnels through (pinned-warning, unknown level, command
 * feedback). These tests wire that real entry to the REAL capability bus
 * and the REAL display consumers, pinning: every NEW notification shows
 * exactly once, in every wiring a user can actually have.
 *
 *   core-only  — the real fallback adapter (extensions/ui/fallback.ts)
 *                owns the display; wired exactly like modes' session_start
 *                does (host.notify IS ctx.ui.notify, one recorder = one
 *                on-screen occurrence).
 *   modern TUI — cctui live declaring notificationsConsumer diffes the
 *                queue itself (mirror of the TUI core-bus client channel:
 *                attach fast-forward + id diff); nothing else may display.
 *   legacy TUI — cctui live without the declaration: the direct
 *                ctx.ui.notify leg is the display (version negotiation).
 *   headless   — no display surface; the queue still records the item.
 *
 * Identity is the queue id, never the text: two notifications with the
 * same message must BOTH display — text dedup is not an acceptable mask
 * for a dual write.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import { createFallbackAdapter } from "../../ui/fallback.ts";
import type { UiAdapter } from "../../ui/base.ts";
import { createEffortUi, type EffortCtxLike } from "../ui/index.ts";

type Display = [string, string];

const ui = createEffortUi();

const g = globalThis as Record<string, unknown>;

function setPresence(key: { active: true; notificationsConsumer?: boolean } | undefined): void {
	if (key) g.__piCcTui = key;
	else delete g.__piCcTui;
}

/** Fake pi context: every ctx.ui.notify call is one on-screen occurrence. */
function makeCtx(hasUI: boolean): { ctx: EffortCtxLike; displays: Display[] } {
	const displays: Display[] = [];
	const ctx: EffortCtxLike = {
		hasUI,
		model: null,
		ui: {
			setStatus: () => {},
			setWorkingMessage: () => {},
			notify: (m, l) => displays.push([m, l]),
			select: async () => undefined,
		},
	};
	return { ctx, displays };
}

/** Real core-only consumer, wired the way modes' session_start wires it. */
function startFallback(displays: Display[]): UiAdapter {
	const adapter = createFallbackAdapter({
		hasUI: true,
		setWorkingMessage: () => {},
		notify: (m, l) => displays.push([m, l]),
		theme: { fg: (_role, s) => s },
	});
	adapter.startup();
	return adapter;
}

/** Mirror of the modern cctui consumer: attach fast-forward + id diff. */
function attachCctuiConsumer(shown: Display[]): () => void {
	const queueNow = () => coreBus().snapshot().notifications ?? [];
	let lastSeen = queueNow().length ? queueNow()[queueNow().length - 1]!.id : 0;
	const register = coreBus().snapshot().onChange;
	const unsubscribe = register
		? register(() => {
				for (const item of queueNow()) {
					if (item.id <= lastSeen) continue;
					lastSeen = item.id;
					shown.push([item.msg, item.level]);
				}
			})
		: () => {};
	return unsubscribe;
}

function queueMsgs(): string[] {
	return (coreBus().snapshot().notifications ?? []).map((n) => n.msg);
}

test("core-only: a new effort notification displays exactly once", () => {
	resetCoreBusForTests();
	setPresence(undefined);
	try {
		const { ctx, displays } = makeCtx(true);
		const adapter = startFallback(displays);
		try {
			ui.notify(ctx, "Effort is pinned by PI_CORE_EFFORT=high; medium was not applied", "warning");
			assert.deepEqual(displays, [
				["Effort is pinned by PI_CORE_EFFORT=high; medium was not applied", "warning"],
			]);
			assert.deepEqual(queueMsgs(), ["Effort is pinned by PI_CORE_EFFORT=high; medium was not applied"]);
		} finally {
			adapter.shutdown();
		}
	} finally {
		setPresence(undefined);
		resetCoreBusForTests();
	}
});

test("core-only: same-text notifications keep displaying (id, not text, is identity)", () => {
	resetCoreBusForTests();
	setPresence(undefined);
	try {
		const { ctx, displays } = makeCtx(true);
		const adapter = startFallback(displays);
		try {
			ui.notify(ctx, "Effort changed: low -> high", "info");
			ui.notify(ctx, "Effort changed: low -> high", "info"); // repeatable warning
			assert.equal(displays.length, 2);
			assert.deepEqual(displays[0], displays[1]);
			assert.deepEqual(queueMsgs(), ["Effort changed: low -> high", "Effort changed: low -> high"]);
		} finally {
			adapter.shutdown();
		}
	} finally {
		setPresence(undefined);
		resetCoreBusForTests();
	}
});

test("modern TUI consumer: queue-only display, no direct write", () => {
	resetCoreBusForTests();
	setPresence({ active: true, notificationsConsumer: true });
	try {
		const { ctx, displays } = makeCtx(true);
		const adapter = startFallback(displays); // core still wires it; it must yield
		const cctui: Display[] = [];
		const detach = attachCctuiConsumer(cctui);
		try {
			ui.notify(ctx, "Effort changed: low -> high", "info");
			assert.deepEqual(cctui, [["Effort changed: low -> high", "info"]]);
			assert.deepEqual(displays, []); // neither the fallback nor a direct write
		} finally {
			detach();
			adapter.shutdown();
		}
	} finally {
		setPresence(undefined);
		resetCoreBusForTests();
	}
});

test("legacy TUI (no notificationsConsumer): direct leg displays once, fallback yields", () => {
	resetCoreBusForTests();
	setPresence({ active: true });
	try {
		const { ctx, displays } = makeCtx(true);
		const adapter = startFallback(displays);
		try {
			ui.notify(ctx, "Effort changed: low -> high", "info");
			assert.deepEqual(displays, [["Effort changed: low -> high", "info"]]);
			assert.deepEqual(queueMsgs(), ["Effort changed: low -> high"]);
		} finally {
			adapter.shutdown();
		}
	} finally {
		setPresence(undefined);
		resetCoreBusForTests();
	}
});

test("headless: no display surface, queue still records", () => {
	resetCoreBusForTests();
	setPresence(undefined);
	try {
		const { ctx, displays } = makeCtx(false);
		ui.notify(ctx, "Effort is pinned by PI_CORE_EFFORT=high", "warning");
		assert.deepEqual(displays, []);
		assert.deepEqual(queueMsgs(), ["Effort is pinned by PI_CORE_EFFORT=high"]);
	} finally {
		setPresence(undefined);
		resetCoreBusForTests();
	}
});

test("handover: cctui off mid-session — the next notification displays once, no history replay", () => {
	resetCoreBusForTests();
	setPresence({ active: true, notificationsConsumer: true });
	try {
		const { ctx, displays } = makeCtx(true);
		const adapter = startFallback(displays);
		const cctui: Display[] = [];
		const detach = attachCctuiConsumer(cctui);
		try {
			ui.notify(ctx, "while the TUI owns the screen", "info");
			assert.deepEqual(cctui, [["while the TUI owns the screen", "info"]]);
			assert.deepEqual(displays, []);

			// /claude-tui off: the TUI clears its presence key AND detaches
			// its bus subscription; the fallback re-owns the display.
			detach();
			setPresence(undefined);
			ui.notify(ctx, "after the TUI stepped away", "info");
			assert.deepEqual(displays, [["after the TUI stepped away", "info"]]); // once, no replay of the first
		} finally {
			detach();
			adapter.shutdown();
		}
	} finally {
		setPresence(undefined);
		resetCoreBusForTests();
	}
});

test("handover: legacy cctui off — fallback picks up the next notification once", () => {
	resetCoreBusForTests();
	setPresence({ active: true });
	try {
		const { ctx, displays } = makeCtx(true);
		const adapter = startFallback(displays);
		try {
			ui.notify(ctx, "legacy leg shows me", "info");
			assert.deepEqual(displays, [["legacy leg shows me", "info"]]);

			setPresence(undefined);
			ui.notify(ctx, "fallback shows me next", "info");
			assert.deepEqual(displays, [
				["legacy leg shows me", "info"],
				["fallback shows me next", "info"],
			]);
		} finally {
			adapter.shutdown();
		}
	} finally {
		setPresence(undefined);
		resetCoreBusForTests();
	}
});
