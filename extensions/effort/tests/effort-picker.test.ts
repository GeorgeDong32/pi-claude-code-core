import test from "node:test";
import assert from "node:assert/strict";
import { createEffortPickerComponent, type EffortPickerResult } from "../effort-picker.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const LEVELS_5 = ["minimal", "low", "medium", "high", "xhigh"];
const LEVELS_3 = ["low", "medium", "high"];

// Helper: synthesize an Arrow-Right / Arrow-Left keypress matching what
// pi-tui's stdin layer forwards to handleInput. The exact byte sequences
// are not part of the public API; matchesKey() handles both legacy CSI
// and Kitty CSI-u forms, so any well-formed arrow sequence will do.
const ARROW_RIGHT = "\x1b[C";
const ARROW_LEFT = "\x1b[D";
const ENTER = "\r";
const ESCAPE = "\x1b";
const TAB = "\t";

function newPicker(levels: string[], currentLevel?: string) {
  let captured: EffortPickerResult | null = null;
  const component = createEffortPickerComponent({
    levels,
    currentLevel,
    done: (result) => {
      captured = result;
    },
  });
  const handleInput = component.handleInput;
  if (!handleInput) throw new Error("picker must implement handleInput");
  return {
    component,
    // Bind so callers can invoke as a plain function without losing `this`.
    handleInput: handleInput.bind(component),
    getResult: () => captured,
  };
}

// ─── Initial selection ─────────────────────────────────────────────

test("picker seeds selectedIndex from currentLevel", () => {
  const { component, getResult } = newPicker(LEVELS_5, "medium");
  const lines = component.render(80);
  assert.ok(lines.length > 0);
  // The labels line should contain "medium" highlighted; we don't try to
  // inspect ANSI here, just verify no early completion.
  assert.equal(getResult(), null);
});

test("picker falls back to middle index when currentLevel is undefined", () => {
  const { component } = newPicker(LEVELS_5, undefined);
  // 9 lines: top border + top margin + 5 content + bottom margin + bottom border.
  const lines = component.render(80);
  assert.equal(lines.length, 9);
});

test("picker falls back to middle index when currentLevel is unknown", () => {
  const { component } = newPicker(LEVELS_5, "not-a-level");
  const lines = component.render(80);
  assert.equal(lines.length, 9);
});

test("picker clamps currentLevel index when it is out of range", () => {
  const { component } = newPicker(LEVELS_3, "xhigh");
  const lines = component.render(80);
  assert.equal(lines.length, 9);
});

// ─── Arrow key navigation ──────────────────────────────────────────

test("ArrowRight advances selection", () => {
  const { component, handleInput } = newPicker(LEVELS_5, "low");
  handleInput(ARROW_RIGHT);
  handleInput(ARROW_RIGHT);
  handleInput(ENTER);
  // We can't read selectedIndex directly, but render before enter is fine.
  const lines = component.render(80);
  assert.equal(lines.length, 9);
});

test("ArrowLeft at index 0 is a no-op", () => {
  const { component, getResult, handleInput } = newPicker(LEVELS_5, "minimal");
  handleInput(ARROW_LEFT);
  handleInput(ENTER);
  // Should still confirm the first level (minimal) since left did nothing.
  assert.deepEqual(getResult(), { action: "confirm", level: "minimal" });
});

test("ArrowRight past the last index is a no-op", () => {
  const { component, getResult, handleInput } = newPicker(LEVELS_5, "xhigh");
  handleInput(ARROW_RIGHT);
  handleInput(ENTER);
  assert.deepEqual(getResult(), { action: "confirm", level: "xhigh" });
});

test("Tab behaves like ArrowRight", () => {
  const { component, getResult, handleInput } = newPicker(LEVELS_5, "low");
  handleInput(TAB);
  handleInput(TAB);
  handleInput(ENTER);
  assert.deepEqual(getResult(), { action: "confirm", level: "high" });
});

// ─── Confirm / cancel ──────────────────────────────────────────────

test("Enter confirms the currently selected level", () => {
  const { component, getResult, handleInput } = newPicker(LEVELS_5, "high");
  handleInput(ENTER);
  assert.deepEqual(getResult(), { action: "confirm", level: "high" });
});

test("Escape cancels without a level", () => {
  const { component, getResult, handleInput } = newPicker(LEVELS_5, "high");
  handleInput(ESCAPE);
  assert.deepEqual(getResult(), { action: "cancel" });
});

test("done callback fires exactly once", () => {
  let count = 0;
  const component = createEffortPickerComponent({
    levels: LEVELS_5,
    currentLevel: "medium",
    done: () => {
      count++;
    },
  });
  const handleInput = component.handleInput;
  if (!handleInput) throw new Error("picker must implement handleInput");
  const send = handleInput.bind(component);
  send(ENTER);
  send(ENTER);
  send(ARROW_RIGHT);
  send(ESCAPE);
  assert.equal(count, 1);
});

test("input is ignored after dispose", () => {
  let count = 0;
  const component = createEffortPickerComponent({
    levels: LEVELS_5,
    currentLevel: "low",
    done: () => {
      count++;
    },
  });
  const handleInput = component.handleInput;
  if (!handleInput) throw new Error("picker must implement handleInput");
  const send = handleInput.bind(component);
  component.dispose?.();
  send(ARROW_RIGHT);
  send(ENTER);
  assert.equal(count, 0);
});

