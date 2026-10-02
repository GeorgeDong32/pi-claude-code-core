/**
 * Static context-budget split shared by the rules and memory modules
 * (P3-RU-10). Values are constants, not an allocator: two producers with a
 * fixed split is enough until a third injection source appears.
 *
 * The split is published read-only on the bus snapshot as the optional
 * `contextBudget` channel (adding an optional field does not bump the
 * protocol version).
 *
 * RV recall lane (spec 2026-10-02-memory-recall-v2, D10/RV-17): the recall
 * constants below live here so every budget authority shares one home,
 * but they are deliberately NOT part of the published CONTEXT_BUDGET
 * object — recall has no external consumer (rules-wiring.test.ts pins the
 * object shape). Units are UTF-8 bytes for *_BYTES and characters for
 * QUERY_*.
 */

export const RULES_MAX = 40_000;
export const MEMORY_INDEX_MAX = 25_000;
export const DYNAMIC_STEER_MAX = 8_000;

/** Recall selection caps (RV-08): files delivered per user message. */
export const RECALL_MAX_FILES = 5;
/** Recall selection caps (RV-08): per-file body budget — oversized files
 * are truncated with a path note, never skipped whole (D7). */
export const RECALL_FILE_MAX_BYTES = 4_096;
/** Recall selection caps (RV-08): session-lifetime injection budget. */
export const RECALL_SESSION_MAX_BYTES = 60 * 1_024;
/** Recall query hygiene (RV-02): shorter-than-this user text skips recall
 * (single-word / "continue"-class messages). */
export const RECALL_QUERY_MIN_CHARS = 6;
/** Recall query hygiene (RV-02): oversized user text is head-truncated. */
export const RECALL_QUERY_MAX_CHARS = 4_000;
/** Recall manifest cap (RV-12): max candidate rows shown to the selector. */
export const RECALL_MANIFEST_MAX = 200;

export interface ContextBudget {
	rulesMax: number;
	memoryIndexMax: number;
	dynamicSteerMax: number;
}

export const CONTEXT_BUDGET: ContextBudget = {
	rulesMax: RULES_MAX,
	memoryIndexMax: MEMORY_INDEX_MAX,
	dynamicSteerMax: DYNAMIC_STEER_MAX,
};
