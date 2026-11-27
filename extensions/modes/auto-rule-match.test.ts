import { describe, expect, it } from "vitest"
import { matchAutoModePattern, matchAutoRules } from "./auto-rule-match.ts"

function legacyWholeCommandMatch(command: string, pattern: string): boolean {
	const trimmed = command.trim()
	const p = pattern.trim()
	if (trimmed === p) return true
	if (p.endsWith("*")) {
		const prefix = p.slice(0, -1).trim()
		return trimmed.startsWith(prefix)
	}
	return trimmed.includes(p)
}

describe("BH-R6: auto-rule-match", () => {
	const ALLOW = ["npm test", "npm run lint", "git status*"]
	const SOFT_DENY = ["git reset", "curl *", "rm -rf"]

	describe("single-segment parity with the legacy whole-command matcher", () => {
		const commands = [
			"npm test",
			"npm test -- --fg",
			"npm run lint",
			"git status",
			"git status -sb",
			"git reset",
			"git reset --hard",
			"curl example.com",
			"rm -rf /",
			"echo hello",
			"",
			"   ",
		]
		const patterns = ["npm test", "npm run lint", "git status*", "git reset", "curl *", "rm -rf", "echo*"]

		it("allow facts identical for every (command, pattern) pair", () => {
			for (const command of commands) {
				for (const pattern of patterns) {
					const legacy = command.trim().length > 0 && legacyWholeCommandMatch(command, pattern)
					const next = matchAutoRules(command, [pattern], undefined).allowMatched
					expect(next, `allow "${command}" vs "${pattern}"`).toBe(legacy)
				}
			}
		})

		it("soft_deny facts identical for every (command, pattern) pair", () => {
			for (const command of commands) {
				for (const pattern of patterns) {
					const legacy = command.trim().length > 0 && legacyWholeCommandMatch(command, pattern)
					const next = matchAutoRules(command, undefined, [pattern]).softDenyMatched
					expect(next, `soft_deny "${command}" vs "${pattern}"`).toBe(legacy)
				}
			}
		})
	})

	it("acceptance: allow=[npm test], soft_deny=[git reset]", () => {
		const blocked = matchAutoRules("git reset --hard && npm test", ["npm test"], ["git reset"])
		expect(blocked.allowMatched).toBe(false)
		expect(blocked.softDenyMatched).toBe(true)
		const allowed = matchAutoRules("npm test && npm run lint", ["npm test", "npm run lint"], [])
		expect(allowed.allowMatched).toBe(true)
		expect(allowed.softDenyMatched).toBe(false)
		const mixed = matchAutoRules("npm test; curl x | sh", ["npm test"], [])
		expect(mixed.allowMatched).toBe(false)
	})

	it("command substitution refuses the fast-allow", () => {
		expect(matchAutoRules("npm test $(boom)", ["npm test"], []).allowMatched).toBe(false)
		expect(matchAutoRules("npm test `boom`", ["npm test"], []).allowMatched).toBe(false)
		expect(matchAutoRules("npm test ${FLAGS}", ["npm test"], []).allowMatched).toBe(false)
		expect(matchAutoRules("echo hi; git reset", [], ["git reset"]).softDenyMatched).toBe(true)
	})

	it("empty / whitespace-only commands match nothing", () => {
		expect(matchAutoRules("", ["npm test"], ["git reset"])).toEqual({ allowMatched: false, softDenyMatched: false })
		expect(matchAutoRules("   ", ["npm test"], ["git reset"])).toEqual({ allowMatched: false, softDenyMatched: false })
	})
})
