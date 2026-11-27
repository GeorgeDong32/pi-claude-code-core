import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompressedRegionView, LedgerDirective } from "./types.ts";

const FLOW_DISPATCH_PATTERNS: RegExp[] = [
	/【(worker|planner|gatekeeper|orchestrator)】/,
	/读[^\n]{0,80}dispatch[^]{0,80}(开工|派单)/,
	/(read|follow)[^]{0,80}dispatch[^]{0,80}(start|begin|work)/i,
	/===FLOW-DISPATCH===/,
];

export function isFlowDispatch(text: string): boolean {
	return FLOW_DISPATCH_PATTERNS.some((pattern) => pattern.test(text));
}

export function isStanding(text: string, patterns: readonly string[]): boolean {
	const lower = text.toLowerCase();
	return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

export function collectDirectives(region: CompressedRegionView, standingPatterns: readonly string[]): LedgerDirective[] {
	const out: LedgerDirective[] = [];
	for (const { sourceEntry, messages } of region.entries) {
		if ((sourceEntry as { type?: string }).type !== "message") continue;
		for (const message of messages) {
			if (message.role !== "user") continue;
			const text = textOf(message).trim();
			if (text.length === 0) continue;
			const entryId = (sourceEntry as { id?: string }).id ?? "";
			const directive: LedgerDirective = {
				class: isFlowDispatch(text) ? "flow-dispatch" : isStanding(text, standingPatterns) ? "standing" : "normal",
				text,
				entryId,
				time: (sourceEntry as { timestamp?: string }).timestamp,
			};
			out.push(directive);
		}
	}
	return out;
}

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}


export const LEDGER_BLOCK_OPEN = '<cc-core-ledger v="1">';
export const LEDGER_BLOCK_CLOSE = "</cc-core-ledger>";

export function renderDirectiveText(text: string): string {
	return text.replace(/\n/g, "\n  ");
}

export function clampDirectiveText(text: string, perDirectiveMax: number): string {
	return text.length > perDirectiveMax ? `${text.slice(0, perDirectiveMax)}… [truncated]` : text;
}

export function lastLedgerBlockBody(summary: string | undefined): string | undefined {
	if (!summary || summary.length === 0) return undefined;
	const open = summary.lastIndexOf(LEDGER_BLOCK_OPEN);
	if (open === -1) return undefined;
	const close = summary.indexOf(LEDGER_BLOCK_CLOSE, open);
	if (close === -1) return undefined;
	return summary.slice(open + LEDGER_BLOCK_OPEN.length, close);
}

export function parseCarriedDirectives(previousSummary: string | undefined): { directives: LedgerDirective[]; dropped: boolean } {
	const block = lastLedgerBlockBody(previousSummary);
	if (block === undefined) return { directives: [], dropped: false };
	const section = sectionOf(block, "Directives");
	if (section === undefined) return { directives: [], dropped: false };
	const directives: LedgerDirective[] = [];
	const logical: string[] = [];
	for (const raw of section.split("\n")) {
		if (raw.startsWith("  ") && logical.length > 0) {
			logical[logical.length - 1] = `${logical[logical.length - 1]!}\n${raw.slice(2)}`;
			continue;
		}
		logical.push(raw);
	}
	for (const raw of logical) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("##")) continue;
		const pointer = /\[#([^\] ]+) @([^\]]+)\]\s*$/.exec(line);
		const kind = line.startsWith("-") || line.startsWith("*") ? line.slice(1).trim() : line;
		if (pointer) {
			const body = kind.slice(0, kind.length - pointer[0].length).trim();
			const foldedPointer = body === "(see session)" || body.endsWith("…");
			directives.push({
				class: isFlowDispatch(body) ? "flow-dispatch" : "standing",
				text: body,
				entryId: pointer[1],
				time: pointer[2],
				folded: foldedPointer ? "pointer" : undefined,
			});
			continue;
		}
		if (line.startsWith("+") && /older directives/.test(line)) continue;
		if (/^\(see session\)/.test(kind)) continue;
		directives.push({
			class: isFlowDispatch(kind) ? "flow-dispatch" : "standing",
			text: kind,
			entryId: "",
		});
	}
	return { directives, dropped: false };
}

