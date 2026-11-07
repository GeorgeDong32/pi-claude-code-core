/**
 * modes/bash-path-check.ts — bash path-target checks (W3/W4/W5, 2026-11-07
 * handoff "bypass CC alignment").
 *
 * W3 (bypass-only prompt): a bash write target — redirection target or the
 * argument-slot target of a write command (tee/cp/mv/rm/install/sed -i/
 * touch/mkdir/rmdir) — landing on a CC-sensitive path prompts. Compound
 * commands follow CC's approximation: the check fires only when every other
 * segment is read-only safe (`isSafeCommand`), because a compound command
 * with non-read-only segments is already gated as a whole elsewhere.
 *
 * W4 (all-modes deny): Read/Edit deny rules apply to bash path-taking
 * commands. Read-class commands (cat/head/…, sed without -i) check Read deny
 * rules; write/create-class commands check Edit deny rules. Any hit denies
 * the whole command (CC deniedSubresult parity) — bypass-immune, decide
 * step 1b.
 *
 * Shared extractor rules (CC BashTool pathValidation parity, handoff):
 * - Tokenizer + structural judgment only — NO path-extraction regexes.
 * - Quoted tokens are opaque; tokens with variables ($VAR), globs (* ? [ ]),
 *   or command substitution are skipped — fail-open on uncertainty.
 * - grep/rg/awk/jq/sed: the first non-flag argument is a pattern/script, not
 *   a path. find: only paths before the first flag. `--` ends flag parsing.
 * - ssh / git / cd are deliberately NOT path-checked (CC parity — remote
 *   command strings are not local paths).
 *
 * W5 switch: PI_CORE_BASH_PATH_CHECKS env ("all" | "safety" | "deny" |
 * "off") overrides permission-modes.json `bashPathChecks` (same values,
 * default "all"). safety = W3 only, deny = W4 only. Read per adjudication
 * (mtime-cached config primitive — config edits apply without /reload; env
 * applies to new processes only).
 *
 * Pure string layer — no fs (the symlink double-check lives in
 * path-safety's isCcSafetyPath), no pi imports.
 */
import { splitShellSegments, isSafeCommand } from "./bash-analysis.ts"
import { isCcSafetyPath } from "./path-safety.ts"
import type { PermissionModesConfig } from "./config.ts"
import type { PermissionRule } from "./permissions.ts"
import { pathToolMatchesRuleContent } from "./path-permission-match.ts"

// ---- W5 switch -----------------------------------------------------------

export type BashPathCheckMode = "all" | "safety" | "deny" | "off"

const VALID_MODES: readonly BashPathCheckMode[] = ["all", "safety", "deny", "off"]

function coerceMode(v: string | undefined): BashPathCheckMode | null {
	if (v === undefined || v === "") return null
	const lower = v.toLowerCase()
	return (VALID_MODES as readonly string[]).includes(lower) ? (lower as BashPathCheckMode) : null
}

/**
 * Resolve the W5 switch: env PI_CORE_BASH_PATH_CHECKS wins over the config
 * key `bashPathChecks`; both default to "all". Invalid values fall back to
 * the next source (never throw — a typo must not disable safety silently…
 * it disables the override and keeps the config/default effective).
 */
export function resolveBashPathChecks(config: PermissionModesConfig): BashPathCheckMode {
	return coerceMode(process.env.PI_CORE_BASH_PATH_CHECKS)
		?? coerceMode(config.bashPathChecks)
		?? "all"
}

// ---- shared tokenizer ----------------------------------------------------

export interface BashPathTarget {
	/** Candidate path as written in the command (unresolved). */
	path: string
	/** How the target was identified. */
	kind: "redirect" | "argument"
}

/** True for tokens that carry quote characters (opaque per CC semantics). */
function isQuotedToken(token: string): boolean {
	return token.includes("'") || token.includes('"')
}

/** True for tokens the extractor cannot confidently treat as a literal path. */
function isOpaqueToken(token: string): boolean {
	return (
		isQuotedToken(token) ||
		token.includes("$") ||
		token.includes("*") ||
		token.includes("?") ||
		token.includes("[") ||
		token.includes("]") ||
		token.includes("`")
	)
}

/**
 * Naive quote-aware whitespace tokenizer for one shell segment. Keeps quote
 * characters attached (so callers can treat quoted tokens as opaque) and
 * splits redirection operators into standalone tokens.
 */
