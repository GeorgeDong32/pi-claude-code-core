/**
 * modes/bash-path-check.ts — bash path-target checks (W3/W4/W5, 2026-11-07
 * handoff "bypass CC alignment"; review fixes 2026-11-08: P0-2/3 quoted
 * literals, P1-2 mv/cp all args, P1-3 full sed extractor, P1-4 protected
 * pi-own paths; BH-R3 2026-11-14: mv/cp flag-aware arg slots + remote
 * heredoc masking).
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
 * step 1b. BH-R3: segments feeding a REMOTE shell through a heredoc
 * (`ssh host <<'EOF' … EOF`) are masked before scanning — the body runs on
 * the remote host and is not a local path context (delimiters parsed from
 * the raw line, so quoted `<<'EOF'` works; `<<<` here-strings are NOT
 * masked; an unclosed heredoc keeps its body conservatively).
 *
 * BH-R3 mv/cp argument analysis (fixes the flag-blind slots of P1-2, where
 * `cp -R src dst` read "-R" as a path): harmless short flags (r/R/f/i/n/v/
 * a/p/u/b/T/l/H/L/P/d/Z/x, long forms, valued -S/--suffix) are stripped;
 * `-t DIR` / `--target-directory[=DIR]` consume a value and the DIRECTORY
 * itself joins the checked targets; an unrecognized flag is not silently
 * treated as a path — W3/W4 escalate it as an "mv/cp flag-form" prompt
 * (BashFlagEscalation → adjudicate step 3.6, deny still outranks) so
 * flag-heavy invocations fail closed to the user instead of open.
 *
 * W3.5 (all-modes prompt, 2026-11-08 P1-4): a bash write target landing on
 * a pi-own protected path (permission-modes.json, rules dirs, settings.json
 * — the [C4] set via memory/protected-paths.ts) prompts in every mode
 * (bypass included; placed after plan hard limits in decide). A deliberate
 * pi superset over CC (which only covers these via the .claude dir segment).
 * BH-R3: the protected candidate wins over the unrecognized-flag prompt.
 *
 * E1 (D-CH-4, 2026-11-15-cleanup-hardening): literal cd tracking along
 * `&&` chains — a literal `cd <dir>` followed by `&&` shifts the effective
 * directory for every subsequent segment, so relative paths resolve
 * against the cd'ed directory in ALL path checks (W3/W4/P1-4/flag
 * escalation). Non-literal cds (`$`, backtick, `~`, `-`, bare) and cds
 * followed by `;` / `||` / a pipe are NOT tracked — their segments analyze
 * as-is and resolution stays at the base cwd (known residual, DEVIATIONS).
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
import { splitShellChain, isSafeCommand } from "./bash-analysis.ts"
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
	/** How the target was identified ("mv-cp-flag-form": BH-R3 unrecognized flag). */
	kind: "redirect" | "argument" | "mv-cp-flag-form"
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

// ---- E1: literal cd tracking along && chains (D-CH-4) ---------------------

interface ChainNode {
	segment: string
	/** Effective directory for this segment (post-cd resolution). */
	dir: string
	/** True when this segment is a tracked literal cd (followed by `&&`). */
	isCd: boolean
}

/**
 * E1 (D-CH-4): literal `cd <dir>` detection for path tracking — bare path
 * token only (same charset rule as bash-analysis's safety-side detector;
 * quoted/expanded/globbed/option targets and redirect-carrying segments
 * are not tracked). Tracked only when the segment's connector is `&&`.
 */
