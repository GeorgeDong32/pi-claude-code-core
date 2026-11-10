/*
 * Ledger directives (SPEC SC §5.6 LED-02/LED-02b, task W6).
 *
 * Human user messages from the compressed region, classified:
 *   flow-dispatch — rex-flow dispatch pointers (role headers / "read the
 *                   dispatch file and start" shapes) — NOT human directives
 *   standing      — hits a configurable constraint pattern (宁多勿少:
 *                   conservative match, prefer over-classifying)
 *   normal        — everything else the human said
 *
 * Budget ladder (LED-02): standing newest-first verbatim → normal newest-
 * first verbatim; over directivesMax the OLDEST normal folds first
 * (head 120 chars + `[#entryId @time]` pointer), then to pointer-only,
 * standing folds LAST; every directive keeps at least one pointer line;
 * past maxDirectiveLines the remainder collapses to a count line (originals
 * always remain in the session file — Tier D).
 *
 * LED-02b: directives (incl. folded pointer lines) carry over from the
 * previous compaction's ledger block — unknown versions/corrupt blocks are
 * silently dropped (telemetry counts it upstream).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompressedRegionView, LedgerDirective } from "./types.ts";

/** Dispatch-pointer shapes (conservative; role headers + read-dispatch). */
const FLOW_DISPATCH_PATTERNS: RegExp[] = [
	/【(worker|planner|gatekeeper|orchestrator)】/,
	/读[^\n]{0,80}dispatch[^]{0,80}(开工|派单)/,
	/(read|follow)[^]{0,80}dispatch[^]{0,80}(start|begin|work)/i,
	/===FLOW-DISPATCH===/,
];

export function isFlowDispatch(text: string): boolean {
	return FLOW_DISPATCH_PATTERNS.some((pattern) => pattern.test(text));
}

