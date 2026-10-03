/**
 * modes/bash-analysis.ts — bash command risk analysis (tiered adjudication).
 * Carved out of the old modes/utils.ts grab-bag (arch review C3, 2026-10-03);
 * behavior unchanged. Owns: fd-redirect stripping, shell segment splitting,
 * the safe/destructive/auto-fallback/auto-approvable pattern tables and the
 * tier classifier. Pure string/regex layer — no fs, no path resolution.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	// File redirects only — fd-to-fd (2>&1 / >&2) is stripped before matching.
	/(^|[^<])>(?!>)/,
	/>>/, // append redirect
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bfind\b[^\n|;&]*\s-delete\b/i,
	/\bfind\b[^\n|;&]*\s-exec\b/i,
	/\bfind\b[^\n|;&]*\s-execdir\b/i,
	/\bfind\b[^\n|;&]*\s-fexec\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	// Network fetch primitives are never tier-1 read-only (defense in depth;
	// adjudication ⑤) — data exfiltration and |sh execution vectors.
	/\bcurl\b/i,
	/\bwget\b/i,
];

// Read-only commands allowed without confirmation.
const SAFE_PATTERNS: RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	// No bare `env` here: `env VAR=x <cmd>` is an execution prefix, and the
	// SAFE patterns only anchor the start of the command (adjudication ⑤).
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*node\s+-v\b/i,
	/^\s*python\s+--version/i,
	/^\s*jq\b/,
	// `sed -n` is read-only except the `w` command, which writes a file
	// (`1w /path` or the `s///w path` suffix — the w hugs digits/delimiters,
	// so \b never fires there).
	/^\s*sed\s+-n(?![^\n]*(?:["',;/0-9}]|\s)w\s*["']?\s*[/~])/i,
	// No `awk` here: it is an interpreter with system()/redirect execution
	// vectors that the SAFE match cannot inspect (adjudication ⑤).
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

// Build/test commands allowed in auto-mode classifier fallback (after blacklist).
// Also gates tier-2 run-scripts (adjudication ③): offline conservative face
// must never be looser than the online auto-approve face.
const AUTO_FALLBACK_SCRIPT_NAMES =
	"test|build|lint|check|typecheck|verify|coverage|unit|ci|dev|start|preview|serve|watch"
const AUTO_FALLBACK_SCRIPT_TAIL = "(?:\\s|$)"
const AUTO_FALLBACK_BASH_PATTERNS: RegExp[] = [
	new RegExp(`^\\s*npm\\s+test${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
	new RegExp(
		`^\\s*npm\\s+run\\s+(${AUTO_FALLBACK_SCRIPT_NAMES})${AUTO_FALLBACK_SCRIPT_TAIL}`,
		"i",
	),
	new RegExp(
		`^\\s*(pnpm|yarn|bun)\\s+run\\s+(${AUTO_FALLBACK_SCRIPT_NAMES})${AUTO_FALLBACK_SCRIPT_TAIL}`,
		"i",
	),
	new RegExp(`^\\s*(pnpm|yarn|bun)\\s+test${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
	new RegExp(`^\\s*go\\s+test${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
	new RegExp(`^\\s*cargo\\s+test${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
	/^\s*make(\s+(test|check|build))?\s*$/i,
	/^\s*cmake\s+--build\b/i,
	new RegExp(`^\\s*pytest${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
	new RegExp(`^\\s*vitest${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
	new RegExp(`^\\s*jest${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
];

// Flags that turn routine test/build commands into arbitrary execution vectors.
const AUTO_FALLBACK_UNSAFE_ARG_PATTERNS: RegExp[] = [
	/(?:^|\s)-exec(?:=|\s|$)/i,
	/(?:^|\s)-toolexec(?:=|\s)/i,
	/(?:^|\s)--script-shell(?:=|\s)/i,
	/(?:^|\s)--node-options(?:=|\s)/i,
	/(?:^|\s)--config(?:=|\s)/i,
	/(?:^|\s)-c(?:=|\s+)\S/i,
	/(?:^|\s)--runner(?:=|\s)/i,
	/(?:^|\s)--preload(?:=|\s)/i,
	/(?:^|\s)--require(?:=|\s)/i,
	/(?:^|\s)--import(?:=|\s)/i,
	/(?:^|\s)--setupFiles(?:=|\s)/i,
	/(?:^|\s)--globalSetup(?:=|\s)/i,
	/(?:^|\s)--globalTeardown(?:=|\s)/i,
	/(?:^|\s)--target(?:=|\s+)(?:install|package|deploy)\b/i,
	/\s--(?:\s|$)/,
	/\bcmake\s+--build\b\s+(?:\/|~|\.\.)/i,
];

// Paths outside cwd in otherwise-routine test/build commands.
const AUTO_FALLBACK_OUTSIDE_PATH_PATTERNS: RegExp[] = [
	/(?:^|\s)-o(?:=|\s+)(?:(?:\/|~|\.\.)|["'](?:\/|~|\.\.))/i,
	/(?:^|\s)--manifest-path(?:=|\s+)(?:(?:\/|~|\.\.)|["'](?:\/|~|\.\.))/i,
	/(?:^|\s)--target(?:=|\s+)(?:(?:\/|~|\.\.)|["'](?:\/|~|\.\.))/i,
	/(?:^|\s)--chdir(?:=|\s+)(?:(?:\/|~|\.\.)|["'](?:\/|~|\.\.))/i,
	/(?:^|\s)--project-directory(?:=|\s+)(?:(?:\/|~|\.\.)|["'](?:\/|~|\.\.))/i,
	/(?:^|\s)[\w-]+=(?:\/|~|\.\.)/,
	/(?:^|\s|=)(?:\/[^\s]*|~\/[^\s]*|\.\.(?:\/[^\s]*)?)/,
	/(?:^|\s)["'](?:\/|~|\.\.)[^"']*["']/,
	/(?:^|\s)[\w-]+=["'](?:\/|~|\.\.)[^"']*["']/,
];

const NESTED_SHELL_PATTERNS: RegExp[] = [/`/, /\$\(/, /\$\{/, /<\(/, />\(/];

/**
 * Strip fd-to-fd redirects like `2>&1`, `>&2`, `1<&0`.
 * These do not write files and must not trip the `>` destructive check.
 * Agents commonly append `2>&1` when exploring in plan mode.
 */
