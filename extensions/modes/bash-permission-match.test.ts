import { describe, expect, it } from "vitest"
import {
	bashCommandMatchesRuleContent,
	suggestBashAllowRule,
} from "./bash-permission-match.ts"

describe("bash-permission-match", () => {
	it("allow matches single-segment prefix rule", () => {
		expect(
			bashCommandMatchesRuleContent("npm run test", "npm run:*", "allow"),
		).toBe(true)
	})

	it("allow does not match compound commands", () => {
		expect(
			bashCommandMatchesRuleContent(
				"git status && rm -rf /",
				"git:*",
				"allow",
			),
		).toBe(false)
	})

	it("deny matches any compound segment", () => {
		expect(
			bashCommandMatchesRuleContent(
				"git status && rm -rf /",
				"rm:*",
				"deny",
			),
		).toBe(true)
	})

	it("suggests prefix rule for bash", () => {
		expect(suggestBashAllowRule("npm run test")).toBe("Bash(npm:*)")
	})
})

describe("P0-1 (2026-11-08): allow-rule hardening (safety-gated)", () => {
	const gitStatus = "git status:*";
	const hard = { allowHardening: true };
	it("substitution / process substitution never matches an allow rule", () => {
		expect(bashCommandMatchesRuleContent("git status $(rm x)", gitStatus, "allow", hard)).toBe(false);
		expect(bashCommandMatchesRuleContent("git status `rm x`", gitStatus, "allow", hard)).toBe(false);
		expect(bashCommandMatchesRuleContent("git status ${X}", gitStatus, "allow", hard)).toBe(false);
		expect(bashCommandMatchesRuleContent("cat <(rm x)", "cat:*", "allow", hard)).toBe(false);
		// plain command still matches
		expect(bashCommandMatchesRuleContent("git status", gitStatus, "allow", hard)).toBe(true);
	});
	it("safe heredoc exemption: $(cat <<'EOF' stays allowable", () => {
		const cmd = `git commit -m "$(cat <<'EOF'\nfix: thing\nEOF\n)"`;
		expect(bashCommandMatchesRuleContent(cmd, "git commit:*", "allow", hard)).toBe(true);
		// heredoc with trailing smuggled command after ) is NOT exempt
		const smuggle = `git commit -m "$(cat <<'EOF'\nfix\nEOF\n)"; rm -rf /`;
		expect(bashCommandMatchesRuleContent(smuggle, "git commit:*", "allow", hard)).toBe(false);
		// unquoted delimiter heredoc is not exempt (body could expand)
		const unquoted = `git commit -m "$(cat <<EOF\nfix\nEOF\n)"`;
		expect(bashCommandMatchesRuleContent(unquoted, "git commit:*", "allow", hard)).toBe(false);
	});
	it("sensitive-path redirection defeats an allow rule", () => {
		expect(bashCommandMatchesRuleContent("git status > ~/.zshrc", gitStatus, "allow", hard)).toBe(false);
		expect(bashCommandMatchesRuleContent('git status > ".bashrc"', gitStatus, "allow", hard)).toBe(false);
		expect(bashCommandMatchesRuleContent("git status > out.txt", gitStatus, "allow", hard)).toBe(true);
		expect(bashCommandMatchesRuleContent("git status > /dev/null", gitStatus, "allow", hard)).toBe(true);
	});
	it("hardening off (opts false) restores pre-change matching", () => {
		expect(bashCommandMatchesRuleContent("git status $(rm x)", gitStatus, "allow", { allowHardening: false })).toBe(true);
		expect(bashCommandMatchesRuleContent("git status > ~/.zshrc", gitStatus, "allow", { allowHardening: false })).toBe(true);
	});
	it("deny/ask rules are NOT hardened (they keep matching normally)", () => {
		expect(bashCommandMatchesRuleContent("git status $(rm x)", gitStatus, "deny", hard)).toBe(true);
	});
});

describe("P2 (2026-11-08): wrapper + subcommand expansion for deny/ask", () => {
	const rm = "rm:*";
	it("bare nice / nice -N / stdbuf -o0 / time strip like CC", () => {
		expect(bashCommandMatchesRuleContent("nice rm x", rm, "deny")).toBe(true);
		expect(bashCommandMatchesRuleContent("nice -5 rm x", rm, "deny")).toBe(true);
		expect(bashCommandMatchesRuleContent("nice -n 5 rm x", rm, "deny")).toBe(true);
		expect(bashCommandMatchesRuleContent("stdbuf -o0 rm x", rm, "deny")).toBe(true);
		expect(bashCommandMatchesRuleContent("time rm x", rm, "deny")).toBe(true);
		expect(bashCommandMatchesRuleContent("timeout 5 rm x", rm, "deny")).toBe(true);
	});
	it("$() and backtick subcommands expand into deny candidates", () => {
		// outer command does not match rm:*, but the subcommand does
		expect(bashCommandMatchesRuleContent("printf %s $(rm x)", rm, "deny")).toBe(true);
		expect(bashCommandMatchesRuleContent("echo `rm x`", rm, "deny")).toBe(true);
		// no subcommand and no outer match — clean
		expect(bashCommandMatchesRuleContent("printf %s ok", rm, "deny")).toBe(false);
		// allow direction: no expansion (P0-1 rejects substitution instead)
		expect(bashCommandMatchesRuleContent("echo $(rm x)", "echo:*", "allow", { allowHardening: false })).toBe(true);
	});
});
