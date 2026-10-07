/**
 * footer-lines.ts — multi-source `display.footer` publisher (SPEC
 * 2026-10-07 P1-1 §4.4, F1 decision B).
 *
 * The bus shallow-merges patches, so two modules each publishing
 * `{ display: { footer: [line] } }` overwrite each other. This helper owns
 * ONE `Map<source, line>` per bus instance (WeakMap-keyed — a reset/reload
 * builds a new bus and must not inherit the old bus's lines, B8) and always
 * publishes the WHOLE footer array, sorted by source, as one patch.
 *
 * Discipline: call this only inside a pi event handler, synchronously (no
 * await gaps) — it publishes. Setting undefined removes that source's line;
 * removing the last line still publishes an EMPTY array (omitting the field
 * would keep the stale previous value — the bus only merges).
 */
import { coreBus, type CoreBus } from "../bus.ts";

const linesByBus = new WeakMap<CoreBus, Map<string, string>>();

function linesFor(bus: CoreBus): Map<string, string> {
	let m = linesByBus.get(bus);
	if (!m) {
		m = new Map();
		linesByBus.set(bus, m);
	}
	return m;
}

/** Set (or remove, with undefined) one source's footer line and publish the
 *  whole merged array. Same-source overwrites are idempotent. */
export function setFooterLine(source: string, line: string | undefined): void {
	const bus = coreBus();
	const lines = linesFor(bus);
	if (line === undefined) lines.delete(source);
	else lines.set(source, line);
	const merged = [...lines.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, value]) => value);
	bus.publish({ display: { footer: merged } });
}