export function stripFdToFdRedirects(command: string): string {
	return command.replace(/(?:\d*)>&\d+/g, " ").replace(/(?:\d*)<&\d+/g, " ")
}

function isCharEscaped(command: string, index: number): boolean {
	let backslashes = 0
	for (let j = index - 1; j >= 0 && command[j] === "\\"; j--) {
		backslashes++
	}
	return backslashes % 2 === 1
}

/** Split compound shell commands into segments (best-effort; not a full shell parser). */
export function splitShellSegments(command: string): string[] {
	const segments: string[] = []
	let current = ""
	let quote: "'" | '"' | null = null

	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!
		if (quote) {
			current += ch
			if (ch === quote && (quote === "'" || !isCharEscaped(command, i))) {
				quote = null
			}
			continue
		}
		if (ch === "'" || ch === '"') {
			if (!isCharEscaped(command, i)) quote = ch
			current += ch
			continue
		}
		if (ch === ";" && !isCharEscaped(command, i)) {
			if (current.trim()) segments.push(current.trim())
			current = ""
			continue
		}
		if (
			(command.startsWith("&&", i) || command.startsWith("||", i)) &&
			!isCharEscaped(command, i)
		) {
			if (current.trim()) segments.push(current.trim())
			current = ""
			i += 1
			continue
		}
		if (ch === "|" && command[i + 1] !== "|" && !isCharEscaped(command, i)) {
			if (current.trim()) segments.push(current.trim())
			current = ""
			continue
		}
		if (ch === "&" && command[i + 1] !== "&" && !isCharEscaped(command, i)) {
			if (command[i - 1] === ">" || command[i + 1] === ">") {
				current += ch
				continue
			}
			if (current.trim()) segments.push(current.trim())
			current = ""
			continue
		}
		if (ch === "\n" && !isCharEscaped(command, i)) {
			if (current.trim()) segments.push(current.trim())
			current = ""
			continue
		}
		current += ch
	}

	if (current.trim()) segments.push(current.trim())
	return segments
}

