/*
 * Smart Compaction ledger types (SPEC SC §5.6, task W6).
 *
 * The ledger is DETERMINISTIC (no LLM), regenerated at apply time, and
 * describes the current truth (LED-06). These shapes are shared by the
 * section builders, the assembler (degradation ladder + self-check) and the
 * W7 rex-flow provider.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GoalRecord } from "../../goal/goal-record.ts";
import type { GoalLedgerEvent } from "../../goal/goal-ledger.ts";

/** LED-02 directive classes. */
export type DirectiveClass = "standing" | "normal" | "flow-dispatch";

/** One human directive from the compressed region (or carried over). */
export interface LedgerDirective {
	class: DirectiveClass;
	/** Full text (may be folded later). */
	text: string;
	/** Session entry id for the pointer form. */
	entryId: string;
	/** ISO timestamp for the pointer form. */
	time?: string;
	/** Set when the budget ladder folded this directive. */
	folded?: "head" | "pointer";
}

/** In-flight background item (LED-04 Background; Tier A). */
export interface BgItem {
	id: string;
	kind: "bg" | "subagent" | "flow-watch";
	status: string;
	/** Short label, e.g. the command or watch target. */
	label: string;
	timeoutMs?: number;
}

/** LED-04 Verification data. */
export interface VerificationData {
	lastTest?: { command: string; result: "pass" | "fail" | "unknown"; at?: string };
	lastCommit?: { hash: string; subject: string };
}

/** File activity scan result (ledger/files.ts). */
export interface FileActivity {
	readFiles: string[];
	modifiedFiles: string[];
}

/** Goal provider payload (LED-03 reuses goal's own builder). */
export interface GoalLedgerState {
	goalsById: ReadonlyMap<string, GoalRecord>;
	focusedGoalId: string | null;
	ledgerEvents: GoalLedgerEvent[];
}

/**
 * W7 rex-flow provider payload (defined here because assemble.ts consumes
 * it; ledger/rex-flow.ts fills it). `associated` = LED-05b passed — without
 * it the ledger degrades to sentinel-only and never claims board truth.
 */
export interface FlowLedgerState {
	associated: boolean;
	boardPath?: string;
	/** Full detail rows for open runs OBSERVED by this session (LED-05). */
	openRuns: Array<{
		runId: string;
		objective: string;
		stage: string;
		spec?: string;
		tasks: Array<{ id: string; status: string; branch?: string; tab?: string; reworkCount?: number; note?: string }>;
		openGates: Array<{ id: string; question: string; ref?: string }>;
		lastSentinels: string[];
	}>;
	/** Closed one-liners (LED-05: ≤8 rows + overflow). */
	closed: ClosedItem[];
	/** Sentinel-only lines when no associated board (LED-05b degradation). */
	sentinels: string[];
	/** Count of OTHER open runs on the board not touched by this session. */
	otherOpenRuns: number;
}

/** A closed item for the one-line section (goals, runs, tasks). */
export interface ClosedItem {
	id: string;
	/** ≤60 chars. */
	label: string;
	detail?: string;
}

/** Tier A open item as passed to the self-check (LED-08). */
export interface OpenIdentity {
	source: "goal" | "bg" | "flow";
	id: string;
	status: string;
}

/** Degradation counters surfaced through telemetry (LED-01). */
export interface LedgerDegradation {
	tierADegraded: number;
	directivesCollapsed: number;
	directivesPointerOnly: number;
	openOverflow: number;
}

export interface AssembledLedger {
	/** The full `<cc-core-ledger v="1">…</cc-core-ledger>` block (or ""). */
	block: string;
	chars: number;
	degradation: LedgerDegradation;
	/** LED-08 self-check: every Tier A id+status and Tier B pointer line
	 * must be findable in `block`; missing ⇒ do not propose. */
	selfCheck: { ok: boolean; missing: string[] };
	/** Closed ids for the narrative prompt (SUM-08). */
	closedIds: string[];
	/** F1 (2026-11-10 review final): flow board association, from the
	 * memoized provider result (false when the provider threw/absent) —
	 * callers stop re-invoking providers.flow for LED-06 wording. */
	flowAssociated: boolean;
}

/** Providers injected by index.ts (W4); each is independently try/caught
 * (LED-07) and must be SYNCHRONOUS. */
export interface LedgerProviders {
	goal?: () => GoalLedgerState | undefined;
	bg?: () => BgItem[];
	verification?: () => VerificationData;
	/** W7: rex-flow provider (sentinel + associated board). */
	flow?: () => FlowLedgerState | undefined;
	/** Previous compaction summary (LED-02b carry-over). */
	previousSummary?: string;
}

/** View of the compressed region the builders scan (post-context_edit). */
export interface CompressedRegionView {
	entries: Array<{ sourceEntry: SessionEntry; messages: AgentMessage[] }>;
}
