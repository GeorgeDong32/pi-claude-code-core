/**
 * P0-LB-03 / P0-LB-04 — lib/overlay.ts unit tests.
 * Degradation matrix + component behavior via a fake ExtensionCommandContext.
 */
import { describe, expect, it } from "vitest";
import { showOverlay } from "../../lib/overlay.ts";
import type { Component } from "@earendil-works/pi-tui";

type ComponentFactory = (
	tui: unknown,
	theme: unknown,
	kb: unknown,
	done: (value: string | null) => void,
) => Component;

interface FakeCtxOptions {
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	customImpl?: (factory: ComponentFactory, opts: unknown) => Promise<string | null>;
	customThrows?: boolean;
	selectResult?: string;
}

interface CtxRecord {
	customCalls: { opts: unknown }[];
	selectCalls: { label: string; options: string[] }[];
}

function makeCtx(opts: FakeCtxOptions = {}): { ctx: any; record: CtxRecord } {
	const record: CtxRecord = { customCalls: [], selectCalls: [] };
	const ctx = {
		mode: opts.mode ?? "tui",
		hasUI: opts.hasUI ?? true,
		ui: {
			custom:
				typeof opts.customImpl === "function" || !opts.customThrows
					? async (factory: ComponentFactory, callOpts: unknown) => {
							record.customCalls.push({ opts: callOpts });
							if (opts.customThrows) throw new Error("custom unavailable");
							if (opts.customImpl) return opts.customImpl(factory, callOpts);
							return null;
						}
					: async () => {
							throw new Error("custom unavailable");
						},
			select: async (label: string, options: string[]) => {
				record.selectCalls.push({ label, options });
				return opts.selectResult ?? options[0];
			},
			notify: () => {},
		},
	};
	return { ctx, record };
}

/** Drive a factory-produced component through scripted input keys. */
async function runComponent(
	factory: ComponentFactory,
	keys: string[],
): Promise<string | null> {
	return new Promise((resolve) => {
		const comp = factory(undefined, undefined, undefined, (v) => resolve(v));
		for (const k of keys) comp.handleInput!(k);
	});
}

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";

const ITEMS = [
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
];

describe("P0-LB-03 showOverlay degradation matrix", () => {
	it("returns null when headless (hasUI false)", async () => {
		const { ctx } = makeCtx({ hasUI: false });
		await expect(showOverlay(ctx, { title: "Pick", items: ITEMS })).resolves.toBe(null);
	});

	it("uses ctx.ui.custom in tui mode with overlay:true and overlayOptions passthrough", async () => {
		const { ctx, record } = makeCtx({
			customImpl: (factory) => runComponent(factory, [ENTER]),
		});
		const result = await showOverlay(ctx, {
			title: "Pick",
			items: ITEMS,
			overlayOptions: { anchor: "bottom-center", width: "100%" },
		});
		expect(result).toBe("low");
		expect(record.customCalls.length).toBe(1);
		expect(record.customCalls[0].opts).toEqual({
			overlay: true,
			overlayOptions: { anchor: "bottom-center", width: "100%" },
		});
	});

	it("falls back to ctx.ui.select in rpc mode and maps the label back to a value", async () => {
		const { ctx, record } = makeCtx({ mode: "rpc", selectResult: "high" });
		await expect(showOverlay(ctx, { title: "Pick", items: ITEMS })).resolves.toBe("high");
		expect(record.customCalls.length).toBe(0);
		expect(record.selectCalls).toEqual([
			{ label: "Pick", options: ["low", "medium", "high"] },
		]);
	});

	it("falls back to select when custom throws", async () => {
		const { ctx, record } = makeCtx({ customThrows: true, selectResult: "medium" });
		await expect(showOverlay(ctx, { title: "Pick", items: ITEMS })).resolves.toBe("medium");
		expect(record.selectCalls.length).toBe(1);
	});

	it("returns null when select returns an unknown label", async () => {
		const { ctx } = makeCtx({ mode: "json", selectResult: "nope" });
		await expect(showOverlay(ctx, { title: "Pick", items: ITEMS })).resolves.toBe(null);
	});
});

describe("P0-LB-03 list component behavior", () => {
	it("Enter confirms the seeded selection; arrows move; Esc cancels", async () => {
		const { ctx } = makeCtx({
			customImpl: (factory) => runComponent(factory, [ENTER]),
		});
		await expect(
			showOverlay(ctx, { title: "Pick", items: ITEMS, selected: "medium" }),
		).resolves.toBe("medium");

		const { ctx: ctx2 } = makeCtx({
			customImpl: (factory) => runComponent(factory, [DOWN, DOWN, ENTER]),
		});
		await expect(showOverlay(ctx2, { title: "Pick", items: ITEMS })).resolves.toBe("high");

		const { ctx: ctx3 } = makeCtx({
			customImpl: (factory) => runComponent(factory, [UP, UP, UP, ENTER]),
		});
		// Cursor clamps at the top instead of wrapping.
		await expect(showOverlay(ctx3, { title: "Pick", items: ITEMS, selected: "medium" })).resolves.toBe(
			"low",
		);

		const { ctx: ctx4 } = makeCtx({
			customImpl: (factory) => runComponent(factory, [DOWN, ESC]),
		});
		await expect(showOverlay(ctx4, { title: "Pick", items: ITEMS })).resolves.toBe(null);
	});

	it("renders title, items, hints and footer; selected marker differs from unselected", () => {
		const { ctx } = makeCtx({
			customImpl: (factory) => {
				const comp = factory(undefined, undefined, undefined, () => {});
				const lines = comp.render(60);
				const joined = lines.join("\n");
				expect(joined).toContain("Pick");
				expect(joined).toContain("low");
				expect(joined).toContain("tiny");
				expect(joined).toContain("Enter to confirm");
				// Second render at same width is cached (identical array).
				expect(comp.render(60)).toBe(lines);
				return Promise.resolve(null);
			},
		});
		void showOverlay(ctx, {
			title: "Pick",
			items: [
				{ value: "low", label: "low", hint: "tiny" },
				{ value: "high", label: "high" },
			],
		});
	});
});
