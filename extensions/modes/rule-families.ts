
import type { PermissionBehavior, PermissionRule } from "./permissions.ts";

export type FamilyVerdict = "deny" | "allow" | "ask";

export interface RuleFamily {
	id: string;
	match(toolName: string, input: Record<string, unknown>): string | null;
	resolve(canonicalId: string, rules: PermissionRule[]): FamilyVerdict;
	suggestAllowRule(canonicalId: string): string;
	matchesRule(rule: PermissionRule, canonicalId: string): boolean;
}

const families: RuleFamily[] = [];

export function registerRuleFamily(family: RuleFamily): void {
	const idx = families.findIndex((f) => f.id === family.id);
	if (idx >= 0) families[idx] = family;
	else families.push(family);
}

export function clearRuleFamilies(): void {
	families.length = 0;
}

export interface FamilyMatch {
	family: RuleFamily;
	canonicalId: string;
}

export function matchFamily(toolName: string, input: Record<string, unknown>): FamilyMatch | null {
	for (const family of families) {
		const canonicalId = family.match(toolName, input);
		if (canonicalId !== null) return { family, canonicalId };
	}
	return null;
}

export function familyVerdictFor(
	toolName: string,
	input: Record<string, unknown>,
	rules: PermissionRule[],
): { match: FamilyMatch; verdict: FamilyVerdict } | null {
	const match = matchFamily(toolName, input);
	if (!match) return null;
	return { match, verdict: match.family.resolve(match.canonicalId, rules) };
}

export function familyRuleMentions(
	rules: PermissionRule[],
	family: RuleFamily,
	canonicalId: string,
	behavior: PermissionBehavior,
): PermissionRule | undefined {
	return rules.find((r) => r.behavior === behavior && family.matchesRule(r, canonicalId));
}


let bypassActive = false;

export function setBypassIndicator(active: boolean): void {
	bypassActive = active;
}

export function isBypassActive(): boolean {
	return bypassActive;
}


const sessionGrants = new Set<string>();

export function grantSession(canonicalId: string): void {
	sessionGrants.add(canonicalId);
}

export function hasSessionGrant(canonicalId: string): boolean {
	return sessionGrants.has(canonicalId);
}

export function clearSessionGrants(): void {
	sessionGrants.clear();
}

export function clearSessionState(): void {
	sessionGrants.clear();
	adjudicated.clear();
}

export function listSessionGrants(): string[] {
	return [...sessionGrants];
}


export type AdjudicationOutcome = "rule-allow" | "allow-once" | "session-grant" | "classifier-allow" | "forwarded-allow" | "deny";

export interface Adjudication {
	canonicalId: string;
	outcome: AdjudicationOutcome;
	at: number;
}

const adjudicated = new Map<string, Adjudication>();

export function noteAdjudicated(canonicalId: string, outcome: AdjudicationOutcome): void {
	adjudicated.set(canonicalId, { canonicalId, outcome, at: Date.now() });
}

export function getAdjudication(canonicalId: string): Adjudication | undefined {
	return adjudicated.get(canonicalId);
}

export function clearAdjudications(): void {
	adjudicated.clear();
}
