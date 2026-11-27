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