function literalCdTarget(segment: string): string | null {
	const parsed = parseSegment(segment)
	if (!parsed || parsed.base !== "cd") return null
	if (parsed.redirects.length > 0) return null
	if (parsed.args.length !== 1) return null
	const target = parsed.args[0]!
	if (target.startsWith("-")) return null
	if (/[$`~*?[\]'"\\;&|<>()]/.test(target)) return null
	return target
}

/**
 * E1 (D-CH-4): walk the `&&` chain and resolve each segment's effective
 * directory. A literal `cd <dir>` followed by `&&` updates the directory
 * for every subsequent segment, so relative paths resolve against the
 * cd'ed directory for ALL path checks (W3 segment check, W4 deny, P1-4
 * protected write, flag escalation) — mirroring what the shell would
 * actually touch. A non-literal cd (`$`, backtick, `~`, `-`, bare) or a cd
 * followed by `;` / `||` / pipe is NOT tracked: its segment is analyzed
 * as-is and resolution stays at the base cwd (known residual — shell
 * semantics would persist the cd there too; recorded in DEVIATIONS).
 */
function walkCdChain(command: string, cwd: string): ChainNode[] {
	let dir = cwd
	return splitShellChain(command).map((node) => {
		const target = node.connector === "&&" ? literalCdTarget(node.segment) : null
		if (target !== null) {
			const nodeDir = dir
			dir = path.resolve(dir, target)
			return { segment: node.segment, dir: nodeDir, isCd: true }
		}
		return { segment: node.segment, dir, isCd: false }
	})
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
	const chain = walkCdChain(command, cwd)
	let hit: BashPathTarget | null = null
	for (const node of chain) {
		if (hit !== null) {
			// A non-read-only segment after a hit cancels the check (CC
			// approximation: mixed commands are gated as a whole elsewhere).
			// A tracked literal cd is read-only safe (E1).
			if (!node.isCd && !isSafeCommand(node.segment)) return null
			continue
		}
		if (node.isCd) continue
		const target = w3SegmentCheck(node.segment, node.dir)
		if (target !== null) hit = target
		else if (!isSafeCommand(node.segment)) return null
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
	// BH-R3: mv/cp get the dedicated flag analysis — recognized harmless
	// flags are stripped and the bare positional form is checked; an
	// unrecognized flag keeps prompting (cannot path-validate). -t /
	// --target-directory destinations are checked as the write target.
	if (parsed.base === "mv" || parsed.base === "cp") {
		const analysis = analyzeMoveCp(parsed)
		for (const p of checkedPaths(analysis)) {
			if (isCcSafetyPath(p, cwd)) return { path: p, kind: "argument" }
		}
		if (analysis.unrecognizedFlag !== null) {
			return { path: analysis.unrecognizedFlag, kind: "mv-cp-flag-form" }
		}
		return null
	}
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
	for (const node of walkCdChain(command, cwd)) {
		if (node.isCd) continue
		const cwdFor = node.dir
		// redirection targets always count as writes
		const rawTokens = tokenizeSegment(node.segment)
		for (let i = 0; i < rawTokens.length; i++) {
			if (!isRedirectOp(rawTokens[i]!)) continue
			const dst = rawTokens[i + 1]
			if (dst === undefined || dst === "/dev/null" || dst.startsWith("&")) continue
			const resolved = resolveToken(dst)
			if (resolved === null) continue
			const match = matchProtectedPath(resolveAbs(resolved, cwdFor), { home, cwd: cwdFor })
			if (match) return { target: resolved, kind: match.kind }
		}
		const parsed = parseSegment(node.segment)
		if (!parsed) continue
		let candidates: string[] | null = null
		let moveCpUnrecognized: string | null = null
		if (parsed.base === "sed") {
			const { inPlace, paths } = analyzeSed(parsed.operands, parsed.postDashStart)
			if (inPlace) candidates = paths
		} else if (parsed.base === "mv" || parsed.base === "cp") {
			// BH-R3: bare-form analysis; a protected-path candidate wins over
			// the unrecognized-flag prompt (specific beats generic)
			const analysis = analyzeMoveCp(parsed)
			candidates = checkedPaths(analysis)
			moveCpUnrecognized = analysis.unrecognizedFlag
		} else if (W3_WRITE_COMMANDS.includes(parsed.base)) {
			candidates = parsed.base === "install"
				? parsed.args.slice(-1)
				: parsed.args
		}
		if (!candidates) continue
		for (const p of candidates) {
			const match = matchProtectedPath(resolveAbs(p, cwdFor), { home, cwd: cwdFor })
			if (match) return { target: p, kind: match.kind }
		}
		// BH-R3: an unrecognized mv/cp flag cannot be path-validated — prompt
		// (the flag form may hide the real destination).
		if (moveCpUnrecognized !== null) {
			return { target: moveCpUnrecognized, kind: "mv-cp-flag-form" }
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
const PATTERN_FIRST = new Set(["grep", "rg", "awk", "jq"])

export interface BashDenyHit {
	/** The path argument that matched. */
	path: string
	/** Formatted rule text, e.g. `Read(./.env)`. */
	rule: string
	source: string
}

/**
 * S3 (spec 2026-11-15-cleanup-hardening): the unrecognized mv/cp flag
 * escalation is its OWN shape — it is not a rule hit and carries no path
 * (the whole point is that the targets cannot be path-validated). The old
 * `BashDenyHit` reuse put the flag text in the `path` slot; consumers now
 * read `flag` directly.
 */
export interface BashFlagEscalation {
	/** The unrecognized mv/cp flag as written (e.g. `-z`). */
	flag: string
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
 * BH-R3 (spec 2026-11-14-backtest-hardening): only `-t DIR` and
 * `--target-directory[=DIR]` alter where mv/cp writes its destination —
 * every other recognized flag is stripped and the BARE positional form is
 * analyzed (all operands stay rule-checked, so nothing can hide). An
 * UNRECOGNIZED flag escalates to ASK (the BashFlagEscalation channel) instead of
 * the former outright deny (82d35c2 treated any flag as a hidden
 * destination). install stays destination-only (DEVIATIONS #134).
 * Over-classifying a non-destination flag as harmless is safe by
 * construction: its operands still land in `paths` and are checked.
 */
const FLAG_SENSITIVE_MOVE_COMMANDS = new Set(["mv", "cp"])

/** mv/cp short-flag characters that carry no path value (boolean forms). */
const MOVE_CP_HARMLESS_SHORT = new Set([
	"r", "R", // --recursive
	"f", // --force
	"i", // --interactive
	"n", // --no-clobber
	"v", // --verbose
	"a", // --archive (cp)
	"p", // --preserve (cp)
	"u", // --update
	"b", // --backup (value optional; appended/glued forms harmless)
	"T", // --no-target-directory — destination stays positional
	"l", // --link (cp)
	"H", "L", "P", "d", // dereference modes (cp)
	"Z", // SELinux context
	"x", // --exchange (mv)
])

/** mv/cp long flags without a path value; `=VALUE` forms consumed inline. */
const MOVE_CP_HARMLESS_LONG = new Set([
	"recursive", "force", "interactive", "no-clobber", "verbose", "archive",
	"preserve", "no-preserve", "backup", "strip-trailing-slashes", "debug",
	"no-target-directory", "link", "dereference-recursive", "attributes-only",
	"copy-contents", "no-copy", "exchange", "discard-destination",
	"update", "context",
])

/** mv/cp long flags whose (non-path) value may follow as a separate operand. */
const MOVE_CP_VALUED_LONG = new Set(["suffix"])

/** -S takes a suffix value (short form of --suffix). */
const MOVE_CP_VALUED_SHORT = new Set(["S"])

export interface MoveCpAnalysis {
	/** Destination directory from -t DIR / --target-directory[=DIR]. */
	targetDir: string | null
	/** Positional operands (sources; the destination when no -t form). */
	paths: string[]
	/** First unrecognized flag operand — ask escalation (BH-R3). */
	unrecognizedFlag: string | null
}

/**
 * S1 (spec 2026-11-15-cleanup-hardening): the mv/cp rule-check candidate
 * list — the `-t` destination directory (when present) joined ahead of the
 * positional operands. One expression, shared by the three consumers
 * (W3 write-target, P1-4 protected write, W4 deny scan) instead of the
 * previously triplicated ternary.
 */
function checkedPaths(analysis: MoveCpAnalysis): string[] {
	return analysis.targetDir !== null
		? [analysis.targetDir, ...analysis.paths]
		: analysis.paths
}

function analyzeMoveCp(parsed: ParsedSegment): MoveCpAnalysis {
	let targetDir: string | null = null
	let unrecognizedFlag: string | null = null
	const paths: string[] = []
	const limit = parsed.postDashStart === -1 ? parsed.operands.length : parsed.postDashStart
	for (let i = 0; i < parsed.operands.length; i++) {
		const op = parsed.operands[i]!
		const postDash = parsed.postDashStart !== -1 && i >= limit
		if (!postDash && op.startsWith("-") && op !== "-") {
			if (op.startsWith("--")) {
				const eq = op.indexOf("=")
				const name = eq === -1 ? op.slice(2) : op.slice(2, eq)
				if (name === "target-directory") {
					const value = eq === -1 ? parsed.operands[i + 1] ?? null : op.slice(eq + 1)
					if (value === null) unrecognizedFlag ??= op
					else targetDir = value
					if (eq === -1 && value !== null) i++ // value consumed
				} else if (MOVE_CP_VALUED_LONG.has(name)) {
					if (eq === -1 && parsed.operands[i + 1] !== undefined) i++ // value consumed
				} else if (!MOVE_CP_HARMLESS_LONG.has(name)) {
					unrecognizedFlag ??= op
				}
				continue
			}
			// short cluster: -t consumes the rest of the cluster (or the next
			// operand) as the destination; -S consumes a suffix value
			const chars = op.slice(1)
			for (let c = 0; c < chars.length; c++) {
				const ch = chars[c]!
				if (ch === "t") {
					const rest = chars.slice(c + 1)
					if (rest) {
						targetDir = rest
					} else {
						const next = parsed.operands[i + 1] ?? null
						if (next === null) unrecognizedFlag ??= op
						else { targetDir = next; i++ }
					}
					break
				}
				if (MOVE_CP_VALUED_SHORT.has(ch)) {
					if (chars.slice(c + 1) === "") i++ // value in the next operand
					break
				}
				if (!MOVE_CP_HARMLESS_SHORT.has(ch)) {
					unrecognizedFlag ??= op
					break
				}
			}
			continue
		}
		paths.push(op)
	}
	// an opaque (-t) destination cannot be validated — escalate like an
	// unrecognized flag
	if (targetDir !== null && /[$`'"]/.test(targetDir)) {
		unrecognizedFlag ??= targetDir
		targetDir = null
	}
	return { targetDir, paths, unrecognizedFlag }
}

// ---- BH-R3: remote heredoc bodies -----------------------------------------

interface HeredocOpener {
	delimiter: string
	isDash: boolean
	/** The opener line with quoted spans masked to spaces (classification input). */
	prefixMaskedSource: string
	/** Index of the `<<` operator within the masked line. */
	opIndex: number
}

/** Length-preserving quote mask: quoted spans (quote chars included) become spaces. */
function maskQuotedSpans(line: string): string {
	const out = line.split("")
	let quote: "'" | '"' | null = null
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!
		if (quote) {
			out[i] = " "
			if (ch === quote) quote = null
			continue
		}
		if (ch === "'" || ch === '"') {
			quote = ch
			out[i] = " "
		}
	}
	return out.join("")
}

