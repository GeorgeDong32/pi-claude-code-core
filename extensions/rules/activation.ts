/*
 * rules/activation.ts — the rule-activation budget module (AR1005-RU,
 * spec 2026-10-05 §8). ONE owner of the session activation set and the
 * per-turn character budget.
 *
 * Turn semantics (RU-01): a turn spans turn_start → the next turn_start.
 * The SUM of all pi-rules-activate content lengths within one turn may
 * not exceed the budget (DYNAMIC_STEER_MAX, 8 000 — JavaScript string
 * length, not UTF-8 bytes; titles, whitespace and pointer prose all
 * count). session_start resets BOTH the activation set and the budget
 * epoch; turn_start resets ONLY the turn's usage. Tool calls before the
 * first turn_start ride the session-initialized zero-usage epoch. Nothing
 * resets at before_agent_start, per tool_call, or per rule.
 *
 * Delivery ladder (RU-02), per first-hit rule in collected order:
 *   1. full title+body fits the remaining budget → send the full text
 *      (byte-identical to the old single-rule output).
 *   2. else the existing full "Read on demand" pointer (byte-identical
 *      oversized-single text).
 *   3. else a SHORT pointer: the complete readable path plus a minimal
 *      note — never a truncated path, never truncated body text.
 *   4. else nothing this turn: the rule is NOT marked activated and stays
 *      eligible for a later turn's matching tool call (no background
 *      queue — the next matching activation retries it).
 *
 * A rule is marked session-activated ONLY when its send succeeded
 * (pointer sends count, matching the historical oversized-single
 * semantics). Check/reserve/send/commit-or-rollback happen in ONE
 * synchronous pass (no await between them): budget reservation happens
 * BEFORE the send call so a synchronously re-entrant adapter observes
 * consistent remaining budget; a throwing send rolls the reservation
 * back and leaves the rule unactivated without affecting the others.
 *
 * The send adapter is synchronous (throws = failure). The wiring wraps
 * pi.sendMessage; async delivery rejections are not activation failures.
 */
import { DYNAMIC_STEER_MAX } from "../../lib/context-budget.ts";

export interface ActivatableRule {
	name: string;
	path: string;
	content: string;
}

export interface ActivationResult {
	/** Rules whose full text or pointer went out this call. */
	sent: number;
	/** Rules left for a later turn (no budget room even for the short pointer). */
	deferred: number;
	/** Sends that threw (rule stays unactivated, retried later). */
	failed: number;
}

export interface RuleActivation {
	onSessionStart(): void;
	onTurnStart(): void;
	/** Attempt activation for the given first-hit rules, in order. */
	activate(rules: readonly ActivatableRule[]): ActivationResult;
	/** Session-activated count (the /rules diagnostics line). */
	sessionActivatedCount(): number;
	/** Remaining budget in the current turn (diagnostics/tests). */
	remainingTurnBudget(): number;
}

export function createRuleActivation(deps: {
	send: (content: string) => void;
	/** Test seam; defaults to DYNAMIC_STEER_MAX. */
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
				if (sessionActivated.has(rule.name)) continue; // once per session (P3-RU-07)
				const remaining = budget - turnUsed;
				const candidates = [fullText(rule), pointerText(rule), shortPointerText(rule)];
				let sent = false;
				let failed = false;
				for (const content of candidates) {
					if (content.length > remaining) continue;
					// Reserve BEFORE the send (a synchronously re-entrant adapter
					// must observe the deducted budget), roll back on throw.
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
					break; // first fitting candidate decides this rule's fate
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
