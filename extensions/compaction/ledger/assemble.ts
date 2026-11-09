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

	// ── Open work: goals (+ flow in W7) ──
	const goalState = safe("goal", providers.goal, undefined);
	const goal = goalState ? goalSection(goalState) : { openLines: [], closed: [], identities: [], closedIds: [] };
	let openLines: string[] = [];
	if (level >= 5) {
		// ⑤ clamp description fields — identity fields stay verbatim.
		openLines = goal.openLines.map((line) => clampDescription(line, 80));
		degradation.tierADegraded += 1;
	} else {
		openLines = [...goal.openLines];
	}
	const flowState = safe("flow", providers.flow, undefined);
	if (flowState) {
		openLines.push(...flowLines(flowState, level >= 5 ? 60 : 120));
		if (level >= 5) degradation.tierADegraded += 1;
	}
	// ⑥ maxOpenItems overflow → external pointer (Tier D).
	const identityCount = goal.identities.length + (flowState?.openRuns.length ?? 0);
	if (identityCount > settings.maxOpenItems) {
		const pointer = flowState?.boardPath ? `full list in ${flowState.boardPath}` : "full list in .pi/goals/";
		openLines.push(`+${identityCount - settings.maxOpenItems} more open items — ${pointer}`);
		degradation.openOverflow = identityCount - settings.maxOpenItems;
	}

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
	const verification = safe("verification", providers.verification, undefined)
		?? scanVerification(region);
	const verificationLines: string[] = [];
	if (verification.lastTest) {
		verificationLines.push(`last test: \`${verification.lastTest.command}\` → ${verification.lastTest.result}`);
	}
	if (level < 2 && verification.lastCommit) {
		verificationLines.push(`last commit: ${verification.lastCommit.hash.slice(0, 10)} ${clampDescription(verification.lastCommit.subject, 60)}`);
	}

	// ── Background (④ at level ≥4: bare one-liners) ──
	const bgItems = safe("bg", providers.bg, []);
	const bg = bgSection(bgItems);
	const backgroundLines = level >= 4
		? bgItems.map((item) => `- ${item.id} [${item.kind}] ${item.status}`)
		: bg.lines;

	// ── Closed (① at level ≥1: count only) ──
	const closedItems = [...goal.closed, ...(flowState?.closed ?? [])];
	const closedLines = level >= 1
		? [`(${closedItems.length} closed items — see session/board)`]
		: closedItems.map((item) => `- ✔ ${item.id} ${clampDescription(item.label, 60)}${item.detail ? ` — ${item.detail}` : ""}`);

	return {
		openWork: openLines,
		directives: rendered.lines,
		verification: verificationLines,
		background: backgroundLines,
		closed: closedLines,
		identities: [...goal.identities, ...bg.identities, ...(flowState?.openRuns.map((run) => ({ source: "flow" as const, id: run.runId, status: run.stage })) ?? [])],
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

function renderBlock(sections: Sections): string {
	const parts: string[] = [BLOCK_OPEN];
	const section = (heading: string, lines: string[]) => {
		if (lines.length === 0) return;
		parts.push(`## ${heading}`);
		parts.push(...lines);
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

/** Assemble with the LED-01 ladder. Never throws (LED-07). */
export function assembleLedger(input: AssembleLedgerInput): AssembledLedger {
	let sections: Sections | undefined;
	let block = "";
	for (let level = 0; level <= 6; level += 1) {
		sections = buildSections(input, level);
		block = renderBlock(sections);
		if (block.length <= COMPACTION_LEDGER_MAX) break;
	}
	const check = selfCheck(sections!, block, input.region, input.settings);
	return {
		block: block.length > 0 ? block : "",
		chars: block.length,
		degradation: sections!.degradation,
		selfCheck: check,
		closedIds: sections!.closedIds,
	};
}

/** Narrative header (LED-06): trust wording depends on board association. */
export function narrativeHeader(flowTrusted: boolean): string {
	return flowTrusted
		? "以下叙述基于第 N 回合快照；与台账冲突时以台账为准（含已关联 board 的 flow 状态）"
		: "以下叙述基于第 N 回合快照；flow 部分基于对话内哨兵，可能不全，请以 board 为准并重读";
}
