import { afterEach, describe, expect, it } from "vitest";
import {
	checkBashDenyHit,
	checkBashDenyScan,
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
		expect(checkBashDenyHit("cat a && cat b && cat .env", CWD, envDeny)).toMatchObject({ path: ".env" });
		expect(checkBashDenyHit("cd x && cat a && cat ../.env", CWD, envDeny)).toMatchObject({ path: "../.env" });
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
	it("BH-S1: single-* deny rules match through the bash W4 reuse", () => {
		const star = [denyRule("Read(./.env.*)")];
		expect(checkBashDenyHit("cat ./.env.local", CWD, star)).toMatchObject({ path: "./.env.local" });
		expect(checkBashDenyHit("cat ./a/.env.local", CWD, star)).toBeNull();
		const globstar = [denyRule("Read(./**/.env.*)")];
		expect(checkBashDenyHit("cat ./a/.env.local", CWD, globstar)).toMatchObject({ path: "./a/.env.local" });
	});
});

describe("BH-R3: mv/cp flag analysis + remote heredoc bodies", () => {
	const unrelated = [denyRule("Edit(./other)")];
	const sshRule = [denyRule("Edit(~/.ssh/**)")];

	it("recognized harmless flags are stripped — bare form decides", () => {
		expect(checkBashDenyHit("cp -R src dst", CWD, unrelated)).toBeNull();
		expect(checkBashDenyHit("mv -R -p -f src dst", CWD, unrelated)).toBeNull();
		expect(checkBashDenyHit("cp -Rv --preserve src dst", CWD, unrelated)).toBeNull();
	});
	it("a rule-matching destination still denies through the bare form", () => {
		expect(checkBashDenyHit("mv -f a ~/.ssh/x", CWD, sshRule)).toMatchObject({ path: "~/.ssh/x", rule: "Edit(~/.ssh/**)" });
		expect(checkBashDenyHit("cp -R a ~/.ssh/x", CWD, sshRule)).toMatchObject({ path: "~/.ssh/x" });
	});
	it("-t / --target-directory destinations are checked", () => {
		const dirRule = [denyRule("Edit(~/.ssh)")];
		expect(checkBashDenyHit("cp -t ~/.ssh src", CWD, dirRule)).toMatchObject({ path: "~/.ssh" });
		expect(checkBashDenyHit("mv --target-directory=~/.ssh src", CWD, dirRule)).toMatchObject({ path: "~/.ssh" });
		expect(checkBashDenyHit("mv --target-directory ~/.ssh src", CWD, dirRule)).toMatchObject({ path: "~/.ssh" });
		expect(checkBashDenyHit("mv -t~/.ssh src", CWD, dirRule)).toMatchObject({ path: "~/.ssh" });
		expect(checkBashDenyHit("cp -t /tmp/d ~/.ssh/id_rsa", CWD, sshRule)).toMatchObject({ path: "~/.ssh/id_rsa" });
	});
	it("an unrecognized flag escalates to ask, never deny", () => {
		expect(checkBashDenyHit("mv -z a b", CWD, unrelated)).toBeNull();
		expect(checkBashDenyScan("mv -z a b", CWD, []).flagAsk).toEqual({ flag: "-z" });
		expect(checkBashDenyScan("cp -R src dst", CWD, []).flagAsk).toBeNull();
		expect(checkBashDenyScan("cp -t ~/.ssh src", CWD, []).flagAsk).toBeNull();
	});
	it("heredoc bodies piped to ssh skip local path checks", () => {
		expect(checkBashDenyHit("ssh host bash -s <<EOF\nrm ~/.ssh/x\nEOF", CWD, sshRule)).toBeNull();
		expect(checkBashDenyHit("ssh -tt host <<'EOF'\nrm ~/.ssh/x\nEOF", CWD, sshRule)).toBeNull();
	});
	it("local bash -s / sh -s heredoc bodies keep being analyzed", () => {
		expect(checkBashDenyHit("bash -s <<EOF\nrm ~/.ssh/x\nEOF", CWD, sshRule)).toMatchObject({ path: "~/.ssh/x" });
		expect(checkBashDenyHit("sh -s <<EOF\nrm ~/.ssh/x\nEOF", CWD, sshRule)).toMatchObject({ path: "~/.ssh/x" });
		expect(checkBashDenyHit("ssh host bash -s <<EOF\nrm ~/.ssh/x\nNEVER", CWD, sshRule)).toMatchObject({ path: "~/.ssh/x" });
		expect(checkBashDenyHit("cat <<<EOF", CWD, sshRule)).toBeNull();
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
		expect(checkBashWriteTargets("sed -i -e s/a/b/ ~/.zshrc", CWD)).toMatchObject({ path: "~/.zshrc" });
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
		expect(checkBashProtectedWrite("rm .pi/rules/r.md", CWD)).toMatchObject({ kind: "project-rules-dir" });
		expect(checkBashProtectedWrite("cat ~/.pi/agent/permission-modes.json", CWD)).toBeNull();
	});
	it("plain paths stay clean", () => {
		expect(checkBashProtectedWrite("echo x > src/out.ts", CWD)).toBeNull();
		expect(checkBashProtectedWrite("rm src/old.ts", CWD)).toBeNull();
	});
});

