/*
 * Ledger assembler (SPEC SC §5.6 LED-01/06/07/08, task W6).
 *
 * Assembles the deterministic <cc-core-ledger v="1"> block at APPLY time
 * (LED-06: current truth, never the snapshot's stale view). Providers are
 * independently try/caught (LED-07) — one broken provider degrades to an
 * `unavailable` marker, never a throw, and all of them are synchronous.
 *
 * LED-01 degradation ladder, applied IN ORDER until the block fits
 * COMPACTION_LEDGER_MAX (each step only degrades, counts surface through
 * telemetry):
 *   ① Closed → count-only line      ② Verification → last test only
 *   ③ Directives → force the fold ladder (renderDirectives budget → minimal)
 *   ④ Background → one bare line per item
 *   ⑤ Open work → clamp description fields (id/status/branch/tab/rework
 *      are identity fields and NEVER clamped)
 *   ⑥ Open work items beyond maxOpenItems → "+K more — full list in <…>"
 *
 * LED-08 self-check: every Tier A id+status and every Tier B directive
 * pointer must be findable in the assembled string — a miss is a ledger
 * bug: the caller must NOT propose (telemetry ledger-self-check-failed).
 */

import { COMPACTION_LEDGER_MAX } from "../../../lib/context-budget.ts";
import { collectDirectives, parseCarriedDirectives, renderDirectives } from "./directives.ts";
import { goalSection } from "./goal.ts";
import { bgSection } from "./bg.ts";
import { scanVerification } from "./verification.ts";
import type {
	AssembledLedger,
	CompressedRegionView,
	FlowLedgerState,
	LedgerDegradation,
	LedgerProviders,
	OpenIdentity,
} from "./types.ts";
import type { CompactionSettings } from "../settings.ts";

export interface AssembleLedgerInput {
	region: CompressedRegionView;
	providers: LedgerProviders;
	settings: CompactionSettings;
}

const BLOCK_OPEN = '<cc-core-ledger v="1">';
const BLOCK_CLOSE = "</cc-core-ledger>";

interface Sections {
	openWork: string[];
	directives: string[];
	verification: string[];
	background: string[];
	closed: string[];
	identities: OpenIdentity[];
	closedIds: string[];
	degradation: LedgerDegradation;
}

function safe<T>(label: string, provider: (() => T) | undefined, fallback: T): T {
	if (!provider) return fallback;
	try {
		return provider() ?? fallback;
	} catch {
		return fallback;
	}
}

function clampDescription(text: string, chars: number): string {
	return text.length > chars ? `${text.slice(0, chars)}…` : text;
}

