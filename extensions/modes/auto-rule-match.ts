
import { splitShellSegments } from "./bash-analysis.ts"

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
