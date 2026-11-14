import { describe, expect, it } from "vitest"
import { pathMatchesRulePattern } from "./path-permission-match.ts"
import { evaluateToolPermission, type PermissionRule } from "./permissions.ts"
import { permissionRuleValueFromString } from "./permission-rule-parser.ts"

describe("path-permission-match", () => {
	const cwd = "/home/user/project"

	it("matches exact relative path", () => {
		expect(pathMatchesRulePattern(".env", "./.env", cwd)).toBe(true)
	})

	it("matches glob patterns", () => {
		expect(pathMatchesRulePattern(".git/config", "./.git/**", cwd)).toBe(
			true,
		)
	})

	it("matches home path pattern", () => {
		expect(pathMatchesRulePattern("~/.zshrc", "~/.zshrc", cwd)).toBe(true)
	})
})

// BH-S1 (spec 2026-11-14-backtest-hardening): single `*` is a within-segment
// glob ([^/]*), `**` keeps cross-segment semantics; every other regex
// metacharacter stays escaped. deny / ask / allow share this matcher
// (permissions.ts ruleMatchesToolCall → pathToolMatchesRuleContent), so the
// matcher-level cases below cover all three kinds' mechanics; the
// evaluateToolPermission block pins the kind wiring itself.
describe("BH-S1: single-star glob semantics", () => {
	const cwd = "/home/user/project"

	it("deny/ask/allow kinds route through the same matcher (kind wiring)", () => {
		const rules: PermissionRule[] = [
			{ source: "global", behavior: "deny", ruleValue: permissionRuleValueFromString("Read(./.env.*)") },
			{ source: "global", behavior: "ask", ruleValue: permissionRuleValueFromString("Read(./secrets.*)") },
			{ source: "global", behavior: "allow", ruleValue: permissionRuleValueFromString("Read(./logs/*.txt)") },
		]
		expect(evaluateToolPermission("read", { path: "./.env.local" }, cwd, rules)).toMatchObject({ behavior: "deny" })
		expect(evaluateToolPermission("read", { path: "./secrets.key" }, cwd, rules)).toMatchObject({ behavior: "ask" })
		expect(evaluateToolPermission("read", { path: "./logs/build.txt" }, cwd, rules)).toMatchObject({ behavior: "allow" })
		// cross-directory targets stay OUT of a single-* rule
		expect(evaluateToolPermission("read", { path: "./a/.env.local" }, cwd, rules)).toMatchObject({ behavior: "passthrough" })
	})

	it("single * matches within one segment, not across directories", () => {
		expect(pathMatchesRulePattern("./.env.local", "./.env.*", cwd)).toBe(true)
		expect(pathMatchesRulePattern("./a/.env.local", "./.env.*", cwd)).toBe(false)
		// globstar keeps cross-segment semantics
		expect(pathMatchesRulePattern("./a/.env.local", "./**/.env.*", cwd)).toBe(true)
		// home-dir form
		expect(pathMatchesRulePattern("~/.ssh/id_rsa", "~/.ssh/*", cwd)).toBe(true)
		expect(pathMatchesRulePattern("~/.ssh/sub/id_rsa", "~/.ssh/*", cwd)).toBe(false)
	})

	it("other regex metacharacters in literals stay escaped", () => {
		// `.` in the pattern must not become a wildcard
		expect(pathMatchesRulePattern("./envXlocal", "./.env.*", cwd)).toBe(false)
		// parens/brackets/plus in literal rule paths match literally
		expect(pathMatchesRulePattern("./a(1).txt", "./a(1).txt", cwd)).toBe(true)
		expect(pathMatchesRulePattern("./a1.txt", "./a(1).txt", cwd)).toBe(false)
		expect(pathMatchesRulePattern("./x+[1].md", "./x+[1].md", cwd)).toBe(true)
	})

	it("existing ** semantics unchanged (regression guard)", () => {
		expect(pathMatchesRulePattern(".git/config", "./.git/**", cwd)).toBe(true)
		expect(pathMatchesRulePattern(".git/hooks/pre-commit", "./.git/**", cwd)).toBe(true)
		expect(pathMatchesRulePattern(".gitconfig", "./.git/**", cwd)).toBe(false)
	})
})
