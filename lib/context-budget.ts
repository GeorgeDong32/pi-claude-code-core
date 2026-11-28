
export const RULES_MAX = 40_000;
export const MEMORY_INDEX_MAX = 25_000;
export const DYNAMIC_STEER_MAX = 8_000;

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
