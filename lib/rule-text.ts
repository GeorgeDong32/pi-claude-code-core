/**
 * Shared permission-rule text helpers (Standards #4 of REVIEW-2026-09-22:
 * the ruleValue→text extraction had four copies and the trailing-wildcard
 * match two — one deep point instead).
 *
 * Callers: modes/rule-families, mcp-gov/family, mcp-gov/index, web-gov.
 */

import { permissionRuleValueToString } from "../extensions/modes/permission-rule-parser.ts";

interface RuleLike {
	ruleValue: unknown;
}

/** Serialize a rule's value to its canonical rule-file text. */
export function ruleValueText(rule: RuleLike): string {
	const value = rule.ruleValue;
	if (typeof value === "string") return value;
	try {
		return permissionRuleValueToString(value as never);
	} catch {
		return String(value);
	}
}

/** Exact match or trailing-wildcard prefix match (`mcp_exa_*`). */
export function ruleMatchesId(text: string, canonicalId: string): boolean {
	return text === canonicalId || (text.endsWith("*") && canonicalId.startsWith(text.slice(0, -1)));
}

/** True when `path` is `dir` itself or inside it (separator-aware). */
export function isInsideDir(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`);
}
