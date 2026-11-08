/**
 * modes/bash-path-check.ts — bash path-target checks (W3/W4/W5, 2026-11-07
 * handoff "bypass CC alignment"; review fixes 2026-11-08: P0-2/3 quoted
 * literals, P1-2 mv/cp all args, P1-3 full sed extractor, P1-4 protected
 * pi-own paths).
 *
 * W3 (bypass-only prompt): a bash write target — redirection target or the
 * argument-slot target of a write command (tee/cp/mv/rm/touch/mkdir/rmdir/
 * sed -i) — landing on a CC-sensitive path prompts. Compound commands follow
 * CC's approximation: the check fires only when every other segment is
 * read-only safe (`isSafeCommand`).
 *
 * W4 (all-modes deny): Read/Edit deny rules apply to bash path-taking
 * commands. Read-class commands (cat/head/…, sed without -i) check Read deny
 * rules; write/create-class commands check Edit deny rules. Any hit denies
 * the whole command (CC deniedSubresult parity) — bypass-immune, decide
 * step 1b.
 *
 * W3.5 (all-modes prompt, 2026-11-08 P1-4): a bash write target landing on
 * a pi-own protected path (permission-modes.json, rules dirs, settings.json
 * — the [C4] set via memory/protected-paths.ts) prompts in every mode
 * (bypass included; placed after plan hard limits in decide). A deliberate
 * pi superset over CC (which only covers these via the .claude dir segment).
 *
 * Shared extractor rules (CC BashTool pathValidation parity):
 * - Tokenizer + structural judgment only — NO path-extraction regexes.
 * - A token that is ENTIRELY one single/double-quoted literal with no $, `
 *   or backslash inside is unquoted and participates (P0-2/3, CC
 *   validatePath strip-parity); anything else carrying quotes/variables/
 *   globs/command substitution is opaque — fail-open on uncertainty.
 * - grep/rg/awk/jq: the first non-flag argument is a pattern, not a path.
 *   find: only paths before the first flag. `--` ends flag parsing.
 * - sed: CC PATH_EXTRACTORS.sed parity — `-f/--file` operand is a script
 *   FILE (validated), `-e/--expression` operand is skipped, combined short
 *   flags containing e/f mark the script found, the first non-flag is the
 *   script, the rest are files. In-place forms: -i, -iSUFFIX,
 *   --in-place[=SUFFIX], combined short flags containing i.
 * - ssh / git / cd are deliberately NOT path-checked (remote strings are
 *   not local paths).
 *
 * W5 switch: PI_CORE_BASH_PATH_CHECKS env ("all" | "safety" | "deny" |
 * "off") overrides permission-modes.json `bashPathChecks` (same values,
 * default "all"). safety = W3 + allow-rule hardening (P0-1, lives in
 * bash-permission-match.ts) + protected-path prompt (P1-4); deny = W4 only.
 * Read per adjudication (mtime-cached config primitive — config edits apply
 * without /reload; env applies to new processes only).
 *
 * Pure string layer — no fs beyond protected-paths' matcher (lexical), no
 * pi imports.
 */
import { splitShellSegments, isSafeCommand } from "./bash-analysis.ts"
import { isCcSafetyPath, expandUserPath } from "./path-safety.ts"
import type { PermissionModesConfig } from "./config.ts"
import type { PermissionRule } from "./permissions.ts"
import { pathToolMatchesRuleContent } from "./path-permission-match.ts"
import { matchProtectedPath } from "../memory/protected-paths.ts"
import { homedir } from "node:os"
import path from "node:path"

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
 * the next source (never throw — a typo disables the override only).
 */
export function resolveBashPathChecks(config: PermissionModesConfig): BashPathCheckMode {
	return coerceMode(process.env.PI_CORE_BASH_PATH_CHECKS)
		?? coerceMode(config.bashPathChecks)
		?? "all"
}

// ---- shared tokenizer ----------------------------------------------------

export interface BashPathTarget {
	/** Candidate path as written in the command (post-unquote). */
	path: string
	/** How the target was identified. */
	kind: "redirect" | "argument"
}

/**
 * P0-2/3 (2026-11-08): unquote a token that is ENTIRELY one single- or
 * double-quoted literal. The inside must be free of $, backtick and
 * backslash (no expansion/escaping tricks) — otherwise null (caller treats
 * the token as opaque). Mirrors CC validatePath's leading/trailing quote
 * strip, restricted to the provably-literal case.
 */
function unquoteLiteral(token: string): string | null {
	if (token.length < 2) return null
	const first = token[0]!
	const last = token[token.length - 1]!
	if (!((first === "'" && last === "'") || (first === '"' && last === '"'))) return null
	const inner = token.slice(1, -1)
	if (inner.length === 0) return null
	if (inner.includes("$") || inner.includes("`") || inner.includes("\\")) return null
	// a quote character inside means it was not one whole literal
	if (inner.includes("'") || inner.includes('"')) return null
	return inner
}

