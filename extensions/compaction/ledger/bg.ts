/*
 * Ledger background section (SPEC SC §5.6 LED-04 Background, task W6).
 *
 * Renders in-flight background items (bg-shell tasks, subagents, flow-watch
 * listeners) — one line each. Items arrive through the injected provider
 * (LED-07 isolation); the W4 assembly wires bg-shell's real state; items
 * that end are simply absent from the next provider call (完成即移除).
 */

import type { BgItem, OpenIdentity } from "./types.ts";

export interface BgSection {
	lines: string[];
	identities: OpenIdentity[];
}

function renderBgItem(item: BgItem): string {
	const timeout = item.timeoutMs !== undefined ? ` timeout=${Math.round(item.timeoutMs / 1000)}s` : "";
	const label = item.label.length > 60 ? `${item.label.slice(0, 60)}…` : item.label;
	return `- ${item.id} [${item.kind}] ${item.status} — \`${label}\`${timeout}`;
}

export function bgSection(items: BgItem[]): BgSection {
	return {
		lines: items.map(renderBgItem),
		identities: items.map((item) => ({ source: "bg" as const, id: item.id, status: item.status })),
	};
}