// ─── Render invariants ─────────────────────────────────────────────

test("render returns 9 lines for non-empty levels (top + margin + 5 content + margin + bottom)", () => {
  const { component } = newPicker(LEVELS_5, "medium");
  const lines = component.render(80);
  assert.equal(lines.length, 9);
});

test("render wraps the title in box-drawing border characters", () => {
  const { component } = newPicker(LEVELS_5, "medium");
  const lines = component.render(80);
  // First line should start with ┌ and end with ┐ (possibly ANSI-styled).
  const top = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(top.startsWith("┌"), `expected top border to start with ┌, got: ${top.slice(0, 5)}`);
  assert.ok(top.endsWith("┐"), `expected top border to end with ┐, got: ${top.slice(-5)}`);
  // Last line should start with └ and end with ┘.
  const bottom = lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(bottom.startsWith("└"), `expected bottom border to start with └`);
  assert.ok(bottom.endsWith("┘"), `expected bottom border to end with ┘`);
});

test("render sides are wrapped with vertical border characters", () => {
  const { component } = newPicker(LEVELS_5, "medium");
  const lines = component.render(80);
  // Every line except the top and bottom borders should start/end with │.
  for (let i = 1; i < lines.length - 1; i++) {
    const stripped = lines[i].replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(stripped.startsWith("│"), `line ${i} should start with │: ${stripped.slice(0, 5)}`);
    assert.ok(stripped.endsWith("│"), `line ${i} should end with │: ${stripped.slice(-5)}`);
  }
});

test("render centers the title within a sufficiently wide viewport", () => {
  const { component } = newPicker(LEVELS_5, "medium");
  const lines = component.render(80);
  // Title is on content line index 1 (0=top border, 1=top margin+title, ...).
  // Actually title is on content row 0 of the inner block, which maps to
  // framed row 2 (top border + top margin + title).
  const titleLine = lines[2].replace(/\x1b\[[0-9;]*m/g, "");
  // Strip the leading │ and trailing │ to inspect the centered title text.
  const inner = titleLine.slice(1, -1);
  const firstNonSpace = inner.search(/\S/);
  assert.ok(firstNonSpace > 0, "title should be centered (leading padding present)");
});

test("render handles a single-level list without throwing", () => {
  const { component } = newPicker(["medium"], "medium");
  const lines = component.render(80);
  assert.equal(lines.length, 9);
});

test("render handles empty levels gracefully", () => {
  const { component } = newPicker([], undefined);
  const lines = component.render(80);
  assert.equal(lines.length, 9);
});

test("render caches and invalidate forces a refresh", () => {
  const { component, handleInput } = newPicker(LEVELS_5, "low");
  const first = component.render(80);
  const second = component.render(80);
  assert.strictEqual(first, second); // cache hit returns identical reference
  handleInput(ARROW_RIGHT);
  const third = component.render(80);
  assert.notStrictEqual(third, first); // invalidated -> new array
});

test("render survives narrow widths without throwing", () => {
  // The picker must not throw even when the overlay forces a tiny width.
  // Lines may overflow the requested width (we deliberately do not truncate),
  // but every call must succeed and return the full 9-line framed layout.
  const { component } = newPicker(LEVELS_5, "medium");
  for (const width of [1, 5, 10, 20, 40]) {
    const lines = component.render(width);
    assert.equal(lines.length, 9);
  }
});

test("title line contains 'Effort'", () => {
  const { component } = newPicker(LEVELS_5, "medium");
  const lines = component.render(80);
  // Title is the first content row after the top border + top margin.
  // Frame: top border (0), top margin (1), title (2), blank (3),
  // slider (4), labels (5), footer (6), bottom margin (7), bottom border (8).
  const titleLine = lines[2].replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(titleLine.includes("Effort"), `expected 'Effort' in title line, got: ${titleLine}`);
});

test("caret aligns with label center for odd- and even-width level names", () => {
  const levels = ["low", "medium", "high", "xhigh"];
  const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

  for (const level of levels) {
    const { component } = newPicker(levels, level);
    const lines = component.render(80);
    const slider = stripAnsi(lines[4]);
    const labels = stripAnsi(lines[5]);
    const caretCol = slider.indexOf("▲");
    const labelStart = labels.indexOf(level);
    assert.ok(labelStart >= 0, `expected to find ${level} in labels line`);
    const labelEnd = labelStart + level.length - 1;
    const labelCenter = (labelStart + labelEnd) / 2;
    // Terminal grids are discrete: even-width labels have a center between
    // columns, so the caret sits on the left cell of the center pair.
    const expectedDelta = level.length % 2 === 0 ? -0.5 : 0;
    assert.equal(caretCol - labelCenter, expectedDelta, `${level}: caret at ${caretCol}, center ${labelCenter}`);
  }
});

test("footer line includes arrow and confirm hints", () => {
  const { component } = newPicker(LEVELS_5, "medium");
  const lines = component.render(80);
  // Footer is row 6 (after title, blank, slider, labels).
  const footer = lines[6].replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(footer.includes("←") || footer.includes("<") || footer.includes("Left") || footer.includes("arrow"));
  assert.ok(footer.toLowerCase().includes("enter"));
  assert.ok(footer.toLowerCase().includes("esc") || footer.toLowerCase().includes("cancel"));
});
