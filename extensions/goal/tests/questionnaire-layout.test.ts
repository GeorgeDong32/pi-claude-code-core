// Spec: 2026-10-01 goal-dialog-scroll (GDS-01 table tests + component
// red/green tests for GDS-02..05). Pure layout math is pinned by tables;
// the component tests pin (a) byte-identity of short-content rendering
// except the intended selected-row highlight, (b) overflow slicing with a
// pinned header/footer, (c) key routing for ctrl+u/ctrl+d and PageUp/
// PageDown, (d) the ≤7-row footer option window.
import assert from "node:assert/strict";
import test from "node:test";

import {
	availableDialogHeight,
	clampScrollOffset,
	optionWindow,
	pickTerminalHeight,
	planDialogLayout,
	scrollIndicatorLine,
	scrollStep,
	sliceScrollWindow,
} from "../questionnaire-layout.ts";
import { runGoalQuestionnaire, type GoalQuestionnaireQuestion } from "../goal-questionnaire.ts";

test("pickTerminalHeight prefers tui rows, then stdout rows, then the 24-row default", () => {
	const cases: Array<[Array<number | undefined>, number]> = [
		[[45, 30], 45],
		[[undefined, 30], 30],
		[[0, 30], 30],
		[[undefined, 0], 24],
		[[undefined, undefined], 24],
	];
	for (const [candidates, expected] of cases) {
		assert.equal(pickTerminalHeight(candidates), expected, `candidates ${JSON.stringify(candidates)}`);
	}
});

test("availableDialogHeight reserves 6 rows and never exceeds the terminal height", () => {
	const cases: Array<[number, number]> = [
		[50, 44],
		[24, 18],
		[10, 4],
		[6, 0],
	];
	for (const [rows, expected] of cases) {
		assert.equal(availableDialogHeight(rows), expected, `rows ${rows}`);
	}
});

test("clampScrollOffset pins the offset to the last full viewport", () => {
	const cases: Array<[number, number, number, number]> = [
		[0, 40, 10, 0],
		[50, 40, 10, 30],
		[-3, 40, 10, 0],
		[35, 40, 10, 30],
		[3, 5, 10, 0],
		[7, 5, 0, 5], // 0 viewport: body is empty regardless; offset floors at max(0, total - viewport)
	];
	for (const [offset, total, viewport, expected] of cases) {
		assert.equal(clampScrollOffset(offset, total, viewport), expected, `offset ${offset} total ${total} viewport ${viewport}`);
	}
});

test("scrollStep derives half-page and full-page steps with a floor of 1", () => {
	const cases: Array<[number, "half" | "page", number]> = [
		[10, "half", 5],
		[3, "half", 1],
		[1, "half", 1],
		[0, "half", 1],
		[10, "page", 10],
		[0, "page", 1],
	];
	for (const [viewport, mode, expected] of cases) {
		assert.equal(scrollStep(viewport, mode), expected, `viewport ${viewport} ${mode}`);
	}
});

test("sliceScrollWindow cuts a full viewport from the clamped offset", () => {
	const lines = Array.from({ length: 42 }, (_, i) => `L${i + 1}`);
	assert.deepEqual(sliceScrollWindow(lines, 0, 18), lines.slice(0, 18));
	assert.deepEqual(sliceScrollWindow(lines, 24, 18), lines.slice(24, 42));
	assert.deepEqual(sliceScrollWindow(lines, 999, 18), lines.slice(24, 42), "oversized offset clamps to the last page");
	assert.deepEqual(sliceScrollWindow(lines, 0, 50), lines, "fits → passthrough");
});

test("scrollIndicatorLine reports the visible range only while overflowing", () => {
	assert.equal(scrollIndicatorLine(0, 42, 18), "(lines 1–18 of 42 · ctrl+u/ctrl+d to scroll)");
	assert.equal(scrollIndicatorLine(24, 42, 18), "(lines 25–42 of 42 · ctrl+u/ctrl+d to scroll)");
	assert.equal(scrollIndicatorLine(0, 18, 18), null, "no overflow → no indicator");
	assert.equal(scrollIndicatorLine(0, 42, 0), null, "degenerate viewport → no indicator");
});

