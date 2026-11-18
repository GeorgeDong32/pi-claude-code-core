
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
