/**
 * bash-analysis tests — carved from utils.test.ts (arch review C3).
 */
import { describe, expect, it } from "vitest";
import { classifyBashTiers, isAutoApprovableBash, isAutoFallbackBash, isSafeCommand } from "./bash-analysis.ts";

describe("isSafeCommand", () => {
	it("approves commands matching SAFE_PATTERNS", () => {
		expect(isSafeCommand("ls -la")).toBe(true);
		expect(isSafeCommand("cat foo.txt")).toBe(true);
		expect(isSafeCommand("grep -r pattern src")).toBe(true);
		expect(isSafeCommand("git status")).toBe(true);
		expect(isSafeCommand("git log --oneline")).toBe(true);
		expect(isSafeCommand("npm list")).toBe(true);
		expect(isSafeCommand("curl https://example.com")).toBe(false);
		expect(isSafeCommand("wget -O - https://example.com")).toBe(false);
	});

	it("rejects destructive commands", () => {
		expect(isSafeCommand("rm -rf /")).toBe(false);
		expect(isSafeCommand("mv foo bar")).toBe(false);
		expect(isSafeCommand("npm install")).toBe(false);
		expect(isSafeCommand("git commit -m msg")).toBe(false);
		expect(isSafeCommand("sudo apt install foo")).toBe(false);
	});

	it("rejects safe-prefixed commands that contain destructive content", () => {
		// safe pattern + destructive = not safe
		expect(isSafeCommand("ls && rm -rf /")).toBe(false)
		expect(isSafeCommand("ls; python -c \"open('/tmp/x','w').write('x')\"")).toBe(
			false,
		)
		expect(isSafeCommand("echo hi > out.txt")).toBe(false) // redirect
	})

	it("rejects empty / whitespace-only strings", () => {
		expect(isSafeCommand("")).toBe(false);
		expect(isSafeCommand("   ")).toBe(false);
		expect(isSafeCommand("\n")).toBe(false);
	});

	it("rejects unknown commands", () => {
		expect(isSafeCommand("someweirdcommand foo bar")).toBe(false);
	});

	it("rejects safe-prefixed find with destructive flags", () => {
		expect(isSafeCommand("find . -delete")).toBe(false);
		expect(isSafeCommand("find . -exec rm {} \\;")).toBe(false);
	});

	it("allows literal nested markers inside single quotes", () => {
		expect(isSafeCommand("rg -F '$(' src")).toBe(true)
		expect(isSafeCommand("echo 'literal ` text'")).toBe(true)
	});

	it("still rejects nested execution outside single quotes", () => {
		expect(isSafeCommand('echo "$(rm -rf /)"')).toBe(false)
	});

	it("treats escaped semicolons as part of one command", () => {
		expect(isSafeCommand("printf foo\\;bar")).toBe(true)
	});

	it("allows stderr/stdout fd redirects commonly used by agents", () => {
		expect(isSafeCommand("ls -1 /tmp 2>&1")).toBe(true)
		expect(isSafeCommand("cat foo.txt 2>&1 | head -60")).toBe(true)
		expect(
			isSafeCommand(
				"ls -la /tmp 2>&1; cat CHANGELOG.md 2>&1 | head -60",
			),
		).toBe(true)
		expect(isSafeCommand("git status >&2")).toBe(true)
	});

	it("still rejects real file redirects", () => {
		expect(isSafeCommand("ls > out.txt")).toBe(false)
		expect(isSafeCommand("cat foo 2> err.txt")).toBe(false)
		expect(isSafeCommand("echo hi >> out.txt")).toBe(false)
	});
});