function sectionOf(block: string, heading: string): string | undefined {
	const marker = new RegExp(`^#{1,3}\\s*${heading}`, "m").exec(block);
	if (!marker) return undefined;
	const rest = block.slice(marker.index + marker[0].length);
	const nl = rest.indexOf("\n");
	const body = nl === -1 ? "" : rest.slice(nl);
	const next = body.search(/^#{1,3}\s*/m);
	return next === -1 ? body : body.slice(0, next);
}


export interface DirectivesBudget {
	directivesMax: number;
	perDirectiveMax: number;
	maxDirectiveLines: number;
	foldHeadChars: number;
}

export interface RenderedDirectives {
	lines: string[];
	degradation: { collapsed: number; pointerOnly: number };
}

export function renderDirectives(directives: LedgerDirective[], budget: DirectivesBudget): RenderedDirectives {
	const byEntry = new Map<string, LedgerDirective>();
	const ordered: LedgerDirective[] = [];
	for (const directive of directives) {
		if (directive.entryId && byEntry.has(directive.entryId)) continue;
		if (directive.entryId) byEntry.set(directive.entryId, directive);
		ordered.push(directive);
	}
	const standing = ordered.filter((d) => d.class === "standing").reverse();
	const normal = ordered.filter((d) => d.class === "normal").reverse();
	const flow = ordered.filter((d) => d.class === "flow-dispatch");

	const degradation = { collapsed: 0, pointerOnly: 0 };
	const clamp = (text: string): string => clampDirectiveText(text, budget.perDirectiveMax);

	const sourceOf = (directive: LedgerDirective): string =>
		directive.entryId ? ` [#${directive.entryId} @${directive.time ?? "?"}]` : "";
	const renderOne = (directive: LedgerDirective, foldLevel: "verbatim" | "head" | "pointer"): string => {
		if (foldLevel === "verbatim") return `- ${renderDirectiveText(clamp(directive.text))}${sourceOf(directive)}`;
		if (foldLevel === "head") {
			degradation.collapsed += 1;
			return `- ${renderDirectiveText(directive.text.slice(0, budget.foldHeadChars))}…${sourceOf(directive)}`;
		}
		degradation.pointerOnly += 1;
		return `- (see session)${sourceOf(directive)}`;
	};

	const foldState = new Map<LedgerDirective, "verbatim" | "head" | "pointer">();
	const ranked = [...standing, ...normal];
	for (const d of ranked) foldState.set(d, d.folded === "pointer" ? "pointer" : "verbatim");
	const renderedLen = (d: LedgerDirective): number => {
		const sourceLen = d.entryId ? d.entryId.length + (d.time?.length ?? 1) + 6 : 0;
		const state = foldState.get(d) ?? "verbatim";
		if (state === "verbatim") return clamp(d.text).length + 2 + sourceLen;
		if (state === "head") return budget.foldHeadChars + 3 + sourceLen;
		return 16 + sourceLen;
	};
	const fits = (): boolean => ranked.reduce((sum, d) => sum + renderedLen(d), 0) <= budget.directivesMax;
	const foldOrder = [...normal.slice().reverse(), ...standing.slice().reverse()];
	const steps: Array<() => void> = [];
	for (const d of foldOrder) steps.push(() => foldState.set(d, "head"));
	for (const d of foldOrder) {
		if (d.entryId) steps.push(() => foldState.set(d, "pointer"));
	}
	let stepIdx = 0;
	while (!fits() && stepIdx < steps.length) steps[stepIdx++]();

	let lines: string[] = [];
	for (const d of standing) lines.push(renderOne(d, foldState.get(d) ?? "verbatim"));
	for (const d of normal) lines.push(renderOne(d, foldState.get(d) ?? "verbatim"));
	for (const d of flow) lines.push(renderOne(d, "verbatim"));

	if (lines.length > budget.maxDirectiveLines) {
		const kept = lines.slice(0, budget.maxDirectiveLines);
		kept.push(`+${lines.length - budget.maxDirectiveLines} older directives — originals remain in the session file`);
		lines = kept;
	}
	return { lines, degradation };
}
