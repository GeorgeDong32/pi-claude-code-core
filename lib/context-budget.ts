/**
 * Static context-budget split shared by the rules and memory modules
 * (P3-RU-10). Values are constants, not an allocator: two producers with a
 * fixed split is enough until a third injection source appears.
 *
 * The split is published read-only on the bus snapshot as the optional
 * `contextBudget` channel (adding an optional field does not bump the
 * protocol version).
 */

export const RULES_MAX = 40_000;
export const MEMORY_INDEX_MAX = 25_000;
export const DYNAMIC_STEER_MAX = 8_000;

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
