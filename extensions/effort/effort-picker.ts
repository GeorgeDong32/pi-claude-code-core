import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Result returned when the user finishes interacting with the effort picker.
 * `level` is set only when action is "confirm".
 */
export interface EffortPickerResult {
  action: "confirm" | "cancel";
  level?: string;
}

/**
 * Options for constructing the picker component.
 */
export interface EffortPickerOptions {
  /** Ordered list of effort levels supported by the current model. */
  levels: string[];
  /** Currently active level, used to seed the initial cursor position. */
  currentLevel: string | undefined;
  /** Theme used for styling (bold/inverse/fg). Optional; falls back to plain text. */
  theme?: Theme;
  /** Completion callback invoked exactly once. */
  done: (result: EffortPickerResult) => void;
}

const TITLE = "Effort";
const FOOTER = "←/→ to adjust · Enter to confirm · Esc to cancel";
// Columns reserved at each end of the slider/labels row so the leftmost /
// rightmost label never collides with the box border.
const END_INSET = 2;
// Minimum inner content width. The final framed box is +2 columns (for the
// two vertical border characters), so the overlay should set its minWidth
// to at least this + 2.
const MIN_INNER_WIDTH = 32;

/**
 * Build a horizontal-selector component for /effort.
 *
 * Render shape (5 lines, when levels has at least 2 entries):
 *
 *   Effort
 *
 *   ────────────────▲────────────────────────────────────────
 *   minimal  low  medium  high  xhigh
 *
 *   ←/→ to adjust · Enter to confirm · Esc to cancel
 *
 * The labels span from the leftmost column to the rightmost column so the
 * strongest available level is always flush against the right edge — no
 * trailing whitespace. The slider `▲` sits above the currently highlighted
 * label; arrow keys move it.
 */
export function createEffortPickerComponent(options: EffortPickerOptions): Component & { dispose?(): void } {
  return new EffortPickerComponent(options);
}

class EffortPickerComponent implements Component {
  private levels: string[];
  private selectedIndex: number;
  private theme: Theme | undefined;
  private done: (result: EffortPickerResult) => void;
  private cachedLines: string[] | undefined;
  private cachedWidth: number | undefined;
  private disposed = false;

  constructor(options: EffortPickerOptions) {
    this.levels = options.levels;
    this.theme = options.theme;
    this.done = options.done;

    // Seed cursor: prefer current level, fall back to middle of the available range.
    let initial = options.currentLevel ? this.levels.indexOf(options.currentLevel) : -1;
    if (initial < 0) {
      initial = Math.max(0, Math.floor(this.levels.length / 2));
    }
    if (initial >= this.levels.length) {
      initial = Math.max(0, this.levels.length - 1);
    }
    this.selectedIndex = initial;
  }