/**
 * Best-effort heredoc opener on one line: `<<[-]DELIM`, `<<[-]'DELIM'`,
 * `<<[-]"DELIM"`. The operator must sit OUTSIDE quotes (quoted spans are
 * masked length-preservingly, so a `<<` inside quotes cannot fake an
 * opener and indices still map to the raw line), and `<<<` (here-string)
 * never matches.
 */
function findHeredocOpener(line: string): HeredocOpener | null {
	if (!line.includes("<<")) return null
	const masked = maskQuotedSpans(line)
	for (let i = 0; i < masked.length; i++) {
		if (masked[i] !== "<" || masked[i + 1] !== "<") continue
		if (masked[i - 1] === "<" || masked[i + 2] === "<") continue
		// parse the delimiter from the RAW line — the operator/dash/space run
		// is unquoted, and a quoted delimiter (`<<'EOF'`) lives only in raw
		let j = i + 2
		let isDash = false
		if (line[j] === "-") {
			isDash = true
			j++
		}
		while (line[j] === " " || line[j] === "\t") j++
		let delimiter: string | null = null
		const q = line[j]
		if (q === "'" || q === '"') {
			const end = line.indexOf(q, j + 1)
			if (end !== -1) delimiter = line.slice(j + 1, end)
		} else {
			const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(j))
			if (m) delimiter = m[0]
		}
		if (delimiter !== null && delimiter.length > 0) {
			return { delimiter, isDash, prefixMaskedSource: masked, opIndex: i }
		}
	}
	return null
}

