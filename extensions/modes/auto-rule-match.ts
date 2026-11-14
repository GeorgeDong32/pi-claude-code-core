/**
 * modes/auto-rule-match.ts — BH-R6 (spec 2026-11-14-backtest-hardening):
 * auto-mode allow / soft_deny matching per SHELL SEGMENT.
 *
 * The legacy gate matched the WHOLE command by substring/prefix, so a
 * compound like `git reset HEAD~1 && npm test` fast-allowed on the strength
 * of one allowed fragment and never reached the soft_deny tier. Semantics:
 *
 * - soft_deny wins: ANY segment matching a soft_deny rule marks the command.
 * - fast-allow is all-or-nothing: EVERY segment must match an allow rule.
 * - splitting hazards refuse the fast-allow: when the command carries
 *   command substitution (backticks, $(), ${}, process substitution) or
 *   splits into no segments, allowMatched stays false and the command falls
 *   through to the later tiers (soft_deny still reports — the conservative
 *   direction).
 *
 * Single-segment parity: splitShellSegments returns [command.trim()] for a
 * separator-free command, so the legacy whole-command verdicts are
 * reproduced exactly (pinned by the parity matrix in auto-rule-match.test.ts).
 */

import { splitShellSegments } from "./bash-analysis.ts"

/** Does one command string match one autoMode pattern (CC-ish)? */
export function matchAutoModePattern(command: string, pattern: string): boolean {
	const trimmed = command.trim()
	const p = pattern.trim()
	if (trimmed === p) return true
	if (p.endsWith("*")) {
		const prefix = p.slice(0, -1).trim()
		return trimmed.startsWith(prefix)
	}
	return trimmed.includes(p)
}

/** Command substitution / nested-shell markers — the fast-allow refuses. */
const NESTED_SHELL_PATTERNS: RegExp[] = [/`/, /\$\(/, /\$\{/, /<\(/, />\(/]

export interface AutoRuleMatch {
	/** Tier-1.5b gate: every segment matched an allow rule (and no hazards). */
	allowMatched: boolean
	/** Tier-1.5 gate: any segment matched a soft_deny rule (soft_deny wins). */
	softDenyMatched: boolean
}

export function matchAutoRules(
	command: string,
	allow: readonly string[] | undefined,
	softDeny: readonly string[] | undefined,
): AutoRuleMatch {
	if (!command || !command.trim()) {
		return { allowMatched: false, softDenyMatched: false }
	}
	const segments = splitShellSegments(command)
	if (segments.length === 0) {
		return { allowMatched: false, softDenyMatched: false }
	}
	const softDenyMatched =
		!!softDeny?.length && segments.some((seg) => softDeny.some((p) => matchAutoModePattern(seg, p)))
	// command substitution makes per-segment matching unreliable — never
	// fast-allow through the rule tier (falls through to the later tiers)
	const allowMatched =
		!!allow?.length &&
		!NESTED_SHELL_PATTERNS.some((p) => p.test(command)) &&
		segments.every((seg) => allow.some((p) => matchAutoModePattern(seg, p)))
	return { allowMatched, softDenyMatched }
}
