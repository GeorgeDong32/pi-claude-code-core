import { DYNAMIC_STEER_MAX } from "../../lib/context-budget.ts";

export interface ActivatableRule {
	name: string;
	path: string;
	content: string;
}

export interface ActivationResult {
	sent: number;
	deferred: number;
	failed: number;
}

export interface RuleActivation {
	onSessionStart(): void;
	onTurnStart(): void;
	activate(rules: readonly ActivatableRule[]): ActivationResult;
	sessionActivatedCount(): number;
	remainingTurnBudget(): number;
}

export function createRuleActivation(deps: {
	send: (content: string) => void;
	budgetChars?: number;
}): RuleActivation {
	const budget = deps.budgetChars ?? DYNAMIC_STEER_MAX;
	const sessionActivated = new Set<string>();
	let turnUsed = 0;

	const fullText = (rule: ActivatableRule): string => `### ${rule.name}\n\n${rule.content}`;
	const pointerText = (rule: ActivatableRule): string =>
		`${rule.name}: rule text exceeds the per-turn steer budget (${budget} chars). Read ${rule.path} on demand.`;
	const shortPointerText = (rule: ActivatableRule): string => `${rule.name}: turn steer budget is full. Read ${rule.path} on demand.`;

	return {
		onSessionStart() {
			sessionActivated.clear();
			turnUsed = 0;
		},
		onTurnStart() {
			turnUsed = 0;
		},
		activate(rules) {
			const result: ActivationResult = { sent: 0, deferred: 0, failed: 0 };
			for (const rule of rules) {
				if (sessionActivated.has(rule.name)) continue;
				const remaining = budget - turnUsed;
				const candidates = [fullText(rule), pointerText(rule), shortPointerText(rule)];
				let sent = false;
				let failed = false;
				for (const content of candidates) {
					if (content.length > remaining) continue;
					turnUsed += content.length;
					sessionActivated.add(rule.name);
					try {
						deps.send(content);
						sent = true;
						result.sent++;
					} catch {
						turnUsed -= content.length;
						sessionActivated.delete(rule.name);
						failed = true;
						result.failed++;
					}
					break;
				}
				if (!sent && !failed) result.deferred++;
			}
			return result;
		},
		sessionActivatedCount() {
			return sessionActivated.size;
		},
		remainingTurnBudget() {
			return budget - turnUsed;
		},
	};
}
