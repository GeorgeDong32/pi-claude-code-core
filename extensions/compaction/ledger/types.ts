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

export type DirectiveClass = "standing" | "normal" | "flow-dispatch";

export interface LedgerDirective {
	class: DirectiveClass;
	text: string;
	entryId: string;
	time?: string;
	folded?: "head" | "pointer";
}

export interface BgItem {
	id: string;
	kind: "bg" | "subagent" | "flow-watch";
	status: string;
	label: string;
	timeoutMs?: number;
}

export interface VerificationData {
	lastTest?: { command: string; result: "pass" | "fail" | "unknown"; at?: string };
	lastCommit?: { hash: string; subject: string };
}

export interface FileActivity {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface GoalLedgerState {
	goalsById: ReadonlyMap<string, GoalRecord>;
	focusedGoalId: string | null;
	ledgerEvents: GoalLedgerEvent[];
}

export interface FlowLedgerState {
	associated: boolean;
	boardPath?: string;
	openRuns: Array<{
		runId: string;
		objective: string;
		stage: string;
		spec?: string;
		tasks: Array<{ id: string; status: string; branch?: string; tab?: string; reworkCount?: number; note?: string }>;
		openGates: Array<{ id: string; question: string; ref?: string }>;
		lastSentinels: string[];
	}>;
	closed: ClosedItem[];
	sentinels: string[];
	otherOpenRuns: number;
}

export interface ClosedItem {
	id: string;
	label: string;
	detail?: string;
}

export interface OpenIdentity {
	source: "goal" | "bg" | "flow";
	id: string;
	status: string;
}

export interface LedgerDegradation {
	tierADegraded: number;
	directivesCollapsed: number;
	directivesPointerOnly: number;
	openOverflow: number;
}

export interface AssembledLedger {
	block: string;
	chars: number;
	degradation: LedgerDegradation;
	selfCheck: { ok: boolean; missing: string[] };
	closedIds: string[];
	flowAssociated: boolean;
}

export interface LedgerProviders {
	goal?: () => GoalLedgerState | undefined;
	bg?: () => BgItem[];
	verification?: () => VerificationData;
	flow?: () => FlowLedgerState | undefined;
	previousSummary?: string;
}

export interface CompressedRegionView {
	entries: Array<{ sourceEntry: SessionEntry; messages: AgentMessage[] }>;
}
