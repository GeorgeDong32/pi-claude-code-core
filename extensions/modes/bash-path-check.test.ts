/**
 * bash-path-check.test.ts — W2/W3/W4/W5 (2026-11-07 handoff): the CC-parity
 * safety-path set, the bash write-target check (W3), the Read/Edit deny
 * extension over bash path commands (W4), and the PI_CORE_BASH_PATH_CHECKS /
 * bashPathChecks switch (W5). Case set follows handoff §7.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	checkBashDenyHit,
	checkBashProtectedWrite,
	checkBashWriteTargets,
	resolveBashPathChecks,
} from "./bash-path-check.ts";
import { isCcSafetyPath } from "./path-safety.ts";
import type { PermissionRule } from "./permissions.ts";
import { permissionRuleValueFromString } from "./permission-rule-parser.ts";

const CWD = "/w";

function denyRule(text: string, source: PermissionRule["source"] = "global"): PermissionRule {
	return { source, behavior: "deny", ruleValue: permissionRuleValueFromString(text) };
}

describe("isCcSafetyPath (W2: CC set ∪ pi extras)", () => {
	it("matches CC dangerous directories in any segment (case-insensitive)", () => {
		expect(isCcSafetyPath("src/.git/config", CWD)).toBe(true);
		expect(isCcSafetyPath("/x/.VSCode/settings.json", CWD)).toBe(true);
		expect(isCcSafetyPath("~/.ssh/config", CWD)).toBe(true);
		expect(isCcSafetyPath("/etc/.gnupg/k", CWD)).toBe(true);
		expect(isCcSafetyPath(".idea/x.xml", CWD)).toBe(true);
		expect(isCcSafetyPath(".claude/settings.json", CWD)).toBe(true);
	});
	it(".claude/worktrees is the structural exception", () => {
		expect(isCcSafetyPath(".claude/worktrees/wt1/a.ts", CWD)).toBe(false);
		// nested .claude inside a worktree still matches
		expect(isCcSafetyPath(".claude/worktrees/wt1/.claude/x", CWD)).toBe(true);
	});
	it("matches CC dangerous files by filename (exact, case-insensitive)", () => {
		expect(isCcSafetyPath("~/.bashrc", CWD)).toBe(true);
		expect(isCcSafetyPath("home/.zprofile", CWD)).toBe(true);
		expect(isCcSafetyPath("/x/.MCP.json", CWD)).toBe(true);
		expect(isCcSafetyPath("~/.gitconfig", CWD)).toBe(true);
		expect(isCcSafetyPath(".ripgreprc", CWD)).toBe(true);
	});
	it("matches pi extras: .env* prefix + key/credentials exact", () => {
		expect(isCcSafetyPath(".env", CWD)).toBe(true);
		expect(isCcSafetyPath("config/.env.production", CWD)).toBe(true);
		expect(isCcSafetyPath("~/.ssh/id_rsa", CWD)).toBe(true);
		expect(isCcSafetyPath("creds/id_ed25519", CWD)).toBe(true);
		expect(isCcSafetyPath("creds/credentials", CWD)).toBe(true);
	});
	it("non-sensitive paths pass; substring look-alikes stay clean", () => {
		expect(isCcSafetyPath("src/foo.ts", CWD)).toBe(false);
		expect(isCcSafetyPath("docs/env-setup.md", CWD)).toBe(false);
		expect(isCcSafetyPath("", CWD)).toBe(false);
		expect(isCcSafetyPath("bashrc-notes.txt", CWD)).toBe(false);
		expect(isCcSafetyPath(".environment.ts", CWD)).toBe(false);
	});
});

describe("checkBashWriteTargets (W3, bypass gate)", () => {
	it("redirection / write-command onto a sensitive path prompts", () => {
		expect(checkBashWriteTargets("echo x > ~/.zshrc", CWD)).toMatchObject({ path: "~/.zshrc" });
		expect(checkBashWriteTargets("echo alias x=1 >> ~/.bashrc", CWD)).toMatchObject({ path: "~/.bashrc" });
		expect(checkBashWriteTargets("rm .git/index", CWD)).toMatchObject({ path: ".git/index" });
		expect(checkBashWriteTargets("tee .env", CWD)).toMatchObject({ path: ".env" });
		expect(checkBashWriteTargets("touch .env", CWD)).toMatchObject({ path: ".env" });
		expect(checkBashWriteTargets("mkdir .ssh", CWD)).toMatchObject({ path: ".ssh" });
	});
	it("sed -i inline edit targets the file argument", () => {
		expect(checkBashWriteTargets("sed -i '' s/a/b/ ~/.zshrc", CWD)).toMatchObject({ path: "~/.zshrc" });
		expect(checkBashWriteTargets("sed -i s/a/b/ .bashrc", CWD)).toMatchObject({ path: ".bashrc" });
		// plain sed is read-only — not a write target
		expect(checkBashWriteTargets("sed -n 1p ~/.zshrc", CWD)).toBeNull();
	});
	it("compound: read-only companions keep the hit; non-read-only cancel it (CC approximation)", () => {
		expect(checkBashWriteTargets("rm .git/x && echo ok", CWD)).toMatchObject({ path: ".git/x" });
		expect(checkBashWriteTargets("rm .git/x && npm install", CWD)).toBeNull();
	});
	it("ssh / sudo / bash -c argument strings are opaque — allow (fail-open)", () => {
		expect(checkBashWriteTargets("ssh host 'rm -rf ~/.claude'", CWD)).toBeNull();
		expect(checkBashWriteTargets("ssh -F ~/.ssh/config host ls", CWD)).toBeNull();
		expect(checkBashWriteTargets('ssh host "sudo -n true"', CWD)).toBeNull();
		expect(checkBashWriteTargets('bash -c "rm .git/x"', CWD)).toBeNull();
	});
	it("variables / globs / reads are fail-open — allow", () => {
		expect(checkBashWriteTargets('rm "$X"/.git/x', CWD)).toBeNull();
		expect(checkBashWriteTargets("rm .git/*", CWD)).toBeNull();
		expect(checkBashWriteTargets("cat .git/config", CWD)).toBeNull();
		expect(checkBashWriteTargets("echo build > dist/out.js", CWD)).toBeNull();
		expect(checkBashWriteTargets("echo hi > /dev/null", CWD)).toBeNull();
		expect(checkBashWriteTargets("cmd 2>&1", CWD)).toBeNull();
	});
});

describe("checkBashDenyHit (W4, all modes)", () => {
	const envDeny = [denyRule("Read(./.env)"), denyRule("Read(./.env.*)"), denyRule("Read(./.git/**)")];
	const editDeny = [denyRule("Edit(./x)")];

	it("read-class commands hit Read deny rules", () => {
		expect(checkBashDenyHit("cat .env", CWD, envDeny)).toMatchObject({ path: ".env" });
		expect(checkBashDenyHit("head -n1 .env", CWD, envDeny)).toMatchObject({ path: ".env" });
		expect(checkBashDenyHit("cat .git/config", CWD, envDeny)).toMatchObject({ path: ".git/config" });
		expect(checkBashDenyHit("ls .git/HEAD", CWD, envDeny)).toMatchObject({ path: ".git/HEAD" });
	});
	it("compound commands: any hit denies the whole command", () => {
		expect(checkBashDenyHit("cd x && cat a && cat .env", CWD, envDeny)).toMatchObject({ path: ".env" });
		expect(checkBashDenyHit("cat a | grep x .env", CWD, envDeny)).toMatchObject({ path: ".env" });
	});
	it("patterns are not paths: grep first arg, find -name values stay out of scope", () => {
		expect(checkBashDenyHit("grep .env file", CWD, envDeny)).toBeNull();
		expect(checkBashDenyHit("find . -name .env", CWD, envDeny)).toBeNull();
	});
	it("ssh passthrough and quoted/variable paths do not trigger", () => {
		expect(checkBashDenyHit("ssh host cat .env", CWD, envDeny)).toBeNull();
		expect(checkBashDenyHit('cat "$F"', CWD, envDeny)).toBeNull();
	});
	it("write-class and redirections hit Edit deny rules", () => {
		expect(checkBashDenyHit("rm x", CWD, editDeny)).toMatchObject({ path: "x" });
		expect(checkBashDenyHit("echo y > x", CWD, editDeny)).toMatchObject({ path: "x" });
		expect(checkBashDenyHit("touch x", CWD, editDeny)).toMatchObject({ path: "x" });
	});
	it("no deny rules → null", () => {
		expect(checkBashDenyHit("cat .env", CWD, [])).toBeNull();
	});
});

describe("resolveBashPathChecks (W5 switch)", () => {
	const orig = process.env.PI_CORE_BASH_PATH_CHECKS;
	afterEach(() => {
		if (orig === undefined) delete process.env.PI_CORE_BASH_PATH_CHECKS;
		else process.env.PI_CORE_BASH_PATH_CHECKS = orig;
	});
	it("default all; config key respected", () => {
		delete process.env.PI_CORE_BASH_PATH_CHECKS;
		expect(resolveBashPathChecks({})).toBe("all");
		expect(resolveBashPathChecks({ bashPathChecks: "off" })).toBe("off");
		expect(resolveBashPathChecks({ bashPathChecks: "safety" })).toBe("safety");
		expect(resolveBashPathChecks({ bashPathChecks: "deny" })).toBe("deny");
	});
	it("env overrides config; invalid values fall back (never silently disable)", () => {
		process.env.PI_CORE_BASH_PATH_CHECKS = "off";
		expect(resolveBashPathChecks({ bashPathChecks: "all" })).toBe("off");
		process.env.PI_CORE_BASH_PATH_CHECKS = "all";
		expect(resolveBashPathChecks({ bashPathChecks: "off" })).toBe("all");
		process.env.PI_CORE_BASH_PATH_CHECKS = "bogus";
		expect(resolveBashPathChecks({ bashPathChecks: "deny" })).toBe("deny");
		expect(resolveBashPathChecks({})).toBe("all");
	});
});

describe("P0-2/3 (2026-11-08): quoted literal paths participate", () => {
	it("W4: quoted .env literals hit Read deny", () => {
		const envDeny = [denyRule("Read(./.env)")];
		expect(checkBashDenyHit('cat ".env"', CWD, envDeny)).toMatchObject({ path: ".env" });
		expect(checkBashDenyHit("cat '.env'", CWD, envDeny)).toMatchObject({ path: ".env" });
		expect(checkBashDenyHit('echo y > ".env"', CWD, [denyRule("Edit(./.env)")])).toMatchObject({ path: ".env" });
	});
	it("W3: quoted sensitive write targets prompt", () => {
		expect(checkBashWriteTargets('rm ".git/index"', CWD)).toMatchObject({ path: ".git/index" });
		expect(checkBashWriteTargets("rm '.git/index'", CWD)).toMatchObject({ path: ".git/index" });
		expect(checkBashWriteTargets('echo x > ".zshrc"', CWD)).toMatchObject({ path: ".zshrc" });
	});
	it("opaque boundaries unchanged: ssh remote strings, $-containing quotes", () => {
		const envDeny = [denyRule("Read(./.env)")];
		expect(checkBashDenyHit("ssh host 'cat .env'", CWD, envDeny)).toBeNull();
		expect(checkBashDenyHit('cat "$F"', CWD, envDeny)).toBeNull();
		// quote with expansion inside stays opaque for W3 too
		expect(checkBashWriteTargets('rm "$X"/.git/x', CWD)).toBeNull();
	});
});

describe("P1-2 (2026-11-08): mv/cp check ALL positional args", () => {
	it("moving/copying a sensitive SOURCE prompts (not just destination)", () => {
		expect(checkBashWriteTargets("mv .git/index /tmp/x", CWD)).toMatchObject({ path: ".git/index" });
		expect(checkBashWriteTargets("cp .git/config /tmp/x", CWD)).toMatchObject({ path: ".git/config" });
		expect(checkBashWriteTargets("cp a.ts b.ts", CWD)).toBeNull();
	});
	it("install stays destination-only (not in CC set)", () => {
		expect(checkBashWriteTargets("install -m 644 x .git/hooks/h", CWD)).toMatchObject({ path: ".git/hooks/h" });
		// source arg sensitive — not a hit under destination-only semantics
		expect(checkBashWriteTargets("install -m 644 .git/config /tmp/x", CWD)).toBeNull();
	});
});

describe("P1-3 (2026-11-08): full sed extractor", () => {
	it("in-place flag family: -iSUFFIX, --in-place, --in-place=SUFFIX, combined", () => {
		expect(checkBashWriteTargets("sed -i.bak s/a/b/ ~/.zshrc", CWD)).toMatchObject({ path: "~/.zshrc" });
		expect(checkBashWriteTargets("sed --in-place s/a/b/ ~/.zshrc", CWD)).toMatchObject({ path: "~/.zshrc" });
		expect(checkBashWriteTargets("sed --in-place=.bak s/a/b/ ~/.zshrc", CWD)).toMatchObject({ path: "~/.zshrc" });
		expect(checkBashWriteTargets("sed -ni s/a/b/ ~/.zshrc", CWD)).toMatchObject({ path: "~/.zshrc" });
	});
	it("every file after the script is checked (multi-file)", () => {
		expect(checkBashWriteTargets("sed -i s/a/b/ ok.txt ~/.zshrc", CWD)).toMatchObject({ path: "~/.zshrc" });
		expect(checkBashWriteTargets("sed -i s/a/b/ ~/.zshrc ok.txt", CWD)).toMatchObject({ path: "~/.zshrc" });
	});
	it("plain sed (no -i) is read-only — no W3 hit; -e/-f operands routed per CC", () => {
		expect(checkBashWriteTargets("sed -n 1p ~/.zshrc", CWD)).toBeNull();
		// -e expression operand is not a file
		expect(checkBashWriteTargets("sed -i -e s/a/b/ ~/.zshrc", CWD)).toMatchObject({ path: "~/.zshrc" });
		// W4: -f script FILE is validated against deny rules
		const envDeny = [denyRule("Edit(./.env)")];
		expect(checkBashDenyHit("sed -i -f .env.sed .env", CWD, envDeny)).toMatchObject({ path: ".env" });
		expect(checkBashDenyHit("sed -i -f .env.sed ok.txt", CWD, envDeny)).toBeNull();
	});
});

describe("P1-4 (2026-11-08): pi-own protected paths", () => {
	it("write onto permission-modes.json / rules dir / settings.json matches", () => {
		const home = process.env.HOME ?? "/Users/x";
		expect(checkBashProtectedWrite("echo x > ~/.pi/agent/permission-modes.json", CWD)).toMatchObject({ kind: "modes-permissions-file" });
		expect(checkBashProtectedWrite("rm ~/.pi/agent/settings.json", CWD)).toMatchObject({ kind: "host-settings-file" });
		expect(checkBashProtectedWrite("tee ~/.pi/agent/rules/r.md", CWD)).toMatchObject({ kind: "global-rules-dir" });
		// relative project rules dir
		expect(checkBashProtectedWrite("rm .pi/rules/r.md", CWD)).toMatchObject({ kind: "project-rules-dir" });
		// read-only reference does not trigger
		expect(checkBashProtectedWrite("cat ~/.pi/agent/permission-modes.json", CWD)).toBeNull();
	});
	it("plain paths stay clean", () => {
		expect(checkBashProtectedWrite("echo x > src/out.ts", CWD)).toBeNull();
		expect(checkBashProtectedWrite("rm src/old.ts", CWD)).toBeNull();
	});
});
