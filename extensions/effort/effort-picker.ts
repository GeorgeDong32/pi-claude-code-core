import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

export interface EffortPickerResult {
  action: "confirm" | "cancel";
  level?: string;
}

export interface EffortPickerOptions {
  levels: string[];
  currentLevel: string | undefined;
  theme?: Theme;
  done: (result: EffortPickerResult) => void;
}

const TITLE = "Effort";
const FOOTER = "←/→ to adjust · Enter to confirm · Esc to cancel";
const END_INSET = 2;
const MIN_INNER_WIDTH = 32;

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
    const innerWidth = Math.max(MIN_INNER_WIDTH, width - 2);
    const dim = (text: string): string => this.theme?.fg("dim", text) ?? text;
    const inverse = (text: string): string => this.theme?.inverse(text) ?? text;
    const bold = (text: string): string => this.theme?.bold(text) ?? text;
    const muted = (text: string): string => this.theme?.fg("muted", text) ?? text;
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
  const cols: string[] = new Array(rowWidth).fill(char);
  const labelCol = positions[selectedIndex];
  const labelWidth = labelWidths[selectedIndex] ?? 0;
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
  const innerWidth = positions[positions.length - 1] + END_INSET + 1;
  const cols: string[] = new Array(innerWidth).fill(" ");

  const caretColOf = (i: number): number => positions[i];

  for (let i = 0; i < levels.length; i++) {
    if (i === selectedIndex) continue;
    const w = labelWidths[i];
    const caretCol = caretColOf(i);
    const start = caretCol - Math.floor((w - 1) / 2);
    writeInto(cols, levels[i], start);
  }

  const selectedLabel = levels[selectedIndex];
  const styled = inverse(bold(selectedLabel));
  const w = labelWidths[selectedIndex];
  const caretCol = caretColOf(selectedIndex);
  const start = caretCol - Math.floor((w - 1) / 2);
  cols.splice(start, w, styled);

  return cols.join("");
}

function writeInto(cols: string[], text: string, start: number): void {
  const w = visibleWidth(text);
  for (let i = 0; i < w; i++) {
    const target = start + i;
    if (target < 0) continue;
    if (target >= cols.length) break;
    cols[target] = text[i] ?? " ";
  }
}

function centerInWidth(line: string, width: number): string {
  const vw = visibleWidth(line);
  if (vw >= width) return line;
  const totalPad = width - vw;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return " ".repeat(left) + line + " ".repeat(right);
}

function wrapInBox(lines: string[], innerWidth: number, borderColor: (text: string) => string): string[] {
  const top = borderColor("┌" + "─".repeat(innerWidth) + "┐");
  const bottom = borderColor("└" + "─".repeat(innerWidth) + "┘");
  const side = borderColor("│");
  const framed: string[] = [top];
  framed.push(side + " ".repeat(innerWidth) + side);
  for (const line of lines) {
    const vw = visibleWidth(line);
    const pad = vw < innerWidth ? " ".repeat(innerWidth - vw) : "";
    framed.push(side + line + pad + side);
  }
  framed.push(side + " ".repeat(innerWidth) + side);
  framed.push(bottom);
  return framed;
}