function tokenizeSegment(segment: string): string[] {
	const tokens: string[] = []
	let current = ""
	let quote: "'" | '"' | null = null
	const push = () => {
		if (current.length > 0) tokens.push(current)
		current = ""
	}
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!
		if (quote) {
			current += ch
			if (ch === quote) quote = null
			continue
		}
		if (ch === "'" || ch === '"') {
			current += ch
			quote = ch
			continue
		}
		if (/\s/.test(ch)) {
			push()
			continue
		}
		// split `>`, `>>`, `&>`, `2>` style operators into standalone tokens
		if (ch === ">" || (ch === "&" && segment[i + 1] === ">")) {
			push()
			let op = ch
			i++
			while (i < segment.length && segment[i] === ">") {
				op += ">"
				i++
			}
			tokens.push(op)
			i-- // compensate the loop increment
			continue
		}
		current += ch
	}
	push()
	return tokens
}

interface ParsedSegment {
	/** argv[0] basename (env-assignment prefixes stripped). */
	base: string
	/** Plain (non-opaque, non-flag, non-redirect) positional arguments. */
	args: string[]
	/** Positional arguments BEFORE the first flag (find semantics). */
	pathArgs: string[]
	/** Redirection targets (next plain token after a redirect operator). */
	redirects: string[]
}

/** Does the token look like a redirect operator (`>`, `>>`, `&>`, `n>`)? */
function isRedirectOp(token: string): boolean {
	const base = token.replace(/^\d+/, "")
	return base === ">" || base === ">>" || base === "&>" || base === "&>>"
}

function parseSegment(segment: string): ParsedSegment | null {
	const tokens = tokenizeSegment(segment)
	// Skip env-assignment prefixes (FOO=bar cmd …).
	let first = 0
	while (first < tokens.length && /^\w+=/.test(tokens[first]!)) first++
	const argv0 = tokens[first]
	if (argv0 === undefined || isRedirectOp(argv0)) return null
	const args: string[] = []
	const pathArgs: string[] = []
	const redirects: string[] = []
	let sawFlag = false
	let positionalOnly = false // after `--`
	for (let i = first + 1; i < tokens.length; i++) {
		const t = tokens[i]!
		if (!positionalOnly && t === "--") {
			positionalOnly = true
			continue
		}
		if (isRedirectOp(t)) {
			const dst = tokens[i + 1]
			// /dev/null is the universal sink; a leading & is an fd reference.
			if (
				dst !== undefined &&
				dst !== "/dev/null" &&
				!dst.startsWith("&") &&
				!isOpaqueToken(dst)
			) {
				redirects.push(dst)
			}
			i++ // consume the target
			continue
		}
		if (!positionalOnly && t.startsWith("-")) {
			sawFlag = true
			continue // flag (possibly glued value)
		}
		if (isOpaqueToken(t)) {
			sawFlag = true
			continue
		}
		if (!sawFlag && !positionalOnly) pathArgs.push(t)
		args.push(t)
	}
	return { base: argv0.slice(argv0.lastIndexOf("/") + 1), args, pathArgs, redirects }
}

// ---- W3: bypass write-target safety check --------------------------------

/** Write commands whose argument slots are write targets. */
const W3_WRITE_COMMANDS: readonly string[] = [
	"tee",
	"cp",
	"mv",
	"rm",
	"install",
	"touch",
	"mkdir",
	"rmdir",
]

/** All argument slots (tee) or just the destination (cp/mv/install)? */
const DEST_ONLY = new Set(["cp", "mv", "install"])

/**
 * W3: does a bash command write to a CC-sensitive path? Returns the first
 * offending target, or null. Compound-command approximation (CC parity):
 * only fires when every non-hitting segment is read-only safe.
 */
export function checkBashWriteTargets(
	command: string,
	cwd: string,
): BashPathTarget | null {
	if (!command || !command.trim()) return null
	const segments = splitShellSegments(command)
	let hit: BashPathTarget | null = null
	for (const segment of segments) {
		if (hit !== null) {
			// A non-read-only segment after a hit cancels the check (CC
			// approximation: mixed commands are gated as a whole elsewhere).
			if (!isSafeCommand(segment)) return null
			continue
		}
		const target = w3SegmentCheck(segment, cwd)
		if (target !== null) hit = target
		else if (!isSafeCommand(segment)) return null
	}
	return hit
}

/** True when the segment invokes sed with an in-place (-i) flag. */
function sedInPlace(segment: string): boolean {
	return /(^|\s|\/)sed(\s|$)/.test(` ${segment} `) && /(^|\s)-i(\s|$|['"'])/.test(segment)
}