/** Is the heredoc fed to a remote-bound command (ssh …)? Best-effort. */
function remoteBoundHeredoc(prefix: string): boolean {
	// the heredoc stdin attaches to the FINAL command on its line
	const pieces = prefix.split(/&&|\|\||[|;]/)
	const last = (pieces[pieces.length - 1] ?? "").trim()
	const tokens = last.split(/[ \t]+/).filter(Boolean)
	while (tokens.length > 0 && /^\w+=/.test(tokens[0]!)) tokens.shift()
	const cmd = tokens[0]
	if (!cmd) return false
	return cmd.slice(cmd.lastIndexOf("/") + 1) === "ssh"
}

/**
 * BH-R3: a heredoc body piped to `ssh host …` executes on the REMOTE host —
 * parsing its lines as local commands produced false deny hits (the body
 * lines are plain command text to the local tokenizer). This strips
 * REMOTE-bound heredoc bodies from the analyzed text; local consumers
 * (`bash -s` / `sh -s` and everything else) keep their bodies, and an
 * unclosable heredoc keeps its body too (fail-open to the old behavior).
 */
function stripRemoteHeredocBodies(command: string): string {
	if (!command.includes("<<")) return command
	const lines = command.split("\n")
	const out: string[] = []
	let i = 0
	while (i < lines.length) {
		const line = lines[i]!
		const opener = findHeredocOpener(line)
		if (!opener) {
			out.push(line)
			i++
			continue
		}
		out.push(line)
		// closing line: exactly the delimiter (tab-stripped for <<-)
		let close = -1
		for (let j = i + 1; j < lines.length; j++) {
			const raw = lines[j]!
			const candidate = opener.isDash ? raw.replace(/^\t+/, "") : raw
			if (candidate === opener.delimiter) {
				close = j
				break
			}
		}
		if (close === -1) {
			i++
			continue
		}
		if (!remoteBoundHeredoc(opener.prefixMaskedSource.slice(0, opener.opIndex))) {
			for (let j = i + 1; j <= close; j++) out.push(lines[j]!)
		}
		i = close + 1
	}
	return out.join("\n")
}

