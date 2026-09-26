/**
 * memory/constants.ts — V2 budgets and thresholds (DESIGN-MEMORY-V2 §5/§8).
 *
 * The memory injection lane keeps its fixed total (lib/context-budget
 * MEMORY_INDEX_MAX = 25KB): the user layer renders first capped at
 * USER_INDEX_MAX, the project layer gets whatever remains. Pinned bodies
 * (V2-D5) render inside the user-layer budget so the lane total never moves.
 */

/** User-layer index + pinned budget (renders before the project index). */
export const USER_INDEX_MAX = 8_000;

/** Pinned bodies section cap, shared across all pinned files (hermes
 * STANDING_MAX_CHARS=2000 semantics — always-on instructions must stay tiny). */
export const PINNED_TOTAL_MAX = 2_000;
export const PINNED_MAX_FILES = 5;

/** Per-file body cap enforced by the ops engine / memory_consolidate. */
export const MEMORY_FILE_BODY_MAX = 8 * 1024;

/** Per-layer file count cap (consolidation trigger co-signal). */
export const MEMORY_FILES_MAX = 80;

/** Consolidation trigger: entries beyond this count need consolidation even
 * when the index bytes fit (mirrors memdir INDEX_MAX_LINES). */
export const CONSOLIDATE_COUNT_THRESHOLD = 200;
