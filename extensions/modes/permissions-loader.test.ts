import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	getProjectPermissionsPath,
	loadMergedPermissionRules,
	warnIfLocalPermissionsNotGitignored,
	writeProjectPermissionsFile,
	writeGlobalPermissionsConfig,
} from "./permissions-loader.ts"
import { setConfigPath } from "./config.ts"

describe("permissions-loader", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-perm-"))
		setConfigPath(join(tmpDir, "permission-modes.json"))
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("merges global and project rules", () => {
		writeGlobalPermissionsConfig({
			allow: ["Bash(npm run:*)"],
		})
		writeProjectPermissionsFile(tmpDir, {
			deny: ["Bash(rm *)"],
		})
		const rules = loadMergedPermissionRules(tmpDir)
		expect(rules.some((r) => r.behavior === "allow")).toBe(true)
		expect(rules.some((r) => r.behavior === "deny")).toBe(true)
	})
})

describe("warnIfLocalPermissionsNotGitignored (E8a)", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-gitignore-"))
		execFileSync("git", ["init", "-q"], { cwd: tmpDir })
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	function makeLocalFile(): void {
		mkdirSync(join(getProjectPermissionsPath(tmpDir, true), ".."), { recursive: true })
		writeFileSync(getProjectPermissionsPath(tmpDir, true), "{}")
	}

	it("no tip when a parent-directory pattern (.pi/projects/) is gitignored (red on base)", () => {
		makeLocalFile()
		writeFileSync(join(tmpDir, ".gitignore"), ".pi/projects/\n")
		const tips: string[] = []
		warnIfLocalPermissionsNotGitignored(tmpDir, (m) => tips.push(m))
		expect(tips).toEqual([])
	})

	it("a `.pi/` gitignore pattern covers the local file — no tip (red on base)", () => {
		makeLocalFile()
		writeFileSync(join(tmpDir, ".gitignore"), ".pi/\n")
		const tips: string[] = []
		warnIfLocalPermissionsNotGitignored(tmpDir, (m) => tips.push(m))
		expect(tips).toEqual([])
	})

	it("still tips when the entry is not ignored", () => {
		makeLocalFile()
		writeFileSync(join(tmpDir, ".gitignore"), "dist/\n")
		const tips: string[] = []
		warnIfLocalPermissionsNotGitignored(tmpDir, (m) => tips.push(m))
		expect(tips).toHaveLength(1)
		expect(tips[0]).toContain("permissions.local.json")
	})

	it("no tip in a non-repo when the exact entry line matches (fallback)", () => {
		rmSync(join(tmpDir, ".git"), { recursive: true, force: true })
		makeLocalFile()
		const entry = getProjectPermissionsPath(tmpDir, true).slice(tmpDir.length + 1)
		writeFileSync(join(tmpDir, ".gitignore"), `${entry}\n`)
		const tips: string[] = []
		warnIfLocalPermissionsNotGitignored(tmpDir, (m) => tips.push(m))
		expect(tips).toEqual([])
	})

	it("tips in a non-repo when the line does not match (fallback)", () => {
		rmSync(join(tmpDir, ".git"), { recursive: true, force: true })
		makeLocalFile()
		writeFileSync(join(tmpDir, ".gitignore"), "dist/\n")
		const tips: string[] = []
		warnIfLocalPermissionsNotGitignored(tmpDir, (m) => tips.push(m))
		expect(tips).toHaveLength(1)
	})
})