/**
 * W4 scan (BH-R3 rework): first Read/Edit deny-rule hit reached through a
 * bash path argument or redirection target, plus the unrecognized mv/cp
 * flag escalation channel. Read-class commands check Read rules,
 * write/create-class (and every redirection target) check Edit rules; sed
 * applies its CC extractor (files + -f script; -i routes to Edit). mv/cp
 * are analyzed by {@link analyzeMoveCp}: recognized harmless flags are
 * stripped and the bare form is rule-checked; an UNRECOGNIZED flag never
 * denies — it escalates to ask (the former 82d35c2 behavior denied any
 * flagged form outright whenever any deny rule existed). A deny hit
 * applies to the whole command (CC deniedSubresult parity).
 */
function scanBashDeny(
	command: string,
	cwd: string,
	rules: PermissionRule[],
): { deny: BashDenyHit | null; flagAsk: BashFlagEscalation | null } {
	let flagAsk: BashFlagEscalation | null = null
	const effective = stripRemoteHeredocBodies(command)
	for (const node of walkCdChain(effective, cwd)) {
		const cwdFor = node.dir
		const parsed = parseSegment(node.segment)
		if (parsed) {
			if (parsed.base === "mv" || parsed.base === "cp") {
				const analysis = analyzeMoveCp(parsed)
				const hit = matchRules(checkedPaths(analysis), "Edit", rules, cwd, cwdFor)
				if (hit) return { deny: hit, flagAsk }
				if (analysis.unrecognizedFlag !== null && flagAsk === null) {
					flagAsk = { flag: analysis.unrecognizedFlag }
				}
			} else if (parsed.base === "sed") {
				const { inPlace, paths } = analyzeSed(parsed.operands, parsed.postDashStart)
				const hit = matchRules(paths, inPlace ? "Edit" : "Read", rules, cwd, cwdFor)
				if (hit) return { deny: hit, flagAsk }
			} else if (W4_READ_COMMANDS.includes(parsed.base)) {
				const hit = matchRules(pathArgsFor(parsed), "Read", rules, cwd, cwdFor)
				if (hit) return { deny: hit, flagAsk }
			} else if (W4_WRITE_COMMANDS.includes(parsed.base)) {
				const hit = matchRules(parsed.args, "Edit", rules, cwd, cwdFor)
				if (hit) return { deny: hit, flagAsk }
			}
		}
		// Redirection targets are Edit-semantic regardless of argv0.
		const rawTokens = tokenizeSegment(node.segment)
		for (let i = 0; i < rawTokens.length; i++) {
			if (!isRedirectOp(rawTokens[i]!)) continue
			const dst = rawTokens[i + 1]
			if (dst === undefined || dst === "/dev/null" || dst.startsWith("&")) continue
			const resolved = resolveToken(dst)
			if (resolved === null) continue
			const hit = matchRules([resolved], "Edit", rules, cwd, cwdFor)
			if (hit) return { deny: hit, flagAsk }
		}
	}
	return { deny: null, flagAsk }
}

