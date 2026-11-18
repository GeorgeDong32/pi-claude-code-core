export function formatCount(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	const k = n / 1000;
	return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}