/**
 * Resolve a token to a literal path candidate: unquoted literals are
 * unquoted, plain tokens pass through, anything uncertain is null (opaque).
 */
function resolveToken(token: string): string | null {
	if (token === "") return null
	if (token.includes("'") || token.includes('"')) return unquoteLiteral(token)
	// Variables, command substitution, globs and character classes are
	// uncertain — fail-open (the old isOpaqueToken set).
	if (/[`$*?\[\]]/.test(token)) return null
	return token
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
	/** Positional args (unquoted when literal, flags excluded, opaque skipped). */
	args: string[]
	/**
	 * All operand tokens after argv0 in order, flags INCLUDED (unquoted when
	 * literal; opaque kept verbatim so sed's combined-flag logic can still
	 * see them). For sed-style extractors only.
	 */
	operands: string[]
	/** Redirection targets (unquoted when literal). */
	redirects: string[]
	/**
	 * Index in `operands` where the post-`--` positional region starts
	 * (-1 when no `--` appeared). `--` itself is NOT an operand entry.
	 * Review fix 2026-11-08 P2#4/#5: flag parsing must stop here.
	 */
	postDashStart: number
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
	const operands: string[] = []
	const redirects: string[] = []
	let postDashStart = -1
	for (let i = first + 1; i < tokens.length; i++) {
		const t = tokens[i]!
		if (postDashStart === -1 && t === "--") {
			postDashStart = operands.length
			continue
		}
		if (isRedirectOp(t)) {
			const dst = tokens[i + 1]
			// /dev/null is the universal sink; a leading & is an fd reference.
			if (dst !== undefined && dst !== "/dev/null" && !dst.startsWith("&")) {
				const resolved = resolveToken(dst)
				if (resolved !== null) redirects.push(resolved)
			}
			i++ // consume the target
			continue
		}
		if (postDashStart === -1 && t.startsWith("-")) {
			const resolved = resolveToken(t)
			operands.push(resolved ?? t)
			continue
		}
		const resolved = resolveToken(t)
		operands.push(resolved ?? t)
		if (resolved !== null) args.push(resolved)
	}
	return {
		base: argv0.slice(argv0.lastIndexOf("/") + 1),
		args,
		operands,
		redirects,
		postDashStart,
	}
}

// Single tokenizer authority — exported for bash-permission-match.ts's
// P0-1 redirect check (review fix 2026-11-08 P1#1).
export { tokenizeSegment }

// ---- sed analysis (P1-3, CC PATH_EXTRACTORS.sed parity) -------------------

interface SedAnalysis {
	/** In-place edit (-i family)? */
	inPlace: boolean
	/** File path candidates (script operand + trailing files). */
	paths: string[]
}

const SED_LONG_FILE = new Set(["-f", "--file"])
const SED_LONG_EXPR = new Set(["-e", "--expression"])

/** Analyze sed operands per CC's extractor: flags, script position, files. */
function analyzeSed(operands: string[], postDashStart: number): SedAnalysis {
	const paths: string[] = []
	let scriptFound = false
	let inPlace = false
	for (let i = 0; i < operands.length; i++) {
		const arg = operands[i]!
		// After `--` everything is positional — no flag parsing (review fix
		// 2026-11-08 P2#4: `sed -- -i s/x/y/ f` has -i as the SCRIPT, not an
		// in-place flag; CC's extractor tracks `--` the same way).
		const isFlag = postDashStart === -1 || i < postDashStart
		if (isFlag && arg.startsWith("-") && arg !== "-") {
			// -f/--file: the next operand is a script FILE (validated too).
			if (SED_LONG_FILE.has(arg)) {
				const scriptFile = operands[i + 1]
				if (scriptFile !== undefined && resolveToken(scriptFile) !== null) {
					paths.push(resolveToken(scriptFile)!)
					i++
				}
				scriptFound = true
				continue
			}
			// -e/--expression: the next operand is an expression, not a file.
			if (SED_LONG_EXPR.has(arg)) {
				i++
				scriptFound = true
				continue
			}
			if (arg === "--in-place" || arg.startsWith("--in-place=")) {
				inPlace = true
				scriptFound = true // GNU docs: implies the script is next non-flag
				continue
			}
			// Combined/short flags: -i[SUFFIX] or any short group containing
			// i marks in-place; a group containing e or f marks script-found.
			if (arg.startsWith("--")) continue // unknown long flag — skip
			const letters = arg.replace(/^-+/, "")
			if (letters.includes("i")) inPlace = true
			if (letters.includes("e") || letters.includes("f")) scriptFound = true
			continue
		}
		// First non-flag operand is the script (unless -e/-f found it).
		if (!scriptFound) {
			scriptFound = true
			continue
		}
		const resolved = resolveToken(arg)
		if (resolved !== null) paths.push(resolved)
	}
	return { inPlace, paths }
}

/** True when the segment invokes sed with an in-place (-i family) flag. */
function sedInPlace(segment: string): boolean {
	const parsed = parseSegment(segment)
	if (!parsed || parsed.base !== "sed") return false
	return analyzeSed(parsed.operands, parsed.postDashStart).inPlace
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

/**
 * W3: does a bash command write to a CC-sensitive path? Returns the first
 * offending target, or null. P1-2: mv/cp check ALL positional args (CC
 * COMMAND_OPERATION_TYPE treats them as write over every operand); install
 * stays destination-only (not in CC's set — DEVIATIONS). Compound-command
 * approximation (CC parity): only fires when every non-hitting segment is
 * read-only safe.
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

function w3SegmentCheck(segment: string, cwd: string): BashPathTarget | null {
	// Redirection onto a sensitive path (checked before command parsing so
	// `echo x > ~/.bashrc` hits regardless of argv0). Quoted literal targets
	// are unquoted first (P0-2/3).
	const rawTokens = tokenizeSegment(segment)
	for (let i = 0; i < rawTokens.length; i++) {
		const t = rawTokens[i]!
		if (!isRedirectOp(t)) continue
		const dst = rawTokens[i + 1]
		if (dst === undefined || dst === "/dev/null" || dst.startsWith("&")) continue
		const resolved = resolveToken(dst)
		if (resolved === null) continue
		if (isCcSafetyPath(resolved, cwd)) return { path: resolved, kind: "redirect" }
	}
	const parsed = parseSegment(segment)
	if (!parsed) return null
	// `sed -i` family: every file operand + the -f script file (P1-3).
	if (parsed.base === "sed") {
		const { inPlace, paths } = analyzeSed(parsed.operands, parsed.postDashStart)
		if (!inPlace) return null
		for (const p of paths) {
			if (isCcSafetyPath(p, cwd)) return { path: p, kind: "argument" }
		}
		return null
	}
	if (!W3_WRITE_COMMANDS.includes(parsed.base)) return null
	if (parsed.args.length === 0) return null
	// P1#2 (2026-11-08): mv/cp/install with any pre-`--` flag hit as a
	// target — GNU -t/--target-directory moves the destination out of the
	// positional slots (CC COMMAND_VALIDATOR parity).
	const flagHit = moveCommandFlagTarget(parsed)
	if (flagHit !== null) return { path: flagHit, kind: "argument" }
	if (parsed.base === "install") {
		// not in CC's COMMAND_OPERATION_TYPE — keep destination-only (DEVIATIONS)
		const dst = parsed.args[parsed.args.length - 1]!
		if (isCcSafetyPath(dst, cwd)) return { path: dst, kind: "argument" }
		return null
	}
	for (const a of parsed.args) {
		if (isCcSafetyPath(a, cwd)) return { path: a, kind: "argument" }
	}
	return null
}

// ---- W3.5: pi-own protected paths (P1-4, all-modes prompt) ----------------

export interface BashProtectedWrite {
	/** The write target as written (post-unquote). */
	target: string
	/** The protected boundary kind that matched ([C4] set). */
	kind: string
}

function resolveAbs(p: string, cwd: string): string {
	const expanded = expandUserPath(p)
	return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded)
}

/**
 * P1-4 (2026-11-08): does a bash command WRITE to a pi-own protected path
 * (permission-modes.json, rules dirs, settings.json — the [C4] set)? Uses
 * the same write-target set as W3 (redirections + write-command args,
 * sed -i files). Read-style references do not trigger; a read-only `cp`
 * backup of a protected file DOES (accepted: the check is heuristic, the
 * outcome is a prompt the user can approve, not a hard block).
 */
export function checkBashProtectedWrite(
	command: string,
	cwd: string,
): BashProtectedWrite | null {
	if (!command || !command.trim()) return null
	const home = homedir()
	for (const segment of splitShellSegments(command)) {
		// redirection targets always count as writes
		const rawTokens = tokenizeSegment(segment)
		for (let i = 0; i < rawTokens.length; i++) {
			if (!isRedirectOp(rawTokens[i]!)) continue
			const dst = rawTokens[i + 1]
			if (dst === undefined || dst === "/dev/null" || dst.startsWith("&")) continue
			const resolved = resolveToken(dst)
			if (resolved === null) continue
			const match = matchProtectedPath(resolveAbs(resolved, cwd), { home, cwd })
			if (match) return { target: resolved, kind: match.kind }
		}
		const parsed = parseSegment(segment)
		if (!parsed) continue
		let candidates: string[] | null = null
		if (parsed.base === "sed") {
			const { inPlace, paths } = analyzeSed(parsed.operands, parsed.postDashStart)
			if (inPlace) candidates = paths
		} else if (W3_WRITE_COMMANDS.includes(parsed.base)) {
			candidates = parsed.base === "install"
				? parsed.args.slice(-1)
				: parsed.args
		}
		if (!candidates) continue
		for (const p of candidates) {
			const match = matchProtectedPath(resolveAbs(p, cwd), { home, cwd })
			if (match) return { target: p, kind: match.kind }
		}
		// P1#2 (2026-11-08): a flagged mv/cp/install cannot be path-validated —
		// prompt (the flag form may hide the real destination).
		const flagHit = moveCommandFlagTarget(parsed)
		if (flagHit !== null) return { target: flagHit, kind: "mv-cp-flag-form" }
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
const PATTERN_FIRST = new Set(["grep", "rg", "awk", "jq"])

export interface BashDenyHit {
	/** The path argument that matched. */
	path: string
	/** Formatted rule text, e.g. `Read(./.env)`. */
	rule: string
	source: string
}

function pathArgsFor(parsed: ParsedSegment): string[] {
	if (parsed.base === "find") {
		// only paths before the first flag — operands keep flags, so cut at
		// the first flag-looking operand; post-`--` operands are ALL paths
		// (review fix 2026-11-08 P2#5, CC superset semantics: `find -- -x …`
		// must not fall out of validation entirely)
		const out: string[] = []
		for (let i = 0; i < parsed.operands.length; i++) {
			const op = parsed.operands[i]!
			const postDash = parsed.postDashStart !== -1 && i >= parsed.postDashStart
			if (!postDash && op.startsWith("-") && op !== "-") break
			if (/[`$*?\[\]"']/.test(op)) continue
			out.push(op)
		}
		return out
	}
	if (PATTERN_FIRST.has(parsed.base)) return parsed.args.slice(1)
	return parsed.args
}

