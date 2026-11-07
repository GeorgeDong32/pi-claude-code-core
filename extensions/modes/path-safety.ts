/**
 * modes/path-safety.ts — filesystem geography for permission decisions.
 * Carved out of the old modes/utils.ts grab-bag (arch review C3, 2026-10-03);
 * behavior unchanged. Owns: outside-cwd detection (incl. symlink escapes and
 * tilde expansion), sensitive-path (.git) detection, and project identity
 * (project root discovery, stable project id, per-project tmp dir).
 */
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

/** Expand leading `~` for path comparisons (does not resolve symlinks). */
export function expandUserPath(p: string): string {
	const home = homedir()
	if (p === "~") return home
	if (p.startsWith("~/")) return path.join(home, p.slice(2))
	return p
}

/**
 * Returns true iff `targetPath` resolves to a location outside `cwd`.
 *
 * Empty string is treated as "inside cwd" (no path = nothing to be outside of).
 * Lexical resolution is used first; symlink components under cwd are checked so
 * a path like `link/file` cannot escape when `link` points outside cwd.
 */
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

/**
 * Heuristic: does a bash command reference paths outside `cwd`?
 *
 * Flags:
 *   - absolute paths anywhere in the command
 *   - `..` traversal (cd .., ls ../foo)
 *   - `~` or `$HOME` / `$TMPDIR` expansions
 *
 * Conservative: false negatives are acceptable (we still prompt for destructive
 * commands separately), false positives are NOT — we don't want to over-prompt.
 */