test("optionWindow keeps the selected row visible within max 7 rows", () => {
	const cases: Array<[number, number, { start: number; shown: number; hidden: number }]> = [
		[2, 1, { start: 0, shown: 2, hidden: 0 }],
		[7, 6, { start: 0, shown: 7, hidden: 0 }],
		[0, 0, { start: 0, shown: 0, hidden: 0 }],
		[10, 0, { start: 0, shown: 7, hidden: 3 }],
		[10, 4, { start: 1, shown: 7, hidden: 3 }],
		[10, 9, { start: 3, shown: 7, hidden: 3 }],
		[8, 7, { start: 1, shown: 7, hidden: 1 }],
	];
	for (const [count, selected, expected] of cases) {
		const win = optionWindow(count, selected);
		assert.deepEqual(win, expected, `count ${count} selected ${selected}`);
		if (win.shown > 0) {
			assert.ok(win.start <= selected && selected < win.start + win.shown, `selected row visible: ${JSON.stringify(win)}`);
		}
	}
});

test("planDialogLayout passes short bodies through and slices overflowing ones", () => {
	const header = ["H1", "H2", "H3"];
	const footer = ["F1", "F2", "F3", "F4", "F5", "F6"];
	const body5 = ["B1", "B2", "B3", "B4", "B5"];
	const body42 = Array.from({ length: 42 }, (_, i) => `B${i + 1}`);

	const fit = planDialogLayout({ header, body: body5, footer }, { availableHeight: 20, scrollOffset: 0 });
	assert.equal(fit.overflow, false);
	assert.equal(fit.indicator, null);
	assert.deepEqual(fit.visibleBody, body5);
	assert.equal(fit.totalHeight, 14);

	const over = planDialogLayout({ header, body: body42, footer }, { availableHeight: 20, scrollOffset: 0 });
	assert.equal(over.overflow, true);
	assert.equal(over.viewport, 10);
	assert.equal(over.indicator, "(lines 1–10 of 42 · ctrl+u/ctrl+d to scroll)");
	assert.deepEqual(over.visibleBody, body42.slice(0, 10));
	assert.equal(over.totalHeight, 20);

	const tail = planDialogLayout({ header, body: body42, footer }, { availableHeight: 20, scrollOffset: 999 });
	assert.deepEqual(tail.visibleBody, body42.slice(32), "offset clamps to the last page");
	assert.equal(tail.indicator, "(lines 33–42 of 42 · ctrl+u/ctrl+d to scroll)");

	const resized = planDialogLayout({ header, body: body42, footer }, { availableHeight: 60, scrollOffset: 9 });
	assert.equal(resized.overflow, false, "taller terminal (resize) → fits again");
	assert.deepEqual(resized.visibleBody, body42);

	const tiny = planDialogLayout({ header, body: body42, footer }, { availableHeight: 8, scrollOffset: 0 });
	assert.equal(tiny.overflow, true);
	assert.equal(tiny.viewport, 0, "header+footer alone eat the budget");
	assert.equal(tiny.indicator, null);
	assert.deepEqual(tiny.visibleBody, []);
});

// ---- component tests (GDS-02..05) -----------------------------------------

interface TestComponent {
	render(width: number): string[];
	handleInput(data: string): void;
}

const SEP = "─".repeat(60);

// add()-routed lines are padded to the full width by truncateToWidth(pad=true)
// — the legacy behavior the byte-identity criterion pins. All test strings
// below are single-width BMP so .length == visible width.
const pad = (s: string) => s.padEnd(60);

