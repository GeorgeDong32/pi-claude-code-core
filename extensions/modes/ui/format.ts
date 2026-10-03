/**
 * modes/ui/format.ts — compact token-count formatting for usage display.
 * Carved out of the old modes/utils.ts grab-bag (arch review C3, 2026-10-03).
 */
/** Compact token count, e.g. 1234 -> "1.2k", 12000 -> "12k". */
export function formatCount(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	const k = n / 1000;
	return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}