function buildSections(input: AssembleLedgerInput, level: number): Sections {
	const { region, providers, settings } = input;
	const degradation: LedgerDegradation = { tierADegraded: 0, directivesCollapsed: 0, directivesPointerOnly: 0, openOverflow: 0 };
	// B6 (2026-11-10 review): a THROWING provider renders an explicit
	// "(x provider unavailable)" line in its own section (LED-07/INV-9) —
	// never a throw, never a silent gap.
	const unavailable = { goal: false, flow: false, bg: false, verification: false };
	const safeMarked = <T>(label: keyof typeof unavailable, provider: (() => T) | undefined, fallback: T): T => {
		if (!provider) return fallback;
		try {
			return provider() ?? fallback;
		} catch {
			unavailable[label] = true;
			return fallback;
		}
	};

	// ── Open work: goals (+ flow in W7) ──
	// F1 (2026-11-10 review final): resolve flow ONCE here — the ladder
	// levels all share this result (providers are memoized per assemble),
	// ⑥ derives its accounting from it, and no probe helpers remain.
	const flowStateRaw = safeMarked("flow", providers.flow, undefined);
	const goalState = safeMarked("goal", providers.goal, undefined);
	// RB1 (2026-11-10 review rework): probe the goal section once (default
	// cap) for ⑥'s accounting, then re-render ONLY if the budget demands a
	// different cap — the formatter stays the single renderer (LED-03).
	const goalProbe = goalState ? goalSection(goalState) : undefined;
	const goalOpenTotal = (goalProbe?.identities.length ?? 0) + (goalProbe?.hiddenOpenCount ?? 0);
	const flowRunsTotal = flowStateRaw?.openRuns.length ?? 0;
	let capOpenGoals: number | undefined;
	let keptRuns: typeof flowStateRaw extends undefined ? never[] : Array<NonNullable<typeof flowStateRaw>["openRuns"][number]> | undefined;
	let hiddenOpen = 0;
	{
		const maxOpen = settings.maxOpenItems;
		const focusedIsOpen = goalProbe?.identities.some((identity) => identity.id === goalState?.focusedGoalId) ?? false;
		if (goalOpenTotal + flowRunsTotal > maxOpen) {
			// over budget: single-budget truncation (goals first, then runs)
			const keptGoals = Math.min(goalOpenTotal, maxOpen);
			capOpenGoals = Math.max(0, keptGoals - (focusedIsOpen ? 1 : 0));
			keptRuns = (flowStateRaw?.openRuns ?? []).slice(0, Math.max(0, maxOpen - keptGoals));
			hiddenOpen = goalOpenTotal + flowRunsTotal - keptGoals - keptRuns.length;
		} else {
			// F2 (2026-11-10 review final): no magic 20 — under budget the
			// render cap is ALWAYS explicit so nothing can hide behind the
			// formatter's default (LED-01).
			capOpenGoals = Math.max(0, goalOpenTotal - (focusedIsOpen ? 1 : 0));
		}
	}
	const goal = goalState ? goalSection(goalState, capOpenGoals !== undefined ? { capOpenGoals } : undefined) : { openLines: [], closed: [], identities: [], closedIds: [], hiddenOpenCount: 0 };
	let openLines: string[] = [];
	if (level >= 5) {
		// ⑤ clamp description fields — identity fields stay verbatim.
		openLines = goal.openLines.map((line) => clampDescription(line, 80));
		degradation.tierADegraded += 1;
	} else {
		openLines = [...goal.openLines];
	}
	// RB1 (2026-11-10 review rework): flow renders the KEPT run set decided by
	// ⑥'s single budget above (a run's task/gate/sentinel sublines stay with
	// their run — whole groups only). bg does NOT consume maxOpenItems.
	const flowState = flowStateRaw && keptRuns && keptRuns.length < flowStateRaw.openRuns.length ? { ...flowStateRaw, openRuns: keptRuns as typeof flowStateRaw.openRuns } : flowStateRaw;
	if (flowState) {
		openLines.push(...flowLines(flowState, level >= 5 ? 60 : 120));
		if (level >= 5) degradation.tierADegraded += 1;
	}
	const bgItems = safeMarked("bg", providers.bg, []);
	const bg = bgSection(bgItems);

	// ⑥ overflow pointer (single budget): +K more open items — K counts BOTH
	// hidden goals and dropped runs (degradation.openOverflow mirrors it).
	if (hiddenOpen > 0) {
		const pointer = flowStateRaw?.boardPath ? `full list in ${flowStateRaw.boardPath}` : "full list in .pi/goals/";
		openLines.push(`+${hiddenOpen} more open items — ${pointer}`);
		degradation.openOverflow = hiddenOpen;
	}
	const goalIdentities = goal.identities;
	const keptFlowRuns = flowState?.openRuns ?? [];

	// ── Directives: fresh region + LED-02b carry-over ──
	const fresh = collectDirectives(region, settings.standingPatterns);
	const carried = parseCarriedDirectives(providers.previousSummary);
	const directiveBudget = {
		directivesMax: level >= 3 ? 0 : settings.directivesMax,
		perDirectiveMax: settings.perDirectiveMax,
		maxDirectiveLines: settings.maxDirectiveLines,
		foldHeadChars: 120,
	};
	const rendered = renderDirectives([...carried.directives, ...fresh], directiveBudget);
	degradation.directivesCollapsed = rendered.degradation.collapsed;
	degradation.directivesPointerOnly = rendered.degradation.pointerOnly;

	// ── Verification (② at level ≥2: last test only) ──
	const verification = safeMarked("verification", providers.verification, undefined)
		?? scanVerification(region);
	const verificationLines: string[] = [];
	if (verification.lastTest) {
		verificationLines.push(`last test: \`${verification.lastTest.command}\` → ${verification.lastTest.result}`);
	}
	if (level < 2 && verification.lastCommit) {
		verificationLines.push(`last commit: ${verification.lastCommit.hash.slice(0, 10)} ${clampDescription(verification.lastCommit.subject, 60)}`);
	}

	// ── Background (④ at level ≥4: bare one-liners) ──
	const backgroundLines = level >= 4
		? bgItems.map((item) => `- ${item.id} [${item.kind}] ${item.status}`)
		: bg.lines;

	// ── Closed (① at level ≥1: count only) ──
	const closedItems = [...goal.closed, ...(flowState?.closed ?? [])];
	const closedLines = level >= 1
		? [`(${closedItems.length} closed items — see session/board)`]
		: closedItems.map((item) => `- ✔ ${item.id} ${clampDescription(item.label, 60)}${item.detail ? ` — ${item.detail}` : ""}`);

	// B6: per-section unavailable markers land in their own sections.
	if (unavailable.goal || unavailable.flow) openLines.push(...[unavailable.goal ? "(goal provider unavailable)" : "", unavailable.flow ? "(flow provider unavailable)" : ""].filter((l) => l !== ""));
	if (unavailable.bg && backgroundLines.length === 0) backgroundLines.push("(bg provider unavailable)");
	if (unavailable.verification && verificationLines.length === 0) verificationLines.push("(verification provider unavailable)");

	return {
		openWork: openLines,
		directives: rendered.lines,
		verification: verificationLines,
		background: backgroundLines,
		closed: closedLines,
		identities: [...goalIdentities, ...bg.identities, ...((keptFlowRuns as Array<{ runId: string; stage: string }>).map((run) => ({ source: "flow" as const, id: run.runId, status: run.stage })))],
		closedIds: [...goal.closedIds, ...(flowState?.closed.map((item) => item.id) ?? [])],
		degradation,
	};
}