/**
 * Review fix 2026-11-08 P1#2 (CC COMMAND_VALIDATOR parity): mv/cp reject
 * ANY `-`-prefixed argument before `--` — GNU `--target-directory=PATH` /
 * `-t PATH` can move the destination out of the positional slots and
 * bypass path extraction. install is deliberately EXCLUDED: `-m 644` is
 * its most common legitimate form (install stays destination-only,
 * DEVIATIONS #134). When such a flag is present the command is treated as
 * a hit (prompt) with the flag text as the label path.
 */
const FLAG_SENSITIVE_MOVE_COMMANDS = new Set(["mv", "cp"])

function moveCommandFlagTarget(parsed: ParsedSegment): string | null {
	if (!FLAG_SENSITIVE_MOVE_COMMANDS.has(parsed.base)) return null
	const limit = parsed.postDashStart === -1 ? parsed.operands.length : parsed.postDashStart
	for (let i = 0; i < limit; i++) {
		const op = parsed.operands[i]!
		if (op.startsWith("-") && op !== "-") return op
	}
	return null
}

/**
 * W4: first Read/Edit deny-rule hit reached through a bash path argument or
 * redirection target, or null. Read-class commands check Read rules,
 * write/create-class (and every redirection target) check Edit rules;
 * sed applies its CC extractor (files + -f script; -i routes to Edit). The
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
			// P1#2 (2026-11-08): a flagged mv/cp/install cannot be path-validated —
			// CC's COMMAND_VALIDATOR rejects the form outright; deny so a
			// hidden destination cannot slip past Edit rules.
			const flagHit = moveCommandFlagTarget(parsed)
			if (flagHit !== null) {
				return {
					path: flagHit,
					rule: "mv/cp/install flag form (CC COMMAND_VALIDATOR)",
					source: "validator",
				}
			}
			if (parsed.base === "sed") {
				const { inPlace, paths } = analyzeSed(parsed.operands, parsed.postDashStart)
				const hit = matchRules(paths, inPlace ? "Edit" : "Read", rules, cwd)
				if (hit) return hit
			} else if (W4_READ_COMMANDS.includes(parsed.base)) {
				const hit = matchRules(pathArgsFor(parsed), "Read", rules, cwd)
				if (hit) return hit
			} else if (W4_WRITE_COMMANDS.includes(parsed.base)) {
				const hit = matchRules(parsed.args, "Edit", rules, cwd)
				if (hit) return hit
			}
		}
		// Redirection targets are Edit-semantic regardless of argv0.
		const rawTokens = tokenizeSegment(segment)
		for (let i = 0; i < rawTokens.length; i++) {
			if (!isRedirectOp(rawTokens[i]!)) continue
			const dst = rawTokens[i + 1]
			if (dst === undefined || dst === "/dev/null" || dst.startsWith("&")) continue
			const resolved = resolveToken(dst)
			if (resolved === null) continue
			const hit = matchRules([resolved], "Edit", rules, cwd)
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
