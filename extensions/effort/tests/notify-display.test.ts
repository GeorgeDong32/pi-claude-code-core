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
			ui.notify(ctx, "Effort changed: low -> high", "info");
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
		const adapter = startFallback(displays);
		const cctui: Display[] = [];
		const detach = attachCctuiConsumer(cctui);
		try {
			ui.notify(ctx, "Effort changed: low -> high", "info");
			assert.deepEqual(cctui, [["Effort changed: low -> high", "info"]]);
			assert.deepEqual(displays, []);
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

			detach();
			setPresence(undefined);
			ui.notify(ctx, "after the TUI stepped away", "info");
			assert.deepEqual(displays, [["after the TUI stepped away", "info"]]);
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