  handleInput(data: string): void {
    if (this.disposed) return;

    if (matchesKey(data, Key.left)) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      if (this.selectedIndex < this.levels.length - 1) {
        this.selectedIndex++;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.finish({ action: "confirm", level: this.levels[this.selectedIndex] });
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.finish({ action: "cancel" });
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = this.computeLines(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  dispose(): void {
    this.disposed = true;
  }

  private finish(result: EffortPickerResult): void {
    if (this.disposed) return;
    this.disposed = true;
    this.done(result);
  }

  private computeLines(width: number): string[] {
    // Render content into a fixed inner width (the "frame" the border wraps).
    // Two extra rows of vertical margin separate content from the top/bottom
    // border so the box breathes.
    const innerWidth = Math.max(MIN_INNER_WIDTH, width - 2);
    const dim = (text: string): string => this.theme?.fg("dim", text) ?? text;
    const inverse = (text: string): string => this.theme?.inverse(text) ?? text;
    const bold = (text: string): string => this.theme?.bold(text) ?? text;
    const muted = (text: string): string => this.theme?.fg("muted", text) ?? text;
    // Border is forced to bright white so the box reads cleanly on both light
    // and dark themes regardless of the theme's border color choice.
    const borderColor = (text: string): string => `\x1b[97m${text}\x1b[39m`;

    const titleText = bold(this.theme?.fg("accent", TITLE) ?? TITLE);
    const footerText = dim(FOOTER);

    const contentLines: string[] = [];
    if (this.levels.length === 0) {
      contentLines.push(centerInWidth(titleText, innerWidth));
      contentLines.push("");
      contentLines.push(centerInWidth(muted("No effort levels available for this model."), innerWidth));
      contentLines.push("");
      contentLines.push(centerInWidth(footerText, innerWidth));
    } else if (this.levels.length === 1) {
      const only = inverse(bold(this.levels[0]));
      contentLines.push(centerInWidth(titleText, innerWidth));
      contentLines.push("");
      contentLines.push(centerInWidth("▲", innerWidth));
      contentLines.push(centerInWidth(only, innerWidth));
      contentLines.push(centerInWidth(footerText, innerWidth));
    } else {
      // Layout labels within the inner width, with END_INSET columns of margin
      // reserved at each end so the leftmost/rightmost label never touches
      // the box border.
      const trackWidth = Math.max(this.levels.length * 2, innerWidth - END_INSET * 2);
      const positions = layoutLabelPositions(this.levels, trackWidth, END_INSET);
      const rowWidth = trackWidth + END_INSET * 2;
      const labelWidths = this.levels.map((l) => visibleWidth(l));
      const sliderLine = buildSliderLine(positions, this.selectedIndex, rowWidth, END_INSET, muted, labelWidths);
      const labelsLine = buildLabelsLine(this.levels, positions, this.selectedIndex, inverse, bold, labelWidths);

      contentLines.push(centerInWidth(titleText, innerWidth));
      contentLines.push("");
      contentLines.push(centerInWidth(sliderLine, innerWidth));
      contentLines.push(centerInWidth(labelsLine, innerWidth));
      contentLines.push(centerInWidth(footerText, innerWidth));
    }

    return wrapInBox(contentLines, innerWidth, borderColor);
  }
}

/**
 * Compute the column where the *center* of each label sits.
 *
 * Levels are spread across `trackWidth` columns starting at column `inset`.
 * Intermediate labels are linearly interpolated between the endpoints, so
 * the leftmost label is `inset` cells from the start and the rightmost is
 * `trackWidth - 1 + inset` cells in. With a positive `inset` the slider
 * stays clear of the overlay border.
 */
function layoutLabelPositions(levels: string[], trackWidth: number, inset = 0): number[] {
  const n = levels.length;
  if (n === 1) return [Math.floor(trackWidth / 2) + inset];
  const positions: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    positions[i] = inset + Math.round((i * (trackWidth - 1)) / (n - 1));
  }
  return positions;
}

function buildSliderLine(
  positions: number[],
  selectedIndex: number,
  rowWidth: number,
  inset: number,
  muted: (text: string) => string,
  labelWidths: number[]
): string {
  const char = muted("─");
  const caret = "▲";
  // Build a column array of single-cell characters, then place the caret on
  // the column that visually centers over the selected label.
  // positions[i] is the caret anchor column; see buildLabelsLine for how
  // label text is laid out around it.
  const cols: string[] = new Array(rowWidth).fill(char);
  const labelCol = positions[selectedIndex];
  const labelWidth = labelWidths[selectedIndex] ?? 0;
  // positions[i] is the caret column. For even-width labels the true visual
  // center falls between two columns; anchoring the caret on the left cell of
  // that pair reads more centered than biasing to the right.
  const caretCol = labelCol;
  if (caretCol >= 0 && caretCol < rowWidth) {
    cols[caretCol] = caret;
  }
  void inset;
  return cols.join("");
}

function buildLabelsLine(
  levels: string[],
  positions: number[],
  selectedIndex: number,
  inverse: (text: string) => string,
  bold: (text: string) => string,
  labelWidths: number[]
): string {
  // Size the buffer to cover the rightmost label end + the END_INSET margin.
  const innerWidth = positions[positions.length - 1] + END_INSET + 1;
  const cols: string[] = new Array(innerWidth).fill(" ");

  // Helper: column where the caret (▲) for label i sits. positions[i] is the
  // caret anchor; label text is laid out around it.
  const caretColOf = (i: number): number => positions[i];

  // First pass: fill unselected labels into the column buffer. Each label is
  // written so its caret column sits on the label's center (odd width) or the
  // left cell of the center pair (even width).
  for (let i = 0; i < levels.length; i++) {
    if (i === selectedIndex) continue;
    const w = labelWidths[i];
    const caretCol = caretColOf(i);
    const start = caretCol - Math.floor((w - 1) / 2);
    writeInto(cols, levels[i], start);
  }

  // Second pass: overwrite with the selected label, styled (inverse+bold).
  const selectedLabel = levels[selectedIndex];
  const styled = inverse(bold(selectedLabel));
  const w = labelWidths[selectedIndex];
  const caretCol = caretColOf(selectedIndex);
  const start = caretCol - Math.floor((w - 1) / 2);
  // Splice styled string into the column buffer; visible width of styled
  // text still equals w (inverse/bold don't add visible cells).
  cols.splice(start, w, styled);

  return cols.join("");
}

/**
 * Write `text` into `cols` starting at column `start`, padding with spaces
 * if `start` is negative or the text overruns the buffer.
 */
function writeInto(cols: string[], text: string, start: number): void {
  const w = visibleWidth(text);
  for (let i = 0; i < w; i++) {
    const target = start + i;
    if (target < 0) continue;
    if (target >= cols.length) break;
    cols[target] = text[i] ?? " ";
  }
}

/**
 * Center `line` (visible-width aware) within `width` by padding with spaces.
 * If the line is already wider than `width`, return it unchanged.
 */
function centerInWidth(line: string, width: number): string {
  const vw = visibleWidth(line);
  if (vw >= width) return line;
  const totalPad = width - vw;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return " ".repeat(left) + line + " ".repeat(right);
}

/**
 * Wrap `lines` (each at most `innerWidth` columns) in a box-drawing frame.
 * The frame reserves one extra column on each side, so the total width
 * including borders is `innerWidth + 2`. `borderColor` is applied to the
 * box-drawing characters; content lines are left untouched.
 *
 * Vertical margin: one blank line inside the top and bottom borders so the
 * title and footer have breathing room from the box edges.
 */
function wrapInBox(lines: string[], innerWidth: number, borderColor: (text: string) => string): string[] {
  const top = borderColor("┌" + "─".repeat(innerWidth) + "┐");
  const bottom = borderColor("└" + "─".repeat(innerWidth) + "┘");
  const side = borderColor("│");
  const framed: string[] = [top];
  // Top margin row.
  framed.push(side + " ".repeat(innerWidth) + side);
  for (const line of lines) {
    const vw = visibleWidth(line);
    const pad = vw < innerWidth ? " ".repeat(innerWidth - vw) : "";
    framed.push(side + line + pad + side);
  }
  // Bottom margin row.
  framed.push(side + " ".repeat(innerWidth) + side);
  framed.push(bottom);
  return framed;
}
