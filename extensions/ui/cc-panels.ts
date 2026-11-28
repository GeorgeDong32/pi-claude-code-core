import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ccPanel, type BodyLine, type CcPanelParts, type CcRowTheme, type RowsComponent } from "./cc-rows.ts";


export interface PanelMessage {
	content?: unknown;
	details?: unknown;
}

export interface PanelRenderOptions {
	expanded: boolean;
	outputPad?: number;
}

function contentText(message: PanelMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (block != null && typeof block === "object" && (block as { type?: string }).type === "text") {
				const text = (block as { text?: unknown }).text;
				if (typeof text === "string") parts.push(text);
			}
		}
		return parts.join("\n");
	}
	return "";
}

function commandFromDetails(message: PanelMessage): string | undefined {
	const details = message.details;
	if (details == null || typeof details !== "object") return undefined;
	const command = (details as { command?: unknown }).command;
	return typeof command === "string" && command.length > 0 ? command : undefined;
}


export function shapeCoreStatus(message: PanelMessage): CcPanelParts {
	const lines = contentText(message).split("\n");
	const header = lines[0] ?? "";
	if (!header.startsWith("# /core — ")) return { body: lines };
	const section = header.slice("# /core — ".length);
	const statusMatch = section.match(/ \[(\w+)\]$/);
	const title = statusMatch ? section.slice(0, -statusMatch[0].length) : section;
	const bullets = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
	if (bullets.length === 0) return { summary: title, body: lines.slice(1) };
	const first = bullets[0]!;
	const exposure = first.match(/^exposure of "(.+?)" → (\S+) \((.+)\)$/);
	if (exposure) {
		return {
			bar: commandFromDetails(message),
			summary: `exposure of "${exposure[1]}" → ${exposure[2]}`,
			body: [exposure[3]!],
		};
	}
	if (first.startsWith("mcp: ")) {
		return {
			bar: commandFromDetails(message),
			summary: `${title}${statusMatch ? ` · ${statusMatch[1]}` : ""} — ${first.slice("mcp: ".length)}`,
			body: bullets.slice(1),
		};
	}
	return { bar: commandFromDetails(message), summary: title, body: bullets };
}

export function shapeReviewAgents(message: PanelMessage): CcPanelParts {
	const lines = contentText(message).split("\n");
	const body: BodyLine[] = [];
	let enabled = 0;
	let agents = 0;
	for (let i = 0; i < lines.length; i++) {
		const head = lines[i]!.match(/^- \*\*(.+?)\*\* \((.+?)\) — (enabled|disabled)$/);
		if (!head) continue;
		agents++;
		if (head[3] === "enabled") enabled++;
		let model = "";
		let thinking = "default";
		for (let j = i + 1; j < lines.length && lines[j]!.startsWith("  - "); j++) {
			const m = lines[j]!.match(/^  - model: (.+)$/);
			if (m) model = m[1]!;
			const t = lines[j]!.match(/^  - thinking: (.+)$/);
			if (t) thinking = t[1]!;
		}
		const tail = [` (${head[2]})`, ` — ${head[3]}`];
		if (model) tail.push(` · ${model}`);
		tail.push(` · thinking ${thinking}`);
		body.push({ strong: head[1]!, rest: tail.join("") });
	}
	const gate = lines.find((l) => l.startsWith("Gate: "))?.slice("Gate: ".length);
	const routing = lines.find((l) => l.startsWith("Routing: "))?.slice("Routing: ".length);
	if (agents === 0) return { bar: commandFromDetails(message), body: lines };
	const summary = [`review agents: ${enabled} enabled`];
	if (gate) summary.push(` · gate ${gate}`);
	if (routing) summary.push(` · ${routing}`);
	return { bar: commandFromDetails(message), summary: summary.join(""), body };
}

export function shapeModelProfiles(message: PanelMessage): CcPanelParts {
	const lines = contentText(message).split("\n");
	if (lines[0] !== "Model profiles:") return { bar: commandFromDetails(message), body: lines };
	const body: BodyLine[] = [];
	for (const line of lines.slice(1)) {
		const active = line.match(/^(.+?) \(active\): (.+)$/);
		if (active) body.push({ strong: `${active[1]} (active)`, rest: `: ${active[2]}` });
		else body.push(line);
	}
	return { bar: commandFromDetails(message), summary: `model profiles: ${body.length}`, body };
}

