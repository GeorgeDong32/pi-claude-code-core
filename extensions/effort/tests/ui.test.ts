/** DC2: effort presentation wrapper — the fakeable ctx.ui seam for effort. */
import test from "node:test";
import assert from "node:assert/strict";
import { createEffortUi, type EffortCtxLike } from "../ui/index.ts";

interface Calls {
	status: [string, string | undefined][];
	working: (string | undefined)[];
	notify: [string, string][];
}

function fakeCtx(over: Partial<EffortCtxLike> = {}): { ctx: EffortCtxLike; calls: Calls } {
	const calls: Calls = { status: [], working: [], notify: [] };
	const ctx: EffortCtxLike = {
		hasUI: false,
		model: null,
		ui: {
			setStatus: (k, v) => calls.status.push([k, v]),
			setWorkingMessage: (m) => calls.working.push(m),
			notify: (m, l) => calls.notify.push([m, l]),
			select: over.ui?.select ?? (async (_t: string, opts: readonly string[]) => opts[0]),
		},
		...over,
	};
	return { ctx, calls };
}

const ui = createEffortUi();

test("sync writes the three status slots and the loader line", () => {
	const { ctx, calls } = fakeCtx();
	ui.sync(ctx, "high", false, true);
	assert.deepEqual(calls.status, [
		["effort", undefined],
		["pi-effort-thinking", "think:high"],
		["pi-effort-fast", undefined],
	]);
	assert.deepEqual(calls.working, ["Working (high effort)..."]);
});

test("sync with off clears the working message", () => {
	const { ctx, calls } = fakeCtx();
	ui.sync(ctx, "off", false, true);
	assert.deepEqual(calls.working, [undefined]);
	assert.equal(calls.status.find(([k]) => k === "pi-effort-thinking")?.[1], "think:off");
});

test("sync fast flag only lands on gpt-5 models", () => {
	const gpt = fakeCtx({ model: { id: "gpt-5.2" } });
	ui.sync(gpt.ctx, "high", true, false);
	assert.equal(gpt.calls.status.find(([k]) => k === "pi-effort-fast")?.[1], "fast");

	const other = fakeCtx({ model: { id: "minimax-m3" } });
	ui.sync(other.ctx, "high", true, false);
	assert.equal(other.calls.status.find(([k]) => k === "pi-effort-fast")?.[1], undefined);
});

test("sync can skip the working message (mid-run change)", () => {
	const { ctx, calls } = fakeCtx();
	ui.sync(ctx, "high", false, false);
	assert.equal(calls.working.length, 0);
});

test("notify forwards message + level verbatim", () => {
	const { ctx, calls } = fakeCtx();
	ui.notify(ctx, "Effort changed: low -> high", "info");
	ui.notify(ctx, "pinned", "warning");
	assert.deepEqual(calls.notify, [
		["Effort changed: low -> high", "info"],
		["pinned", "warning"],
	]);
});

test("pickEffort without a TUI falls back to select", async () => {
	const { ctx } = fakeCtx(); // hasUI=false → no overlayCtx
	const result = await ui.pickEffort(ctx, ["low", "medium", "high"], "high");
	assert.deepEqual(result, { action: "select", level: "low" });
});

test("pickEffort returns null when the fallback select misses the list", async () => {
	const { ctx } = fakeCtx({
		ui: {
			setStatus: () => {},
			setWorkingMessage: () => {},
			notify: () => {},
			select: async () => "bogus",
		},
	});
	const result = await ui.pickEffort(ctx, ["low", "high"], undefined);
	assert.equal(result, null);
});