/**
 * S2 (spec 2026-11-15-cleanup-hardening): the single-scan public entry —
 * ONE pass over the command yields both verdicts: the first Read/Edit
 * deny-rule hit (whole-command deny) and the first unrecognized mv/cp
 * flag escalation (ask). Callers that need both (modes/adjudication-facts.ts
 * collectAdjudicationFacts)
 * must scan each command once here instead of running the deny scan and a
 * second empty-rules scan (the deleted checkBashFlagEscalation hack).
 */
export function checkBashDenyScan(
	command: string,
	cwd: string,
	rules: PermissionRule[],
): { deny: BashDenyHit | null; flagAsk: BashFlagEscalation | null } {
	if (!command || !command.trim()) return { deny: null, flagAsk: null }
	return scanBashDeny(command, cwd, rules)
}

/**
 * W4: first Read/Edit deny-rule hit reached through a bash path argument or
 * redirection target, or null. The deny applies to the whole command —
 * callers must treat any hit as a full-command deny (CC deniedSubresult
 * parity).
 */
export function checkBashDenyHit(
	command: string,
	cwd: string,
	rules: PermissionRule[],
): BashDenyHit | null {
	if (!command || !command.trim()) return null
	if (!rules.some((r) => r.behavior === "deny")) return null
	return scanBashDeny(command, cwd, rules).deny
}

function matchRules(
	paths: string[],
	ccTool: "Read" | "Edit",
	rules: PermissionRule[],
	cwd: string,
	targetCwd: string = cwd,
): BashDenyHit | null {
	for (const rule of rules) {
		if (rule.behavior !== "deny") continue
		if (rule.ruleValue.toolName !== ccTool) continue
		for (const p of paths) {
			// E1: the candidate resolves against targetCwd (cd-tracked); the
			// rule text stays anchored to the session cwd.
			if (pathToolMatchesRuleContent(ccTool, p, rule.ruleValue.ruleContent, cwd, targetCwd)) {
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