function hasNestedShellExecution(command: string): boolean {
	let quote: "'" | '"' | null = null
	let scanText = ""

	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!
		if (quote === "'") {
			if (ch === "'" && !isCharEscaped(command, i)) quote = null
			continue
		}
		if (quote === '"') {
			scanText += ch
			if (ch === '"' && !isCharEscaped(command, i)) quote = null
			continue
		}
		if (ch === "'" || ch === '"') {
			if (!isCharEscaped(command, i)) {
				quote = ch
				if (ch === '"') scanText += ch
				continue
			}
		}
		scanText += ch
	}

	return NESTED_SHELL_PATTERNS.some((p) => p.test(scanText))
}

function isSafeSingleCommand(command: string): boolean {
	if (hasNestedShellExecution(command)) return false
	const normalized = stripFdToFdRedirects(command)
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(normalized))
	const isSafe = SAFE_PATTERNS.some((p) => p.test(normalized))
	return !isDestructive && isSafe
}

function hasUnsafeFallbackArgs(segment: string): boolean {
	return AUTO_FALLBACK_UNSAFE_ARG_PATTERNS.some((p) => p.test(segment))
}

function hasOutsideCwdFallbackTargets(segment: string): boolean {
	return AUTO_FALLBACK_OUTSIDE_PATH_PATTERNS.some((p) => p.test(segment))
}

function matchesAutoFallbackPattern(segment: string): boolean {
	return (
		AUTO_FALLBACK_BASH_PATTERNS.some((p) => p.test(segment)) &&
		!hasUnsafeFallbackArgs(segment) &&
		!hasOutsideCwdFallbackTargets(segment)
	)
}

/** A command is "safe" iff every shell segment matches the allowlist AND none are destructive. */
export function isSafeCommand(command: string): boolean {
	return segmentsSatisfy(splitShellSegments(command), isSafeSingleCommand)
}

/** Auto-mode fallback after blacklist: safe read-only OR routine build/test commands. */
export function isAutoFallbackBash(command: string): boolean {
	const segments = splitShellSegments(command)
	if (segments.length === 0) return false
	return segments.every(
		(seg) =>
			!hasNestedShellExecution(seg) &&
			(isSafeSingleCommand(seg) || matchesAutoFallbackPattern(seg)),
	)
}

function segmentsSatisfy(
	segments: string[],
	predicate: (segment: string) => boolean,
): boolean {
	return segments.length > 0 && segments.every(predicate)
}

/**
 * Both tier verdicts from ONE splitShellSegments pass — the auto-mode tier
 * ladder calls isSafeCommand and isAutoApprovableBash back to back on the
 * same command, and each re-tokenized it (plan A4). Pure; equivalent to
 * calling the two functions separately.
 */
export function classifyBashTiers(command: string): {
	safe: boolean
	autoApprovable: boolean
} {
	const segments = splitShellSegments(command)
	return {
		safe: segmentsSatisfy(segments, isSafeSingleCommand),
		autoApprovable:
			segments.length > 0 &&
			segments.every(
				(seg) =>
					!hasNestedShellExecution(seg) &&
					(isSafeSingleCommand(seg) || isAutoApprovableSingleCommand(seg)),
			),
	}
}

// ---------------------------------------------------------------------------
// Auto-mode auto-approvable commands (broader than isAutoFallbackBash).
// Common dev workflow commands with controlled side-effects that don't need
// classifier review in auto mode.
//
// Adjudication 2026-09-12 (docs/bash-risk-adjudication-2026-09-12.md):
// - run-scripts are restricted to the AUTO_FALLBACK_SCRIPT_NAMES whitelist;
// - git hook vectors (commit/merge/rebase/cherry-pick/revert) and worktree-
//   loss forms (restore/checkout) are tier-3, not tier-2;
// - docker run/exec are tier-3 (host-mount execution vectors);
// - tier-2 reuses the fallback guardrails (unsafe args, outside-cwd paths).
// ---------------------------------------------------------------------------

