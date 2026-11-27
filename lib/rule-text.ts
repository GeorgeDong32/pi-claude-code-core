interface RuleLike {
	ruleValue: unknown;
}

interface RuleValueShape {
	toolName: string;
	ruleContent?: string;
}

export function ruleValueText(rule: RuleLike): string {
	const value = rule.ruleValue;
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const { toolName, ruleContent } = value as RuleValueShape;
		if (typeof toolName === "string") {
			if (!ruleContent) return toolName;
			return `${toolName}(${escapeRuleContent(ruleContent)})`;
		}
	}
	return String(value);
}

function escapeRuleContent(content: string): string {
	return content
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)");
}

export function ruleMatchesId(text: string, canonicalId: string): boolean {
	return text === canonicalId || (text.endsWith("*") && canonicalId.startsWith(text.slice(0, -1)));
}

export function isInsideDir(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`);
}
