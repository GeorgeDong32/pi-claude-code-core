/**
 * Shared permission-rule text helpers (Standards #4 of REVIEW-2026-09-22:
 * the ruleValue→text extraction had four copies and the trailing-wildcard
 * match two — one deep point instead).
 *
 * Callers: modes/rule-families, mcp-gov/family, mcp-gov/index, web-gov.
 *
 * Self-contained on purpose: lib must not depend back on extensions/ (the
 * value shape mirrors modes' PermissionRuleValue structurally).
 */

interface RuleLike {
	ruleValue: unknown;
}

interface RuleValueShape {
	toolName: string;
	ruleContent?: string;
}

/** Serialize a rule's value to its canonical rule-file text. */
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

/** Escape `\`, `(`, `)` — same grammar as modes' permission-rule-parser. */
function escapeRuleContent(content: string): string {
	return content
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)");
}

/** Exact match or trailing-wildcard prefix match (`mcp_exa_*`). */
export function ruleMatchesId(text: string, canonicalId: string): boolean {
	return text === canonicalId || (text.endsWith("*") && canonicalId.startsWith(text.slice(0, -1)));
}

/** True when `path` is `dir` itself or inside it (separator-aware). */
export function isInsideDir(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`);
}