async function mountQuestionnaire(
	questions: GoalQuestionnaireQuestion[],
	terminalRows: number,
	theme?: {
		fg: (key: string, s: string) => string;
		bg: (key: string, s: string) => string;
		bold: (s: string) => string;
	},
): Promise<TestComponent> {
	let comp: TestComponent | undefined;
	// fakeTui: pi-tui TUI instance shape the component reads (terminal.rows
	// for GDS-05) + the requestRender Editor needs.
	const fakeTui = { terminal: { rows: terminalRows }, requestRender: () => {} };
	const identityTheme = {
		fg: (_key: string, s: string) => s,
		bg: (_key: string, s: string) => s,
		bold: (s: string) => s,
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async (factory: (t: unknown, th: unknown, kb: unknown, done: (v: unknown) => void) => TestComponent) => {
				comp = factory(fakeTui, theme ?? identityTheme, undefined, () => {});
				return null;
			},
		},
	} as never;
	const result = await runGoalQuestionnaire(ctx, questions);
	assert.equal(result, null, "stubbed custom resolves null (cancel path)");
	assert.ok(comp, "component mounted");
	return comp;
}

test("short dialog renders byte-identical except the selected-row highlight (golden)", async () => {
	const comp = await mountQuestionnaire([{
		id: "confirm",
		question: "Confirm Goal Draft",
		context: "L1\nL2",
		options: ["Confirm — create this goal now", "Continue chatting — keep refining"],
		recommended: 0,
		allowCustom: false,
	}], 30);
	assert.deepEqual(comp.render(60), [
		SEP,
		" Confirm Goal Draft",
		" L1",
		" L2",
		"",
		// intended visual delta (GDS-04): selected row = bg(selectedBg,
		// fg(text, " ❯ N. label ")) — with the identity theme stub only the
		// ❯ marker shows; every other line matches the legacy layout byte
		// for byte (add()-routed lines included, which truncateToWidth pads
		// to the full width).
		pad(" ❯ 1. Confirm — create this goal now  ★"),
		pad("  2. Continue chatting — keep refining"),
		"",
		pad(" ↑↓ navigate • Enter select • Esc cancel"),
		SEP,
	]);
});

test("multi-question tab bar stays byte-stable for short content", async () => {
	const comp = await mountQuestionnaire([
		{ id: "a", question: "First?", context: "C1", options: ["A1", "A2"], allowCustom: false },
		{ id: "b", question: "Second?", options: ["B1"], allowCustom: false },
	], 30);
	assert.deepEqual(comp.render(60), [
		SEP,
		pad(" ←  □ a   □ b   ✓ Submit  →"),
		"",
		" First?",
		" C1",
		"",
		pad(" ❯ 1. A1"),
		pad("  2. A2"),
		"",
		pad(" Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"),
		SEP,
	]);
});

test("selected option row is wrapped in selectedBg (intended visual delta)", async () => {
	const comp = await mountQuestionnaire([{
		id: "confirm",
		question: "Confirm Goal Draft",
		context: "L1",
		options: ["Confirm — create this goal now", "Continue chatting — keep refining"],
		recommended: 0,
		allowCustom: false,
	}], 30, {
		fg: (_key: string, s: string) => s,
		bg: (key: string, s: string) => `<bg:${key}>${s}</bg>`,
		bold: (s: string) => s,
	});
	const lines = comp.render(60);
	const selected = lines.find((l) => l.includes("❯ 1."));
	assert.ok(selected, "selected row rendered");
	assert.equal(selected, pad("<bg:selectedBg> ❯ 1. Confirm — create this goal now </bg> ★"), "recommended ★ kept outside the bg span");
	assert.equal(lines.find((l) => l.includes("2. Continue")), pad("  2. Continue chatting — keep refining"), "unselected rows keep the legacy prefix");
});