function w3SegmentCheck(segment: string, cwd: string): BashPathTarget | null {
	// Redirection onto a sensitive path (checked before command parsing so
	// `echo x > ~/.bashrc` hits regardless of argv0).
	const rawTokens = tokenizeSegment(segment)
	for (let i = 0; i < rawTokens.length; i++) {
		const t = rawTokens[i]!
		if (!isRedirectOp(t)) continue
		const dst = rawTokens[i + 1]
		if (dst === undefined || dst === "/dev/null" || dst.startsWith("&") || isOpaqueToken(dst)) continue
		if (isCcSafetyPath(dst, cwd)) return { path: dst, kind: "redirect" }
	}
	// `sed -i` inline edit: the LAST plain argument is the file target
	// (macOS `sed -i '' s/a/b/ file` — the '' token is empty and dropped).
	if (sedInPlace(segment)) {
		const parsed = parseSegment(segment)
		if (parsed && parsed.base === "sed" && parsed.args.length > 0) {
			const file = parsed.args[parsed.args.length - 1]!
			if (isCcSafetyPath(file, cwd)) return { path: file, kind: "argument" }
		}
		return null
	}
	const parsed = parseSegment(segment)
	if (!parsed) return null
	if (!W3_WRITE_COMMANDS.includes(parsed.base)) return null
	if (parsed.args.length === 0) return null
	if (DEST_ONLY.has(parsed.base)) {
		const dst = parsed.args[parsed.args.length - 1]!
		if (isCcSafetyPath(dst, cwd)) return { path: dst, kind: "argument" }
	} else {
		for (const a of parsed.args) {
			if (isCcSafetyPath(a, cwd)) return { path: a, kind: "argument" }
		}
	}
	return null
}

// ---- W4: Read/Edit deny rules over bash path commands ---------------------

/** Read-class commands (CC pathValidation set; sed without -i). */
const W4_READ_COMMANDS: readonly string[] = [
	"cat", "head", "tail", "sort", "uniq", "wc", "cut", "paste", "column",
	"tr", "file", "stat", "diff", "awk", "strings", "hexdump", "od",
	"base64", "nl", "grep", "rg", "jq", "sha256sum", "sha1sum", "md5sum",
	"ls", "find", "sed",
]

/** Write/create-class commands — check against Edit deny rules. */
const W4_WRITE_COMMANDS: readonly string[] = [
	"rm", "rmdir", "mv", "cp", "touch", "mkdir",
]

/** First non-flag argument is a pattern/script, not a path. */
const PATTERN_FIRST = new Set(["grep", "rg", "awk", "jq", "sed"])

export interface BashDenyHit {
	/** The path argument that matched. */
	path: string
	/** Formatted rule text, e.g. `Read(./.env)`. */
	rule: string
	source: string
}

function pathArgsFor(parsed: ParsedSegment): string[] {
	if (parsed.base === "find") {
		// find: only paths before the first flag (`find . -name .env` — the
		// -name value is a pattern operand, not a path).
		return parsed.pathArgs
	}
	if (PATTERN_FIRST.has(parsed.base)) return parsed.args.slice(1)
	return parsed.args
}

/**
 * W4: first Read/Edit deny-rule hit reached through a bash path argument or
 * redirection target, or null. Read-class commands check Read rules,
 * write/create-class (and every redirection target) check Edit rules. The
 * deny applies to the whole command — callers must treat any hit as a
 * full-command deny (CC deniedSubresult parity).
 */
export function checkBashDenyHit(
	command: string,
	cwd: string,
	rules: PermissionRule[],
): BashDenyHit | null {
	if (!command || !command.trim()) return null
	if (!rules.some((r) => r.behavior === "deny")) return null
	for (const segment of splitShellSegments(command)) {
		const parsed = parseSegment(segment)
		if (parsed) {
			const inPlaceSed = parsed.base === "sed" && sedInPlace(segment)
			if (W4_READ_COMMANDS.includes(parsed.base) && !inPlaceSed) {
				const hit = matchRules(
					pathArgsFor(parsed),
					"Read",
					rules,
					cwd,
				)
				if (hit) return hit
			} else if (W4_WRITE_COMMANDS.includes(parsed.base) || inPlaceSed) {
				const hit = matchRules(parsed.args, "Edit", rules, cwd)
				if (hit) return hit
			}
		}
		// Redirection targets are Edit-semantic regardless of argv0.
		const rawTokens = tokenizeSegment(segment)
		for (let i = 0; i < rawTokens.length; i++) {
			if (!isRedirectOp(rawTokens[i]!)) continue
			const dst = rawTokens[i + 1]
			if (dst === undefined || dst === "/dev/null" || dst.startsWith("&") || isOpaqueToken(dst)) continue
			const hit = matchRules([dst], "Edit", rules, cwd)
			if (hit) return hit
		}
	}
	return null
}

function matchRules(
	paths: string[],
	ccTool: "Read" | "Edit",
	rules: PermissionRule[],
	cwd: string,
): BashDenyHit | null {
	for (const rule of rules) {
		if (rule.behavior !== "deny") continue
		if (rule.ruleValue.toolName !== ccTool) continue
		for (const p of paths) {
			if (pathToolMatchesRuleContent(ccTool, p, rule.ruleValue.ruleContent, cwd)) {
				return {
					path: p,
					rule: `${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent ?? ""})`,
					source: rule.source,
				}
			}
		}
	}
	return null
}
