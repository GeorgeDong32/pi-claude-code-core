/**
 * rule-families.ts — the modes permission engine's family extension point
 * (P4-FAM-01, DESIGN-MCP-GOV ①「规则大脑」的地基).
 *
 * A RuleFamily claims unknown tools (mapPiToolToCcTool misses — everything
 * `mcp_*`-shaped today) and maps them to a canonicalId that the EXISTING
 * pm rule files can express. Verdicts fold back into evaluateToolPermission
 * before its passthrough, so step-2 consumption (deny→block / allow→pass /
 * ask→first-seen prompt) is shared machinery, not new code.
 *
 * sessionGrants (P4-FAM-05) is THE session-scoped authorization store: an
 * in-memory Set of canonicalIds granted "for this session" via the
 * first-seen dialog. Cleared on session_start/shutdown; headless and
 * forwarded approvals land here too (via noteAdjudicated).
 */

import type { PermissionBehavior, PermissionRule } from "./permissions.ts";

export type FamilyVerdict = "deny" | "allow" | "ask";

export interface RuleFamily {
	/** Stable family id ("mcp", "web", …). */
	id: string;
	/** CanonicalId for this tool call, or null when the family does not claim it. */
	match(toolName: string, input: Record<string, unknown>): string | null;
	/** Rule-file verdict for the canonicalId (deny > allow > ask order kept here). */
	resolve(canonicalId: string, rules: PermissionRule[]): FamilyVerdict;
	/** Suggested persistent rule ("Allow always"), e.g. `mcp_exa_*`. */
	suggestAllowRule(canonicalId: string): string;
}

const families: RuleFamily[] = [];

/** Register a family (called by mcp-gov / web-gov at assembly). Later wins on duplicate id. */
export function registerRuleFamily(family: RuleFamily): void {
	const idx = families.findIndex((f) => f.id === family.id);
	if (idx >= 0) families[idx] = family;
	else families.push(family);
}

/** Test isolation: drop every family. */
export function clearRuleFamilies(): void {
	families.length = 0;
}

export interface FamilyMatch {
	family: RuleFamily;
	canonicalId: string;
}

/** First family that claims the tool call (registration order). */
export function matchFamily(toolName: string, input: Record<string, unknown>): FamilyMatch | null {
	for (const family of families) {
		const canonicalId = family.match(toolName, input);
		if (canonicalId !== null) return { family, canonicalId };
	}
	return null;
}

/**
 * Family verdict for a tool call: null when no family claims it. The deny >
 * allow > ask order follows the pm engine's existing behavior sweep.
 */
export function familyVerdictFor(
	toolName: string,
	input: Record<string, unknown>,
	rules: PermissionRule[],
): { match: FamilyMatch; verdict: FamilyVerdict } | null {
	const match = matchFamily(toolName, input);
	if (!match) return null;
	return { match, verdict: match.family.resolve(match.canonicalId, rules) };
}

/** Does any rule string reference this canonicalId (exact or trailing-*)? */
export function ruleMentions(rules: PermissionRule[], canonicalId: string, behavior: PermissionBehavior): PermissionRule | undefined {
	return rules.find((r) => {
		if (r.behavior !== behavior) return false;
		const text = permissionRuleText(r);
		return text === canonicalId || (text.endsWith("*") && canonicalId.startsWith(text.slice(0, -1)));
	});
}

function permissionRuleText(rule: PermissionRule): string {
	return typeof rule.ruleValue === "string"
		? rule.ruleValue
		: String((rule.ruleValue as { value?: unknown })?.value ?? "");
}

// ---- bypass indicator (P4-MC-03 mirror's 2nd allow branch) ----------------

let bypassActive = false;

/** modes setMode updates this so the broker mirror can honor bypass. */
export function setBypassIndicator(active: boolean): void {
	bypassActive = active;
}

export function isBypassActive(): boolean {
	return bypassActive;
}

// ---- session grants (P4-FAM-05) -------------------------------------------

const sessionGrants = new Set<string>();

export function grantSession(canonicalId: string): void {
	sessionGrants.add(canonicalId);
}

export function hasSessionGrant(canonicalId: string): boolean {
	return sessionGrants.has(canonicalId);
}

/** session_start / session_shutdown lifecycle hook. */
export function clearSessionGrants(): void {
	sessionGrants.clear();
}

/** spec P4-FAM-05: grants reset on session_start AND session_shutdown. */
export function clearSessionState(): void {
	sessionGrants.clear();
	adjudicated.clear();
}

export function listSessionGrants(): string[] {
	return [...sessionGrants];
}

// ---- adjudication record (P4-MC-03 onAdjudicated) --------------------------

export type AdjudicationOutcome = "rule-allow" | "allow-once" | "session-grant" | "classifier-allow" | "forwarded-allow" | "deny";

export interface Adjudication {
	canonicalId: string;
	outcome: AdjudicationOutcome;
	at: number;
}

/** canonicalId → last adjudication (the broker mirror's cache view). */
const adjudicated = new Map<string, Adjudication>();

/**
 * THE single record point for gate final outcomes on family tools
 * (P4-MC-03: no per-branch scattered recording). Callers:
 * modes' allow path, the first-seen dialog, forwarded approvals.
 */
export function noteAdjudicated(canonicalId: string, outcome: AdjudicationOutcome): void {
	adjudicated.set(canonicalId, { canonicalId, outcome, at: Date.now() });
}

export function getAdjudication(canonicalId: string): Adjudication | undefined {
	return adjudicated.get(canonicalId);
}

export function clearAdjudications(): void {
	adjudicated.clear();
}