test("long context scrolls while header, indicator and pinned footer stay put", async () => {
	const context = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join("\n");
	const comp = await mountQuestionnaire([{
		id: "confirm",
		question: "Confirm Goal Draft",
		context,
		options: ["Confirm — create this goal now", "Continue chatting — keep refining"],
		recommended: 0,
		allowCustom: false,
	}], 20); // available = min(20-6, 20) = 14
	let lines = comp.render(60);
	// header 2 (sep + question) + indicator 1 + body 5 + footer 6 = 14
	assert.equal(lines.length, 14, "rendered height never exceeds the available height");
	assert.equal(lines[0], SEP);
	assert.equal(lines[1], " Confirm Goal Draft");
	assert.equal(lines[2], "(lines 1–5 of 40 · ctrl+u/ctrl+d to scroll)");
	assert.deepEqual(lines.slice(3, 8), [" Line 1", " Line 2", " Line 3", " Line 4", " Line 5"]);
	assert.equal(lines[8], SEP, "pinned footer separator");
	assert.ok(lines[9].includes("❯ 1. Confirm — create this goal now"));
	assert.ok(lines[10].includes("2. Continue chatting — keep refining"));
	assert.equal(lines[11], "");
	assert.equal(lines[12], pad(" ↑↓ navigate • Enter select • Esc cancel"));
	assert.equal(lines[13], SEP);

	// ctrl+d (0x04): half page = ⌊5/2⌋ = 2
	comp.handleInput("\x04");
	lines = comp.render(60);
	assert.equal(lines[2], "(lines 3–7 of 40 · ctrl+u/ctrl+d to scroll)");
	assert.deepEqual(lines.slice(3, 8), [" Line 3", " Line 4", " Line 5", " Line 6", " Line 7"]);

	// PageDown (\x1b[6~): full page = 5
	comp.handleInput("\x1b[6~");
	lines = comp.render(60);
	assert.equal(lines[2], "(lines 8–12 of 40 · ctrl+u/ctrl+d to scroll)");
	assert.deepEqual(lines.slice(3, 8), [" Line 8", " Line 9", " Line 10", " Line 11", " Line 12"]);

	// ctrl+u (0x15): half page back up
	comp.handleInput("\x15");
	lines = comp.render(60);
	assert.equal(lines[2], "(lines 6–10 of 40 · ctrl+u/ctrl+d to scroll)");

	// PageUp (\x1b[5~) beyond the top clamps to offset 0
	comp.handleInput("\x1b[5~");
	lines = comp.render(60);
	assert.equal(lines[2], "(lines 1–5 of 40 · ctrl+u/ctrl+d to scroll)");

	// repeated PageDown clamps at the last full page; options stay pinned
	for (let i = 0; i < 20; i++) comp.handleInput("\x1b[6~");
	lines = comp.render(60);
	assert.equal(lines[2], "(lines 36–40 of 40 · ctrl+u/ctrl+d to scroll)");
	assert.deepEqual(lines.slice(3, 8), [" Line 36", " Line 37", " Line 38", " Line 39", " Line 40"]);
	assert.equal(lines.length, 14);
	assert.ok(lines[9].includes("❯ 1. Confirm — create this goal now"), "options pinned at the bottom in every scroll position");
	assert.equal(lines[13], SEP);
});