/** Flow rows for the Open work section (W7 fills FlowLedgerState; here we
 * only render). Sentinel-only state renders the sentinel lines instead. */
function flowLines(flow: FlowLedgerState, objectiveChars: number): string[] {
	const lines: string[] = [];
	if (!flow.associated) {
		lines.push("flow (sentinels only, board not associated — re-read the board for truth):");
		lines.push(...flow.sentinels.slice(0, 12));
		return lines;
	}
	for (const run of flow.openRuns) {
		lines.push(`[flow ${run.runId} · ${run.stage}] ${clampDescription(run.objective, objectiveChars)}${run.spec ? ` spec=${run.spec}` : ""}`);
		for (const task of run.tasks) {
			lines.push(`  ${task.id} ${task.status}${task.branch ? ` branch=${task.branch}` : ""}${task.tab ? ` tab="${task.tab}"` : ""}${task.reworkCount !== undefined ? ` rework=${task.reworkCount}` : ""}${task.note ? ` note: ${clampDescription(task.note, 60)}` : ""}`);
		}
		for (const gate of run.openGates) {
			lines.push(`  gate ${gate.id} open${gate.ref ? ` (${gate.ref})` : ""}: ${clampDescription(gate.question, 90)}`);
		}
		if (run.lastSentinels.length > 0) lines.push(`  last sentinels: ${run.lastSentinels.slice(-4).join(" · ")}`);
	}
	if (flow.otherOpenRuns > 0) {
		lines.push(`other open runs on this board (not touched by this session): ${flow.otherOpenRuns}`);
	}
	return lines;
}

/** RB3 (2026-11-10 review rework): LED-06 region — entries after the LAST
 * compaction (with messages) up to the kept head. Single source for the
 * draft, supply, regenerate, and precompute paths. */
export function compressedRegionOf(entries: ReadonlyArray<CompressedRegionView["entries"][number]>, firstKeptEntryIndex: number): CompressedRegionView {
	let boundaryStart = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.sourceEntry.type === "compaction" && entry.messages.length > 0) {
			boundaryStart = i + 1;
			break;
		}
	}
	return { entries: entries.slice(boundaryStart, firstKeptEntryIndex) as CompressedRegionView["entries"] };
}

/**
 * B1 (2026-11-10 review): neutralize forged ledger tags in USER content —
 * any literal `<cc-core-ledger` / `</cc-core-ledger` (case-insensitive) has
 * its `<` replaced with ‹ (U+2039) so injected text can never open/close the
 * real block. Applied at the single rendering chokepoint (renderBlock), to
 * section content lines only — our own BLOCK_OPEN/CLOSE and headings are
 * trusted.
 */
export function sanitizeLedgerLine(line: string): string {
	return line.replace(/<\/?cc-core-ledger/gi, (m) => m.replace("<", "\u2039"));
}

function renderBlock(sections: Sections): string {
	const parts: string[] = [BLOCK_OPEN];
	const section = (heading: string, lines: string[]) => {
		if (lines.length === 0) return;
		parts.push(`## ${heading}`);
		parts.push(...lines.map(sanitizeLedgerLine));
	};
	section("Open work", sections.openWork);
	section("Directives (verbatim)", sections.directives);
	section("Verification", sections.verification);
	section("Background", sections.background);
	section("Closed (one-line)", sections.closed);
	parts.push(BLOCK_CLOSE);
	return parts.join("\n");
}