export function commandTargetsOutsideCwd(command: string, cwd: string): boolean {
	if (!command || !command.trim()) return false;

	// Absolute path anywhere in the command.
	// `/` must be at the start of a token (after whitespace, ;&|() or string start),
	// and the next char must be a real path char (not `.` to avoid `./` and `../` false positives).
	if (/(^|[\s;&|('])(\/[A-Za-z0-9_\-])/.test(command)) return true;

	// Tilde expansion: `~` at start of token (not in the middle of a path)
	if (/(^|[\s;&|()])(~|\$HOME|\$TMPDIR|\$TMP|\$PWD\b)/.test(command)) return true;

	// `..` as a path component (not as part of `...` or `./..`)
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

/** True when a tool path targets .git, .env*, SSH keys, or similar sensitive locations. */
export function isSensitivePath(targetPath: string, cwd: string): boolean {
	if (!targetPath) return false
	const p = expandUserPath(targetPath)
	const resolved = path.isAbsolute(p)
		? path.resolve(p)
		: path.resolve(cwd, p)
	return pathHasSensitiveSegment(resolved)
}

// ---- CC-parity safety set (W2, 2026-11-07) ------------------------------
// CC's checkPathSafetyForAutoEdit set (DANGEROUS_FILES / DANGEROUS_DIRECTORIES
// in claude-code src/utils/permissions/filesystem.ts) ∪ pi extras (.env*,
// key files, .ssh/, .gnupg/). Used ONLY by the bypass edit/write gate — the
// other modes keep the narrow isSensitivePath semantics. Case-insensitive
// segment matching mirrors CC's normalizeCaseForComparison.

/** CC DANGEROUS_FILES (filesystem.ts) — exact filename matches. */
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

/** pi additions to the CC file set — .env* by prefix, keys/credentials exact. */
export const CC_EXTRA_FILES_EXACT: readonly string[] = [
	"id_rsa",
	"id_ed25519",
	"credentials",
]

/** CC DANGEROUS_DIRECTORIES (filesystem.ts) + pi extras (.ssh, .gnupg). */
export const CC_DANGEROUS_DIRECTORIES: readonly string[] = [
	".git",
	".vscode",
	".idea",
	".claude",
	".ssh",
	".gnupg",
]

/**
 * W2 (2026-11-07): CC-parity safety-path check for the bypass edit/write
 * gate — any path segment hitting a dangerous directory, or the filename
 * hitting a dangerous file (CC set, case-insensitive; .env* by prefix,
 * pi key files). NOT used by the other modes' gates (they keep the narrow
 * isSensitivePath semantics); no Windows patterns (out of scope per
 * handoff 2026-11-07). Carries two CC behaviors over: the .claude/worktrees
 * structural exception, and the original + symlink-resolved double check.
 */
export function isCcSafetyPath(targetPath: string, cwd: string): boolean {
	if (!targetPath) return false
	const p = expandUserPath(targetPath)
	const resolved = path.isAbsolute(p)
		? path.resolve(p)
		: path.resolve(cwd, p)
	if (ccPathHasSensitiveSegment(resolved)) return true
	// Symlink double-check (CC getPathsForPermissionCheck parity): a clean
	// lexical path that resolves through a symlink onto a sensitive location
	// still prompts. Fail-open on resolution errors.
	try {
		if (existsSync(resolved)) {
			const real = realpathSync(resolved)
			if (real !== resolved && ccPathHasSensitiveSegment(real)) return true
		}
	} catch {
		/* fail-open */
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
		// CC structural exception: .claude/worktrees/ is where worktrees
		// live, not a user-configured dangerous dir — skip that .claude
		// segment (nested .claude dirs inside still match).
		if (lower === ".claude") {
			const next = segments[i + 1]
			if (next !== undefined && next.toLowerCase() === "worktrees") continue
		}
		return true
	}
	if (CC_DANGEROUS_FILES.some((d) => d === lowerFile)) return true
	if (CC_EXTRA_FILES_EXACT.some((d) => d === lowerFile)) return true
	// .env / .env.<suffix> — dot boundary, so `.environment.ts` stays clean
	// (same semantics as the narrow gate's SENSITIVE_FILE_PATTERN).
	if (/^\.env(?:\.|$)/.test(lowerFile)) return true
	return false
}

/** Heuristic: does a bash command reference sensitive paths (.git, .env, ~/.ssh, etc.)? */
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

/**
 * Walk up from `cwd` looking for a project root marker (.git or package.json).
 * Returns the project root path, or `null` if none found within 20 levels.
 */
export function findProjectRoot(cwd: string): string | null {
	let dir = path.resolve(cwd);
	for (let i = 0; i < 20; i++) {
		// Stop at filesystem root
		if (dir === path.dirname(dir)) return null;
		// Detect: .git, package.json
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

/**
 * Resolve the project's stable ID. Looks for the existing
 * `.pi/permission-modes-<hash>.md` marker file (created by pi when the
 * project was opened). Falls back to a hash of `cwd` if not found.
 *
 * The marker filename is the canonical source because pi creates it
 * automatically and uses the same hash for kanban boards, memory, etc.
 */
// Positive-result cache only: once a plan marker file is seen, its id is
// stable for the cwd. Negative results (hash fallback) stay uncached so a
// marker created mid-session switches the id over on the next call.
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
		/* ignore — fall through to hash fallback */
	}
	return hashPath(cwd)
}

/** First 8 hex chars of sha256(input). Deterministic. */
export function hashPath(p: string): string {
	return createHash("sha256").update(p).digest("hex").slice(0, 8)
}

/**
 * Return the absolute path to the project's outside-writes snapshot dir,
 * creating it (and all parents) if it doesn't exist.
 *
 * Layout: `<cwd>/.pi/projects/<projectId>/tmp/outside-writes/`
 *
 * Created lazily on first call so empty projects don't litter their tree.
 * Safe to call repeatedly — idempotent.
 */
export function getProjectTmpDir(cwd: string): string {
	const id = getProjectId(cwd)
	const dir = path.join(cwd, ".pi", "projects", id, "tmp", "outside-writes")
	mkdirSync(dir, { recursive: true })
	return dir
}

/**
 * Check if `targetPath` is inside the project root (if one can be detected
 * or is provided). Returns false if no project root is found — caller should
 * fall back to `isOutsideCwd` in that case.
 */
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