describe("isAutoFallbackBash", () => {
	it("allows routine build and test commands", () => {
		expect(isAutoFallbackBash("npm test")).toBe(true)
		expect(isAutoFallbackBash("npm run build")).toBe(true)
		expect(isAutoFallbackBash("go test ./...")).toBe(true)
		expect(isAutoFallbackBash("cargo test")).toBe(true)
	})

	// Adjudication ③ (2026-09-12): whitelist extended with dev-server script names.
	it("allows dev-server script names on the extended whitelist", () => {
		expect(isAutoFallbackBash("npm run dev")).toBe(true)
		expect(isAutoFallbackBash("npm run start")).toBe(true)
		expect(isAutoFallbackBash("pnpm run preview")).toBe(true)
		expect(isAutoFallbackBash("yarn run serve")).toBe(true)
	})

	it("rejects arbitrary package scripts", () => {
		expect(isAutoFallbackBash("npm run deploy")).toBe(false)
		expect(isAutoFallbackBash("pnpm run destroy-production")).toBe(false)
		expect(isAutoFallbackBash("npm run build-and-deploy")).toBe(false)
		expect(isAutoFallbackBash("pnpm run test:reset-db")).toBe(false)
	})

	it("rejects background compound commands", () => {
		expect(
			isAutoFallbackBash("npm test & python -c \"import os; os.system('id')\""),
		).toBe(false)
	})

	it("rejects quoted compound commands with escaped closing quotes", () => {
		expect(isAutoFallbackBash('npm test "\\\\"; npm run deploy')).toBe(false)
		expect(isAutoFallbackBash("npm test 'foo\\'; npm run deploy")).toBe(false)
		expect(isAutoFallbackBash('npm test \\"x; npm run deploy')).toBe(false)
	})

	it("rejects process substitution", () => {
		expect(isAutoFallbackBash("npm test <(npm run deploy)")).toBe(false)
	})

	it("allows stderr redirection on fallback commands", () => {
		expect(isAutoFallbackBash("npm test 2>&1")).toBe(true)
	})

	it("rejects executable and config injection flags on fallback commands", () => {
		expect(isAutoFallbackBash("go test -exec /tmp/payload ./...")).toBe(false)
		expect(isAutoFallbackBash("vitest --config /tmp/evil.config.ts")).toBe(false)
		expect(isAutoFallbackBash("jest --config=evil.config.js")).toBe(false)
		expect(isAutoFallbackBash("npm test -- node /tmp/exploit.js")).toBe(false)
		expect(isAutoFallbackBash("cmake --build /tmp/out")).toBe(false)
		expect(isAutoFallbackBash("go test -toolexec /tmp/payload ./...")).toBe(false)
		expect(isAutoFallbackBash("npm test --script-shell=/tmp/payload")).toBe(
			false,
		)
	})

	it("still allows bounded fallback commands with normal args", () => {
		expect(isAutoFallbackBash("go test ./...")).toBe(true)
		expect(isAutoFallbackBash("vitest run")).toBe(true)
		expect(isAutoFallbackBash("cmake --build .")).toBe(true)
		expect(isAutoFallbackBash("pytest tests/unit")).toBe(true)
	})

	it("rejects outside-cwd targets in fallback test commands", () => {
		expect(isAutoFallbackBash("pytest /tmp/evil.py")).toBe(false)
		expect(
			isAutoFallbackBash("cargo test --manifest-path /tmp/evil/Cargo.toml"),
		).toBe(false)
		expect(isAutoFallbackBash("go test -o /tmp/testbin")).toBe(false)
		expect(isAutoFallbackBash('go test -o "/tmp/testbin"')).toBe(false)
		expect(
			isAutoFallbackBash('cargo test --manifest-path "/tmp/evil/Cargo.toml"'),
		).toBe(false)
		expect(isAutoFallbackBash("vitest --root=../evil")).toBe(false)
		expect(isAutoFallbackBash("jest --testEnvironment=/tmp/evil.js")).toBe(
			false,
		)
	})

	it("rejects cmake install targets in fallback build commands", () => {
		expect(isAutoFallbackBash("cmake --build . --target install")).toBe(false)
	})

	it("rejects nested shell execution", () => {
		expect(
			isSafeCommand('ls $(python -c "open(\'/tmp/x\',\'w\').write(\'x\')")'),
		).toBe(false)
	})

	it("still rejects destructive compound commands", () => {
		expect(isAutoFallbackBash("npm test; rm -rf /")).toBe(false)
		expect(isAutoFallbackBash("ls; python -c \"open('/tmp/x','w').write('x')\"")).toBe(
			false,
		)
	})
});

// Adjudicated 2026-09-12 — see docs/bash-risk-adjudication-2026-09-12.md.