describe("review fixes 2026-11-08 (P2#4/#5): post-`--` semantics", () => {
	it("sed -- stops flag parsing: `sed -- -i s/x/y/ f` has -i as the script", () => {
		expect(checkBashWriteTargets("sed -- -i s/x/y/ f.txt", CWD)).toBeNull();
		const envDeny = [denyRule("Read(./f.txt)"), denyRule("Edit(./f.txt)")];
		const hit = checkBashDenyHit("sed -- -i s/x/y/ f.txt", CWD, envDeny);
		expect(hit).toMatchObject({ path: "f.txt", rule: "Read(./f.txt)" });
	});
	it("find -- : post-dash operands are all paths (CC superset)", () => {
		const envDeny = [denyRule("Read(./.env)")];
		expect(checkBashDenyHit("find -- -x .env -print", CWD, envDeny)).toMatchObject({ path: ".env" });
	});
});

describe("review fix 2026-11-08 (P2#6, pinned): compound suppression form", () => {
	it("a benign redirect segment suppresses the W3 hit on a later segment (documented approximation, bypass-level)", () => {
		expect(checkBashWriteTargets("echo x > /tmp/log; echo y > ~/.zshrc", CWD)).toBeNull();
		expect(checkBashWriteTargets("echo y > ~/.zshrc", CWD)).toMatchObject({ path: "~/.zshrc" });
	});
});

describe("cd tracking along && chains (E1, D-CH-4)", () => {
	it("W4: a Read deny rule hits through a cd-relative path (red on base)", () => {
		const envDeny = [denyRule("Read(./.env)")];
		expect(checkBashDenyHit("cd sub && cat ../.env", CWD, envDeny)).toMatchObject({
			path: "../.env",
			rule: "Read(./.env)",
		});
	});

	it("W4: chained cds accumulate", () => {
		const envDeny = [denyRule("Read(./.env)")];
		expect(checkBashDenyHit("cd sub && cd a && cat ../../.env", CWD, envDeny)).toMatchObject({
			path: "../../.env",
			rule: "Read(./.env)",
		});
	});

	it("residual: cd joined by ; / || keeps cwd resolution (no deny widening)", () => {
		const envDeny = [denyRule("Read(./.env)")];
		expect(checkBashDenyHit("cd sub; cat ../.env", CWD, envDeny)).toBeNull();
		expect(checkBashDenyHit("cd sub || cat ../.env", CWD, envDeny)).toBeNull();
	});

	it("non-literal cd keeps cwd resolution", () => {
		const envDeny = [denyRule("Read(./.env)")];
		expect(checkBashDenyHit("cd $(x) && cat ../.env", CWD, envDeny)).toBeNull();
	});
});

describe("checkBashDenyScan (S2 single-scan matrix)", () => {
	const envDeny = [denyRule("Read(./.env)")];
	const unrelated = [denyRule("Edit(~/.ssh/**)")];

	it("deny only", () => {
		expect(checkBashDenyScan("cat .env", CWD, envDeny)).toEqual({
			deny: { path: ".env", rule: "Read(./.env)", source: "global" },
			flagAsk: null,
		});
	});

	it("flagAsk only", () => {
		expect(checkBashDenyScan("mv -z a b", CWD, unrelated)).toEqual({
			deny: null,
			flagAsk: { flag: "-z" },
		});
	});

	it("both (deny short-circuits within a segment; a later segment supplies the other verdict)", () => {
		expect(checkBashDenyScan("mv -z a b && cat .env", CWD, envDeny)).toEqual({
			deny: { path: ".env", rule: "Read(./.env)", source: "global" },
			flagAsk: { flag: "-z" },
		});
	});

	it("neither", () => {
		expect(checkBashDenyScan("ls src", CWD, unrelated)).toEqual({
			deny: null,
			flagAsk: null,
		});
	});

	it("empty command yields both nulls", () => {
		expect(checkBashDenyScan("", CWD, envDeny)).toEqual({ deny: null, flagAsk: null });
	});
});