export function shapePermissions(message: PanelMessage): CcPanelParts {
	const text = contentText(message).replace(/\*\*/g, "");
	const fences = [...text.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]!.replace(/\n$/, ""));
	const rulesFence = fences[0];
	if (!rulesFence) return { bar: commandFromDetails(message), body: text.split("\n") };
	const ruleLines = rulesFence.split("\n");
	const counts: Record<string, number> = {};
	let current = "";
	for (const line of ruleLines) {
		const section = line.match(/^(allow|ask|deny):$/);
		if (section) {
			current = section[1]!;
			counts[current] = 0;
		} else if (current && line.trim().length > 0) {
			counts[current] = (counts[current] ?? 0) + 1;
		}
	}
	const grantFence = fences[1];
	const grantLines = grantFence ? grantFence.split("\n").filter((l) => l.trim().length > 0) : [];
	const summary = `permission rules: ${counts.allow ?? 0} allow · ${counts.ask ?? 0} ask · ${counts.deny ?? 0} deny`
		+ (grantLines.length > 0 ? ` · ${grantLines.length} session grant${grantLines.length === 1 ? "" : "s"}` : "");
	const body: BodyLine[] = [...ruleLines];
	for (const g of grantLines) body.push(g);
	if (grantLines.length > 0) body.push(`clear with /permissions-clear-grants`);
	return { bar: commandFromDetails(message), summary, body };
}

export function shapeOutsideWrites(message: PanelMessage): CcPanelParts {
	const lines = contentText(message).split("\n");
	const count = (lines[0] ?? "").match(/^Tracked outside-cwd writes \((\d+)\):$/);
	if (!count) return { bar: commandFromDetails(message), body: lines };
	return {
		bar: commandFromDetails(message),
		summary: `tracked outside-cwd writes: ${count[1]}`,
		body: lines.slice(1),
	};
}

export function shapeModesExecute(message: PanelMessage): CcPanelParts {
	const lines = contentText(message).split("\n");
	const steps = lines.filter((l) => /^\d+\.\s/.test(l));
	if (steps.length === 0) return { body: lines };
	const body: BodyLine[] = [...steps, "start with step 1 · tag each finished step [DONE:n]"];
	return {
		bar: `Execute the plan now — ${steps.length} steps (plan approved)`,
		body,
	};
}

export function shapePlanComplete(_message: PanelMessage): CcPanelParts {
	return { single: { title: "Plan Complete", tail: { text: " ✓", color: "success" } } };
}

export function shapeRulesList(message: PanelMessage): CcPanelParts {
	const lines = contentText(message).split("\n");
	const first = lines[0] ?? "";
	if (!first.startsWith("rules: ")) return { bar: commandFromDetails(message), body: lines };
	return {
		bar: commandFromDetails(message),
		summary: first.replace(/, /g, " · "),
		body: lines.slice(1).filter((l, i) => !(i === 0 && l === "")),
	};
}

export function shapeRulesActivate(message: PanelMessage): CcPanelParts {
	return { body: contentText(message).split("\n") };
}


export type PanelShaper = (message: PanelMessage) => CcPanelParts;

/** A failing shape returns undefined so pi's CustomMessageComponent falls
 * back to its native rendering. */
export function panelRenderer(shape: PanelShaper): (message: PanelMessage, options: PanelRenderOptions, theme: CcRowTheme) => RowsComponent | undefined {
	return (message, options, theme) => {
		try {
			return ccPanel(shape(message), theme, options.expanded);
		} catch {
			return undefined;
		}
	};
}

export const CC_PANEL_SHAPERS: Readonly<Record<string, PanelShaper>> = {
	"pi-core-status": shapeCoreStatus,
	"pi-review-agents": shapeReviewAgents,
	"model-profile-list": shapeModelProfiles,
	"permissions-list": shapePermissions,
	"outside-writes-list": shapeOutsideWrites,
	"modes-execute": shapeModesExecute,
	"plan-complete": shapePlanComplete,
	"pi-rules-list": shapeRulesList,
	"pi-rules-activate": shapeRulesActivate,
};

export function registerCcPanels(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
	for (const [customType, shape] of Object.entries(CC_PANEL_SHAPERS)) {
		pi.registerMessageRenderer(customType, panelRenderer(shape));
	}
}
