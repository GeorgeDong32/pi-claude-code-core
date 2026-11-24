
export const RULES_MAX = 40_000;
export const MEMORY_INDEX_MAX = 25_000;
export const DYNAMIC_STEER_MAX = 8_000;

export const RECALL_MAX_FILES = 3;
export const RECALL_FILE_MAX_BYTES = 4_096;
export const RECALL_SESSION_MAX_BYTES = 16 * 1_024;
export const RECALL_QUERY_MIN_CHARS = 6;
export const RECALL_QUERY_MAX_CHARS = 4_000;
export const RECALL_MANIFEST_MAX = 200;

export const COMPACTION_LEDGER_MAX = 12_000;

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