export function isStanding(text: string, patterns: readonly string[]): boolean {
	// Case-insensitive for the Latin patterns; CJK matches verbatim.
	const lower = text.toLowerCase();
	return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/** Extract one directive per human user message in the compressed region. */
export function collectDirectives(region: CompressedRegionView, standingPatterns: readonly string[]): LedgerDirective[] {
	const out: LedgerDirective[] = [];
	for (const { sourceEntry, messages } of region.entries) {
		if ((sourceEntry as { type?: string }).type !== "message") continue;
		for (const message of messages) {
			if (message.role !== "user") continue;
			const text = textOf(message).trim();
			if (text.length === 0) continue;
			const entryId = (sourceEntry as { id?: string }).id ?? "";
			const directive: LedgerDirective = {
				class: isFlowDispatch(text) ? "flow-dispatch" : isStanding(text, standingPatterns) ? "standing" : "normal",
				text,
				entryId,
				time: (sourceEntry as { timestamp?: string }).timestamp,
			};
			out.push(directive);
		}
	}
	return out;
}

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

// ─── LED-02b carry-over ─────────────────────────────────────────────────────

export const LEDGER_BLOCK_OPEN = '<cc-core-ledger v="1">';
export const LEDGER_BLOCK_CLOSE = "</cc-core-ledger>";

/**
 * D1 (2026-11-10 review rework D): the SINGLE render transform for directive
 * text — newlines become two-space continuations (B1). Exported so the
 * LED-08 self-check matches through the SAME pipeline (render + sanitize)
 * instead of the raw text (multiline directives used to fail it forever).
 */
export function renderDirectiveText(text: string): string {
	return text.replace(/\n/g, "\n  ");
}

/**
 * D1 (2026-11-10 review rework D): the per-directive verbatim clamp —
 * exported so the LED-08 self-check reuses the SAME clamp the renderer
 * applies (then renderDirectiveText, then sanitizeLedgerLine).
 */
export function clampDirectiveText(text: string, perDirectiveMax: number): string {
	return text.length > perDirectiveMax ? `${text.slice(0, perDirectiveMax)}… [truncated]` : text;
}

/**
 * D4 (2026-11-10 review D): the body of the LAST complete v1 ledger block.
 * The final summary is header + NARRATIVE (LLM output) + ledger + files —
 * a forged block echoed inside the narrative would win a first-index scan;
 * the real block is always the LAST one appended.
 */
export function lastLedgerBlockBody(summary: string | undefined): string | undefined {
	if (!summary || summary.length === 0) return undefined;
	const open = summary.lastIndexOf(LEDGER_BLOCK_OPEN);
	if (open === -1) return undefined;
	const close = summary.indexOf(LEDGER_BLOCK_CLOSE, open);
	if (close === -1) return undefined;
	return summary.slice(open + LEDGER_BLOCK_OPEN.length, close);
}

/** Parse the Directives section out of a previous summary's ledger block. */
export function parseCarriedDirectives(previousSummary: string | undefined): { directives: LedgerDirective[]; dropped: boolean } {
	const block = lastLedgerBlockBody(previousSummary);
	if (block === undefined) return { directives: [], dropped: false }; // no complete block — nothing to carry
	const section = sectionOf(block, "Directives");
	if (section === undefined) return { directives: [], dropped: false };
	const directives: LedgerDirective[] = [];
	// RB6 (2026-11-10 review rework): parse in TWO passes — first group each
	// logical line with its two-space continuations (B1), THEN run pointer
	// detection and classification over the WHOLE block. A folded pointer
	// suffix on the last continuation line must not strand the entryId.
	const logical: string[] = [];
	for (const raw of section.split("\n")) {
		if (raw.startsWith("  ") && logical.length > 0) {
			logical[logical.length - 1] = `${logical[logical.length - 1]!}\n${raw.slice(2)}`;
			continue;
		}
		logical.push(raw);
	}
	for (const raw of logical) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("##")) continue;
		// D6 (2026-11-10 review D): a folded pointer is ALWAYS at the end of
		// the rendered line — mid-text `[#id @t]` in user content must stay
		// literal (never reclassified as a folded pointer).
		const pointer = /\[#([^\] ]+) @([^\]]+)\]\s*$/.exec(line);
		const kind = line.startsWith("-") || line.startsWith("*") ? line.slice(1).trim() : line;
		if (pointer) {
			directives.push({
				// Carried lines keep their folded shape; class is re-detected.
				class: isFlowDispatch(kind) ? "flow-dispatch" : "standing",
				text: kind.replace(/\s*\[#[^\]]+\]\s*$/, "").trim(),
				entryId: pointer[1],
				time: pointer[2],
				folded: "pointer",
			});
			continue;
		}
		if (line.startsWith("+") && /older directives/.test(line)) continue; // count line, not a directive
		directives.push({
			class: isFlowDispatch(kind) ? "flow-dispatch" : "standing",
			text: kind,
			entryId: "",
			// verbatim in the previous block — folds fresh this round if needed
		});
	}
	return { directives, dropped: false };
}

function sectionOf(block: string, heading: string): string | undefined {
	const marker = new RegExp(`^#{1,3}\\s*${heading}`, "m").exec(block);
	if (!marker) return undefined;
	const rest = block.slice(marker.index + marker[0].length);
	// G1 (2026-11-10 review): skip the heading LINE's remainder — the
	// `## Directives (verbatim)` marker ends at "Directives" and its
	// " (verbatim)" tail is NOT content (it used to parse as a junk
	// directive with no entryId, accumulating every carry-over round).
	const nl = rest.indexOf("\n");
	const body = nl === -1 ? "" : rest.slice(nl);
	const next = body.search(/^#{1,3}\s*/m);
	return next === -1 ? body : body.slice(0, next);
}

// ─── Budget ladder + rendering ──────────────────────────────────────────────

export interface DirectivesBudget {
	directivesMax: number;
	perDirectiveMax: number;
	maxDirectiveLines: number;
	foldHeadChars: number;
}

export interface RenderedDirectives {
	lines: string[];
	degradation: { collapsed: number; pointerOnly: number };
}

export function renderDirectives(directives: LedgerDirective[], budget: DirectivesBudget): RenderedDirectives {
	// Merge + dedupe by entryId (carry-over + fresh), then order:
	// standing newest-first verbatim, then normal newest-first verbatim.
	const byEntry = new Map<string, LedgerDirective>();
	const ordered: LedgerDirective[] = [];
	for (const directive of directives) {
		if (directive.entryId && byEntry.has(directive.entryId)) continue;
		if (directive.entryId) byEntry.set(directive.entryId, directive);
		ordered.push(directive);
	}
	// Newest last in input; reverse for newest-first within each class.
	const standing = ordered.filter((d) => d.class === "standing").reverse();
	const normal = ordered.filter((d) => d.class === "normal").reverse();
	const flow = ordered.filter((d) => d.class === "flow-dispatch");

	const degradation = { collapsed: 0, pointerOnly: 0 };
	// perDirectiveMax clamp first (verbatim budget per line).
	const clamp = (text: string): string => clampDirectiveText(text, budget.perDirectiveMax);

	// B1 (2026-11-10 review): newlines inside a directive render as a
	// two-space continuation indent, so user text can never forge a
	// `## Heading` line that sectionOf would treat as a new section.
	// parseCarriedDirectives stitches continuations back.
	const renderOne = (directive: LedgerDirective, foldLevel: "verbatim" | "head" | "pointer"): string => {
		if (foldLevel === "verbatim") return `- ${renderDirectiveText(clamp(directive.text))}`;
		if (foldLevel === "head") {
			degradation.collapsed += 1;
			return `- ${renderDirectiveText(directive.text.slice(0, budget.foldHeadChars))}… [#${directive.entryId} @${directive.time ?? "?"}]`;
		}
		degradation.pointerOnly += 1;
		return `- (see session) [#${directive.entryId} @${directive.time ?? "?"}]`;
	};

	// Start all-verbatim and fold oldest normal → head → pointer until the
	// RENDERED char budget fits (standing folds last). The fits() check
	// accounts for the current fold state, and the ladder takes one step per
	// iteration (verbatim→head for every candidate in order, then →pointer).
	const foldState = new Map<LedgerDirective, "verbatim" | "head" | "pointer">();
	const ranked = [...standing, ...normal];
	for (const d of ranked) foldState.set(d, d.folded === "pointer" ? "pointer" : "verbatim");
	const renderedLen = (d: LedgerDirective): number => {
		const state = foldState.get(d) ?? "verbatim";
		if (state === "verbatim") return clamp(d.text).length + 4;
		if (state === "head") return budget.foldHeadChars + 34;
		return 34;
	};
	const fits = (): boolean => ranked.reduce((sum, d) => sum + renderedLen(d), 0) <= budget.directivesMax;
	const foldOrder = [...normal.slice().reverse(), ...standing.slice().reverse()]; // oldest normal first, standing last
	const steps: Array<() => void> = [];
	for (const d of foldOrder) steps.push(() => foldState.set(d, "head"));
	for (const d of foldOrder) steps.push(() => foldState.set(d, "pointer"));
	let stepIdx = 0;
	while (!fits() && stepIdx < steps.length) steps[stepIdx++]();

	let lines: string[] = [];
	for (const d of standing) lines.push(renderOne(d, foldState.get(d) ?? "verbatim"));
	for (const d of normal) lines.push(renderOne(d, foldState.get(d) ?? "verbatim"));
	for (const d of flow) lines.push(renderOne(d, "verbatim"));

	if (lines.length > budget.maxDirectiveLines) {
		const kept = lines.slice(0, budget.maxDirectiveLines);
		kept.push(`+${lines.length - budget.maxDirectiveLines} older directives — originals remain in the session file`);
		lines = kept;
	}
	return { lines, degradation };
}