describe("isAutoApprovableBash (bash-risk adjudication 2026-09-12)", () => {
	it("keeps hook-free, reversible git ops in tier 2", () => {
		expect(isAutoApprovableBash("git add .")).toBe(true)
		expect(isAutoApprovableBash("git stash")).toBe(true)
		expect(isAutoApprovableBash("git branch feat")).toBe(true)
		expect(isAutoApprovableBash("git switch feat")).toBe(true)
		expect(isAutoApprovableBash("git tag v1")).toBe(true)
		expect(isAutoApprovableBash("git init")).toBe(true)
		expect(isAutoApprovableBash("git clone https://example.com/repo")).toBe(true)
		expect(isAutoApprovableBash("git reset HEAD~1")).toBe(true)
	})

	it("demotes git hook vectors and worktree-loss forms to tier 3", () => {
		// commit/merge/rebase/cherry-pick/revert run .git/hooks (repo-controlled code).
		expect(isAutoApprovableBash("git commit -m msg")).toBe(false)
		expect(isAutoApprovableBash("git merge main")).toBe(false)
		expect(isAutoApprovableBash("git rebase main")).toBe(false)
		expect(isAutoApprovableBash("git cherry-pick abc123")).toBe(false)
		expect(isAutoApprovableBash("git revert abc123")).toBe(false)
		// restore / checkout -- <path> can discard uncommitted work.
		expect(isAutoApprovableBash("git restore .")).toBe(false)
		expect(isAutoApprovableBash("git checkout -- src/app.ts")).toBe(false)
	})

	it("restricts package run-scripts to the script whitelist", () => {
		expect(isAutoApprovableBash("npm run build")).toBe(true)
		expect(isAutoApprovableBash("npm run test")).toBe(true)
		expect(isAutoApprovableBash("npm run dev")).toBe(true)
		expect(isAutoApprovableBash("pnpm run start")).toBe(true)
		expect(isAutoApprovableBash("yarn run preview")).toBe(true)
		// Non-whitelisted scripts fall to tier-3 classifier review.
		expect(isAutoApprovableBash("npm run deploy")).toBe(false)
		expect(isAutoApprovableBash("pnpm run destroy-production")).toBe(false)
	})

	it("reuses the offline fallback guardrails (unsafe args, outside-cwd paths)", () => {
		expect(isAutoApprovableBash("npm run test --config /tmp/evil.config.ts")).toBe(false)
		expect(isAutoApprovableBash("vitest --require /tmp/evil.ts")).toBe(false)
		expect(isAutoApprovableBash("mv notes.txt ~/")).toBe(false)
		expect(isAutoApprovableBash("cp src.ts /etc/passwd-copy")).toBe(false)
		expect(isAutoApprovableBash("mkdir /tmp/escape")).toBe(false)
		// cwd-relative workflow ops stay tier-2.
		expect(isAutoApprovableBash("mkdir build-out")).toBe(true)
		expect(isAutoApprovableBash("cp a.ts b.ts")).toBe(true)
	})

	it("demotes docker run/exec to tier 3 but keeps build/compose/inspect forms", () => {
		expect(isAutoApprovableBash("docker run alpine sh")).toBe(false)
		expect(isAutoApprovableBash("docker exec web sh")).toBe(false)
		expect(isAutoApprovableBash("docker build .")).toBe(true)
		expect(isAutoApprovableBash("docker compose up -d")).toBe(true)
		expect(isAutoApprovableBash("docker logs web")).toBe(true)
		expect(isAutoApprovableBash("docker ps")).toBe(true)
	})
})

// One tokenization pass must not change either verdict (plan A4).

describe("classifyBashTiers equivalence (plan A4)", () => {
	const sampleCommands = [
		"ls -la",
		"cat foo.txt | grep x",
		"git add .",
		"git commit -m x",
		"npm run dev",
		"npm run deploy",
		"mv notes.txt ~/",
		"docker run alpine",
		"rm -rf /",
		"echo hi > out.txt",
		"mkdir build-out",
		"",
		"   ",
	]

	it("matches isSafeCommand and isAutoApprovableBash on every sample", () => {
		for (const cmd of sampleCommands) {
			const tiers = classifyBashTiers(cmd)
			expect(tiers.safe).toBe(isSafeCommand(cmd))
			expect(tiers.autoApprovable).toBe(isAutoApprovableBash(cmd))
		}
	})
})

// Adjudicated 2026-09-12 — see docs/bash-risk-adjudication-2026-09-12.md.

describe("isSafeCommand tier-1 bypass fixes (bash-risk adjudication 2026-09-12)", () => {
	it("no longer treats env-prefixed commands as read-only", () => {
		expect(isSafeCommand("env")).toBe(false)
		expect(isSafeCommand("env X=1 python3 -c 'print(1)'")).toBe(false)
		expect(isSafeCommand("printenv")).toBe(true)
	})

	it("no longer treats awk as read-only (interpreter with system()/redirect vectors)", () => {
		expect(isSafeCommand("awk '{print $1}' file.txt")).toBe(false)
		expect(isSafeCommand("awk 'BEGIN{system(\"id\")}'")).toBe(false)
	})

	it("blocks sed -n write-to-file forms but keeps plain read printing", () => {
		expect(isSafeCommand("sed -n '1,5p' file.txt")).toBe(true)
		expect(isSafeCommand("sed -n '1w /tmp/x' file.txt")).toBe(false)
		expect(isSafeCommand("sed -n '1w/tmp/x' file.txt")).toBe(false)
	})

	it("treats curl/wget as destructive (defense in depth)", () => {
		expect(isSafeCommand("curl https://example.com")).toBe(false)
		expect(isSafeCommand("wget -O - https://example.com")).toBe(false)
	})
})