// Tier-2 auto approvals (CC-aligned): routine builds/tests and cwd-local git ops.
// Network fetch, package install, arbitrary interpreters, git fetch/pull,
// git hook vectors, worktree-loss git forms, and docker run/exec require
// tier-3 classifier review.
const AUTO_APPROVABLE_PATTERNS: RegExp[] = [
	// Build / run scripts (whitelist-gated; deploy-like names fall to tier-3)
	new RegExp(`^\\s*npm\\s+run\\s+(${AUTO_FALLBACK_SCRIPT_NAMES})${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
	new RegExp(`^\\s*(pnpm|yarn|bun)\\s+run\\s+(${AUTO_FALLBACK_SCRIPT_NAMES})${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
	/^\s*(make|cmake)\b/i,
	/^\s*cargo\s+(build|check|clippy|fmt|test)\b/i,
	/^\s*go\s+(build|vet|fmt|mod|test)\b/i,
	// Git local write operations with no hook vector and no worktree-loss form
	// (no commit/merge/rebase/cherry-pick/revert/restore/checkout).
	/^\s*git\s+(add|stash|branch|switch|tag|init|clone|reset)\b/i,
	// File operations within workflow (outside-cwd paths blocked by guardrails)
	/^\s*mkdir\b/i,
	/^\s*touch\b/i,
	/^\s*cp\b/i,
	/^\s*mv\b/i,
	// Code formatting / linting / type-checking (pinned tools only)
	/^\s*npx\s+(prettier|eslint|tsc|esbuild|vite|next|nuxt|astro)\b/i,
	/^\s*(prettier|eslint|biome)\b/i,
	/^\s*tsc\b/i,
	// Test runners
	/^\s*npm\s+test\b/i,
	/^\s*(pnpm|yarn|bun)\s+test\b/i,
	/^\s*(vitest|jest|mocha|ava|tap)\b/i,
	/^\s*pytest\b/i,
	/^\s*go\s+test\b/i,
	/^\s*cargo\s+test\b/i,
	// Docker local dev without execution forms (run/exec are tier-3)
	/^\s*docker\s+(build|compose|logs|ps|images)\b/i,
];

const AUTO_APPROVABLE_EXCLUDE: RegExp[] = [
	/\brm\b/,
	/\bsudo\b/,
	/\bsu\b/,
	/--force\b/,
	/\s-f\b/,
	/\bgit\s+push\b/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\b/,
	/\bnpm\s+publish\b/,
	/\b--exec\b/,
	/\b-exec\b/,
	/\bexec\b/,
	/\bkill\b/,
	/\bpkill\b/,
	/\bkillall\b/,
	/\breboot\b/,
	/\bshutdown\b/,
	/\bdd\b/,
	/\bshred\b/,
	/\bchmod\b/,
	/\bchown\b/,
	/>/,
];

function isAutoApprovableSingleCommand(command: string): boolean {
	if (hasNestedShellExecution(command)) return false
	const normalized = stripFdToFdRedirects(command)
	if (AUTO_APPROVABLE_EXCLUDE.some((p) => p.test(normalized))) return false
	// Adjudication ③ (2026-09-12): tier-2 must not be looser than the
	// classifier-offline fallback — reuse its unsafe-arg and outside-cwd guards.
	if (hasUnsafeFallbackArgs(normalized)) return false
	if (hasOutsideCwdFallbackTargets(normalized)) return false
	return AUTO_APPROVABLE_PATTERNS.some((p) => p.test(normalized))
}

/**
 * Broader auto-mode check: approves common dev workflow commands (package
 * installs, builds, git local ops, file ops) without classifier review.
 * Every shell segment must be approvable and no segment may be dangerous.
 */
export function isAutoApprovableBash(command: string): boolean {
	return classifyBashTiers(command).autoApprovable
}
