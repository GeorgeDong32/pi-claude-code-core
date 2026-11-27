import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

export function expandUserPath(p: string): string {
	const home = homedir()
	if (p === "~") return home
	if (p.startsWith("~/")) return path.join(home, p.slice(2))
	return p
}

export function isOutsideCwd(targetPath: string, cwd: string): boolean {
	if (!targetPath) return false
	const p = expandUserPath(targetPath)
	const resolved = path.isAbsolute(p)
		? path.resolve(p)
		: path.resolve(cwd, p)
	const cwdAbs = path.resolve(cwd)

	if (resolved === cwdAbs) return false
	if (!resolved.startsWith(cwdAbs + path.sep)) return true

	return pathEscapesCwdViaSymlink(resolved, cwdAbs)
}

function pathEscapesCwdViaSymlink(target: string, cwdAbs: string): boolean {
	try {
		const realCwd = existsSync(cwdAbs) ? realpathSync(cwdAbs) : cwdAbs
		let probe = target
		while (probe === cwdAbs || probe.startsWith(cwdAbs + path.sep)) {
			if (existsSync(probe)) {
				const real = realpathSync(probe)
				if (real === realCwd) return false
				if (!real.startsWith(realCwd + path.sep) && real !== realCwd) {
					return true
				}
			}
			const parent = path.dirname(probe)
			if (parent === probe) break
			probe = parent
		}
		return false
	} catch {
		return false
	}
}

export function commandTargetsOutsideCwd(command: string, cwd: string): boolean {
	if (!command || !command.trim()) return false;

	if (/(^|[\s;&|('])(\/[A-Za-z0-9_\-])/.test(command)) return true;

	if (/(^|[\s;&|()])(~|\$HOME|\$TMPDIR|\$TMP|\$PWD\b)/.test(command)) return true;

	if (/(^|[\s;&|(])\.\.($|[\s/&|)])/.test(command)) return true;

	return false;
}

const SENSITIVE_DIR_NAMES = new Set([".git"])
const SENSITIVE_FILE_PATTERN =
	/^\.env(?:\.|$)|^id_rsa$|^id_ed25519$|^credentials$/

function pathHasSensitiveSegment(resolvedPath: string): boolean {
	const parts = resolvedPath.split(path.sep)
	for (const part of parts) {
		if (SENSITIVE_DIR_NAMES.has(part)) return true
		if (SENSITIVE_FILE_PATTERN.test(part)) return true
	}
	return false
}

export function isSensitivePath(targetPath: string, cwd: string): boolean {
	if (!targetPath) return false
	const p = expandUserPath(targetPath)
	const resolved = path.isAbsolute(p)
		? path.resolve(p)
		: path.resolve(cwd, p)
	return pathHasSensitiveSegment(resolved)
}


export const CC_DANGEROUS_FILES: readonly string[] = [
	".gitconfig",
	".gitmodules",
	".bashrc",
	".bash_profile",
	".zshrc",
	".zprofile",
	".profile",
	".ripgreprc",
	".mcp.json",
	".claude.json",
]

export const CC_EXTRA_FILES_EXACT: readonly string[] = [
	"id_rsa",
	"id_ed25519",
	"credentials",
]

export const CC_DANGEROUS_DIRECTORIES: readonly string[] = [
	".git",
	".vscode",
	".idea",
	".claude",
	".ssh",
	".gnupg",
]

export function isCcSafetyPath(targetPath: string, cwd: string): boolean {
	if (!targetPath) return false
	const p = expandUserPath(targetPath)
	const resolved = path.isAbsolute(p)
		? path.resolve(p)
		: path.resolve(cwd, p)
	if (ccPathHasSensitiveSegment(resolved)) return true
	try {
		if (existsSync(resolved)) {
			const real = realpathSync(resolved)
			if (real !== resolved && ccPathHasSensitiveSegment(real)) return true
		}
	} catch {
	}
	return false
}

function ccPathHasSensitiveSegment(resolvedPath: string): boolean {
	const segments = resolvedPath.split(path.sep)
	const fileName = segments.at(-1) ?? ""
	const lowerFile = fileName.toLowerCase()
	for (let i = 0; i < segments.length; i++) {
		const lower = segments[i]!.toLowerCase()
		if (!CC_DANGEROUS_DIRECTORIES.some((d) => d === lower)) continue
		if (lower === ".claude") {
			const next = segments[i + 1]
			if (next !== undefined && next.toLowerCase() === "worktrees") continue
		}
		return true
	}
	if (CC_DANGEROUS_FILES.some((d) => d === lowerFile)) return true
	if (CC_EXTRA_FILES_EXACT.some((d) => d === lowerFile)) return true
	if (/^\.env(?:\.|$)/.test(lowerFile)) return true
	return false
}

export function commandReferencesSensitivePath(command: string): boolean {
	if (!command.trim()) return false
	if (/(?:^|[\s;&|('"[(])\.git(?:\/|\s|$|['")\]])/.test(command)) return true
	if (/(?:^|[\s;&|('"[(])\.env(?:\.|\s|$|['")\]])/.test(command)) return true
	if (/\bid_rsa\b/.test(command)) return true
	if (/\bid_ed25519\b/.test(command)) return true
	if (/(?:^|[\s;&|()])~\/\.ssh\b/.test(command)) return true
	if (/(?:^|[\s;&|()])\$HOME\/\.ssh\b/.test(command)) return true
	return false
}

export function findProjectRoot(cwd: string): string | null {
	let dir = path.resolve(cwd);
	for (let i = 0; i < 20; i++) {
		if (dir === path.dirname(dir)) return null;
		if (
			existsSync(path.join(dir, ".git")) ||
			existsSync(path.join(dir, "package.json"))
		) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	return null;
}

const projectIdCache = new Map<string, string>()

export function getProjectId(cwd: string): string {
	const cached = projectIdCache.get(cwd)
	if (cached) return cached
	try {
		const piDir = path.join(cwd, ".pi")
		if (existsSync(piDir)) {
			const entries = readdirSync(piDir)
			const match = entries.find((e) =>
				/^permission-modes-[a-f0-9]+\.md$/.test(e),
			)
			if (match) {
				const id = match.replace(/^permission-modes-/, "").replace(/\.md$/, "")
				projectIdCache.set(cwd, id)
				return id
			}
		}
	} catch {
	}
	return hashPath(cwd)
}

export function hashPath(p: string): string {
	return createHash("sha256").update(p).digest("hex").slice(0, 8)
}

export function getProjectTmpDir(cwd: string): string {
	const id = getProjectId(cwd)
	const dir = path.join(cwd, ".pi", "projects", id, "tmp", "outside-writes")
	mkdirSync(dir, { recursive: true })
	return dir
}

export function isInsideProject(
	targetPath: string,
	cwd: string,
	projectRoot?: string | null,
): boolean {
	const root = projectRoot ?? findProjectRoot(cwd);
	if (!root) return false;
	const resolved = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(cwd, targetPath);
	const rootAbs = path.resolve(root);
	return resolved.startsWith(rootAbs + path.sep) || resolved === rootAbs;
}