/** LED-08 self-check: Tier A ids+statuses and Tier B pointers findable. */
function selfCheck(sections: Sections, block: string, region: CompressedRegionView, settings: CompactionSettings): { ok: boolean; missing: string[] } {
	const missing: string[] = [];
	for (const identity of sections.identities) {
		if (!block.includes(identity.id)) missing.push(`tierA-id:${identity.id}`);
		if (!block.includes(identity.status)) missing.push(`tierA-status:${identity.id}:${identity.status}`);
	}
	// Tier B: every fresh standing/normal directive is verbatim or folded
	// with a pointer line carrying its entryId.
	const fresh = collectDirectives(region, settings.standingPatterns).filter((d) => d.class !== "flow-dispatch");
	for (const directive of fresh) {
		const verbatim = block.includes(directive.text.slice(0, Math.min(40, directive.text.length)));
		const pointer = directive.entryId !== "" && block.includes(`#${directive.entryId} @`);
		if (!verbatim && !pointer) missing.push(`tierB:${directive.entryId}`);
	}
	return { ok: missing.length === 0, missing };
}

/**
 * F1 (2026-11-10 review final): wrap `providers` so EACH provider runs at
 * most ONCE per assembleLedger call — the ladder re-runs buildSections up to
 * 7 times and the apply path is synchronous (APP-03: a board read is disk
 * I/O). Throw behavior is preserved (a throwing provider re-throws on every
 * call) so safeMarked still marks its section unavailable.
 */
function memoizeProviders(providers: LedgerProviders): LedgerProviders {
	type Memoized<T> = { ok: true; result: T } | { ok: false; error: unknown };
	const cache = new Map<string, Memoized<unknown>>();
	const memo = <T>(key: string, provider: (() => T) | undefined): (() => T) | undefined => {
		if (!provider) return undefined;
		return (() => {
			if (cache.has(key)) {
				const hit = cache.get(key) as Memoized<T>;
				if (hit.ok) return hit.result;
				throw hit.error; // rethrow the SAME failure every call
			}
			try {
				const result = provider();
				cache.set(key, { ok: true, result });
				return result;
			} catch (error) {
				cache.set(key, { ok: false, error });
				throw error;
			}
		}) as () => T;
	};
	return {
		goal: memo("goal", providers.goal) as LedgerProviders["goal"],
		flow: memo("flow", providers.flow),
		bg: memo("bg", providers.bg),
		verification: memo("verification", providers.verification),
		previousSummary: providers.previousSummary,
	};
}

/** Assemble with the LED-01 ladder. Never throws (LED-07). */
export function assembleLedger(input: AssembleLedgerInput): AssembledLedger {
	let sections: Sections | undefined;
	let block = "";
	const providers = memoizeProviders(input.providers);
	const memoInput = { ...input, providers };
	let flowAssociated = false;
	try {
		flowAssociated = providers.flow?.()?.associated ?? false;
	} catch {
		flowAssociated = false;
	}
	for (let level = 0; level <= 6; level += 1) {
		sections = buildSections(memoInput, level);
		block = renderBlock(sections);
		if (block.length <= COMPACTION_LEDGER_MAX) break;
	}
	// B2 (2026-11-10 review): the ladder is exhausted and the block is STILL
	// over budget → return an empty block with a failed self-check (reason
	// ledger-over-budget). NEVER hard-truncate the string — that could cut
	// the closing tag or a Tier A identity field. The caller (tryPropose)
	// then takes the existing v6-summary-invalid discard path.
	let check = selfCheck(sections!, block, input.region, input.settings);
	if (block.length > COMPACTION_LEDGER_MAX) {
		check = { ok: false, missing: [...check.missing, "ledger-over-budget"] };
		block = "";
	}
	return {
		block: block.length > 0 ? block : "",
		chars: block.length,
		degradation: sections!.degradation,
		selfCheck: check,
		closedIds: sections!.closedIds,
		flowAssociated,
	};
}

/** Narrative header (LED-06): trust wording depends on board association. */
export function narrativeHeader(flowTrusted: boolean): string {
	return flowTrusted
		? "以下叙述基于第 N 回合快照；与台账冲突时以台账为准（含已关联 board 的 flow 状态）"
		: "以下叙述基于第 N 回合快照；flow 部分基于对话内哨兵，可能不全，请以 board 为准并重读";
}