test("scrolling does not change existing ↑↓/Enter/Esc semantics", async () => {
	const context = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join("\n");
	const comp = await mountQuestionnaire([{
		id: "confirm",
		question: "Confirm Goal Draft",
		context,
		options: ["Confirm — create this goal now", "Continue chatting — keep refining"],
		recommended: 0,
		allowCustom: false,
	}], 20);
	// ↑ (0x1b[A) moves the selection, not the scroll offset.
	comp.handleInput("\x1b[A");
	let lines = comp.render(60);
	assert.equal(lines[2], "(lines 1–5 of 40 · ctrl+u/ctrl+d to scroll)", "offset untouched");
	assert.ok(lines[10].includes("2. Continue chatting — keep refining"), "selection unchanged at the top");
	// ↓ (0x1b[B) moves the selection marker within the pinned footer.
	comp.handleInput("\x1b[B");
	lines = comp.render(60);
	assert.ok(lines[10].includes("❯ 2. Continue chatting — keep refining"), "selection moved to option 2");
	// Esc still cancels the dialog (submit(true) → done).
	let finished: unknown = "unset";
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async (factory: (t: unknown, th: unknown, kb: unknown, done: (v: unknown) => void) => TestComponent) => {
				const comp2 = factory({ terminal: { rows: 20 }, requestRender: () => {} }, {
					fg: (_k: string, s: string) => s,
					bg: (_k: string, s: string) => s,
					bold: (s: string) => s,
				}, undefined, (v: unknown) => { finished = v; });
				comp2.handleInput("\x1b");
				return null;
			},
		},
	} as never;
	await runGoalQuestionnaire(ctx, [{
		id: "confirm",
		question: "Confirm Goal Draft",
		context: "L1",
		options: ["Confirm — create this goal now", "Continue chatting — keep refining"],
		allowCustom: false,
	}]);
	assert.deepEqual(finished, {
		questions: [{ id: "confirm", question: "Confirm Goal Draft", context: "L1", options: ["Confirm — create this goal now", "Continue chatting — keep refining"], recommended: undefined, allowCustom: false }],
		answers: [],
		cancelled: true,
	}, "Esc cancels");
});

test("option lists longer than seven rows get a footer window with (+N more)", async () => {
	const options = Array.from({ length: 10 }, (_, i) => `Option ${i + 1}`);
	const comp = await mountQuestionnaire([{
		id: "pick",
		question: "Pick one",
		context: "ctx",
		options,
		recommended: 0,
		allowCustom: false,
	}], 40);
	let lines = comp.render(60);
	const optionLines = lines.filter((l) => /Option \d+/.test(l));
	assert.equal(optionLines.length, 7, "window caps at 7 rows");
	assert.ok(optionLines[0].includes("❯ 1. Option 1"), "selected row visible");
	assert.ok(!optionLines.some((l) => l.includes("Option 8")), "tail options hidden");
	const hint = lines.find((l) => l.includes("↑↓ navigate"));
	assert.ok(hint?.includes("(+3 more)"), `hint reports hidden options: ${hint}`);
	// ↓×9 moves the selection to the last option; the window follows.
	for (let i = 0; i < 9; i++) comp.handleInput("\x1b[B");
	lines = comp.render(60);
	const moved = lines.filter((l) => /Option \d+/.test(l));
	assert.equal(moved.length, 7);
	assert.ok(moved.some((l) => l.includes("❯ 10. Option 10")), "selection stays visible after the window slides");
	assert.ok(!moved.some((l) => /Option 1\b/.test(l)), "head options hidden (Option 1, not the 10 prefix)");
});

test("inputMode keeps the editor pinned while the context scrolls", async () => {
	const context = Array.from({ length: 30 }, (_, i) => `C${i + 1}`).join("\n");
	const comp = await mountQuestionnaire([{
		id: "notes",
		question: "Notes?",
		context,
		options: [],
		allowCustom: true,
	}], 30); // available = 24
	const lines = comp.render(60);
	assert.equal(lines.length, 24, "inputMode also respects the height budget");
	assert.equal(lines[0], SEP);
	assert.equal(lines[1], " Notes?");
	assert.ok(lines[2].includes("of 30"), `scroll indicator present: ${lines[2]}`);
	assert.ok(lines[3].startsWith(" C1"), "body starts at offset 0");
	const editorRow = lines.findIndex((l) => l.includes("Your answer:"));
	assert.ok(editorRow > 3, "editor block pinned in the footer");
	assert.ok(lines[lines.length - 3].includes("Enter to submit"), "inputMode hint pinned (blank + separator follow it)");
	assert.equal(lines[lines.length - 1], SEP);
});
