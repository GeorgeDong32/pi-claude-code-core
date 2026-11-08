/**
 * bash-permission-match.ts
 *
 * Bash permission rule matching (CC bashPermissions.ts subset).
 *
 * P0-1 (2026-11-08 review fix, safety-gated): an ALLOW rule never matches a
 * command that carries command substitution ($(), backticks, ${}, process
 * substitution <() >() =(, Zsh =cmd / $[ / ~[ / (e: / (+, PowerShell <#)
 * unless the only substitution is CC's safe-heredoc form (isSafeHeredoc
 * port below), and never matches when a redirection target lands on a
 * CC-sensitive path. Such commands fall back to passthrough and each
 * mode's default logic asks. Gated by the W5 safety tier
 * (PI_CORE_BASH_PATH_CHECKS / bashPathChecks: all|safety → on).
 *
 * P2 (2026-11-08): SAFE_WRAPPER_PREFIXES aligned with CC's five wrapper
 * forms (timeout/time/nice/stdbuf/nohup incl. bare `nice`, `nice -N`, and
 * `--` passthrough); deny/ask matching additionally expands $() and
 * backtick subcommands into candidates (single-level approximation —
 * (...) groups and { ...; } are a known gap, see DEVIATIONS).
 */

import { splitShellSegments } from "./bash-analysis.ts"
import {
	matchShellRule,
	parsePermissionRule,
	type ShellPermissionRule,
} from "./shell-rule-matching.ts"
import { isCcSafetyPath } from "./path-safety.ts"
import { loadPermissionModesConfig } from "./config.ts"
import { resolveBashPathChecks } from "./bash-path-check.ts"

const SAFE_WRAPPER_PREFIXES = [
	// CC bashPermissions.ts SAFE_WRAPPER_PATTERNS parity (2026-11-08 P2):
	// timeout with GNU long/short flags whose VALUES are allowlisted
	// ([A-Za-z0-9_.+-] — no $() smuggling), then a duration;
	/^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
	// bare time (no -p required) + optional --
	/^time[ \t]+(?:--[ \t]+)?/,
	// nice: bare, -n N, or legacy -N
	/^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
	// stdbuf: fused short flags only (-o0, -eL groups)
	/^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
	/^nohup[ \t]+(?:--[ \t]+)?/,
]

const SAFE_ENV_VARS = new Set([
	"NODE_ENV",
	"RUST_BACKTRACE",
	"RUST_LOG",
	"PYTHONUNBUFFERED",
	"LANG",
	"LC_ALL",
	"TERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"TZ",
])

const ENV_VAR_PATTERN =
	/^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\'"])*[ \t]+/

export function stripOutputRedirections(command: string): string {
	return command.replace(/\s*(?:>>?|[0-9]+>>?)\s*[^\s;&|]+/g, "").trim()
}

export function stripSafeWrappers(command: string): string {
	let stripped = command.trim()
	let prev = ""
	while (stripped !== prev) {
		prev = stripped
		for (const re of SAFE_WRAPPER_PREFIXES) {
			const next = stripped.replace(re, "")
			if (next !== stripped) {
				stripped = next.trim()
				break
			}
		}
	}
	return stripped
}

export function stripAllLeadingEnvVars(command: string): string {
	let stripped = command.trim()
	let prev = ""
	while (stripped !== prev) {
		prev = stripped
		const m = stripped.match(ENV_VAR_PATTERN)
		if (!m) break
		stripped = stripped.slice(m[0].length).trim()
	}
	return stripped
}

export function stripSafeLeadingEnvVars(command: string): string {
	let stripped = command.trim()
	let prev = ""
	while (stripped !== prev) {
		prev = stripped
		const m = stripped.match(ENV_VAR_PATTERN)
		if (!m) break
		const varName = m[1]!.split("=")[0]!.replace(/\[.*$/, "")
		if (!SAFE_ENV_VARS.has(varName)) break
		stripped = stripped.slice(m[0].length).trim()
	}
	return stripped
}

/**
 * P2 (2026-11-08): single-level $() / backtick subcommand expansion for
 * deny/ask matching — the inner text becomes an extra candidate (CC does
 * this via AST; a regex-level pass is the accepted approximation —
 * (...) groups and { ...; } are a known gap, DEVIATIONS #134).
 */
function expandSubcommands(cmd: string): string[] {
	const out: string[] = []
	const re = /\$\(([\s\S]*?)\)|`([^`]*)`/g
	let m: RegExpExecArray | null
	while ((m = re.exec(cmd)) !== null) {
		const inner = (m[1] ?? m[2] ?? "").trim()
		if (inner) out.push(inner)
	}
	return out
}

function buildCommandCandidates(
	command: string,
	stripAllEnv: boolean,
): string[] {
	const base = stripOutputRedirections(command)
	const seen = new Set<string>()
	const out: string[] = []

	const push = (s: string) => {
		const t = s.trim()
		if (t && !seen.has(t)) {
			seen.add(t)
			out.push(t)
		}
	}

	push(base)
	push(stripSafeWrappers(base))

	// P2: for deny/ask, subcommands inside $()/backticks are candidates too
	// (bounded depth: expanding candidates of candidates once is enough for
	// the real-world nesting we see; deeper nesting falls back to the outer
	// string still being matched as-is).
	if (!stripAllEnv) {
		// allow direction: no subcommand expansion (allow rules must not
		// approve hidden commands; P0-1 already rejects substitution)
	} else {
		for (const sub of expandSubcommands(base)) {
			push(sub)
			push(stripSafeWrappers(sub))
		}
	}

	if (stripAllEnv) {
		let start = 0
		while (start < out.length) {
			const end = out.length
			for (let i = start; i < end; i++) {
				push(stripAllLeadingEnvVars(out[i]!))
				push(stripSafeWrappers(out[i]!))
			}
			start = end
		}
	} else {
		for (const cmd of [...out]) {
			push(stripSafeLeadingEnvVars(cmd))
		}
	}

	return out
}

function parseRuleContent(content: string | undefined): ShellPermissionRule | null {
	if (content === undefined) return null
	return parsePermissionRule(content)
}

// ---- P0-1 allow-rule hardening (2026-11-08, safety-gated) ------------------

/** CC bashSecurity.ts COMMAND_SUBSTITUTION_PATTERNS parity (+ backticks). */
const COMMAND_SUBSTITUTION_PATTERNS: RegExp[] = [
	/<\(/,
	/>\(/,
	/=\(/,
	/(?:^|[\s;&|])=[a-zA-Z_]/, // Zsh =cmd expansion
	/\$\(/,
	/\$\{/,
	/\$\[/,
	/~\[/,
	/\(e:/,
	/\(\+/,
	/\}\s*always\s*\{/,
	/<#/,
	/`/,
]

/**
 * CC bashSecurity.ts isSafeHeredoc port (P0-1 condition, user-mandated):
 * `cmd $(cat <<'DELIM'\n…\nDELIM\n)` — quoted/escaped delimiter only,
 * line-based first-close matching, nested-match rejection, argument-
 * position requirement, and a strict character whitelist on the remaining
 * text. Returns the command with every verified safe heredoc stripped, or
 * null when any heredoc fails the pattern (caller treats as substitution).
 */
function stripSafeHeredocs(command: string): string | null {
	if (!/\$\(.*<</.test(command)) return command
	const heredocPattern = /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
	const safe: Array<{ start: number; operatorEnd: number; delimiter: string; isDash: boolean }> = []
	let match: RegExpExecArray | null
	while ((match = heredocPattern.exec(command)) !== null) {
		const delimiter = match[2] || match[3]
		if (delimiter) {
			safe.push({
				start: match.index,
				operatorEnd: match.index + match[0].length,
				delimiter,
				isDash: match[1] === "-",
			})
		}
	}
	if (safe.length === 0) return null
	const verified: Array<{ start: number; end: number }> = []
	for (const { start, operatorEnd, delimiter, isDash } of safe) {
		const afterOperator = command.slice(operatorEnd)
		const openLineEnd = afterOperator.indexOf("\n")
		if (openLineEnd === -1) return null
		if (!/^[ \t]*$/.test(afterOperator.slice(0, openLineEnd))) return null
		const bodyStart = operatorEnd + openLineEnd + 1
		const bodyLines = command.slice(bodyStart).split("\n")
		let closingLineIdx = -1
		let closeParenLineIdx = -1
		let closeParenColIdx = -1
		for (let i = 0; i < bodyLines.length; i++) {
			const rawLine = bodyLines[i]!
			const line = isDash ? rawLine.replace(/^\t*/, "") : rawLine
			if (line === delimiter) {
				closingLineIdx = i
				const nextLine = bodyLines[i + 1]
				if (nextLine === undefined) return null
			const parenMatch = nextLine.match(/^([ \t]*)\)/)
				if (!parenMatch) return null
				closeParenLineIdx = i + 1
				closeParenColIdx = parenMatch[1]!.length
				break
			}
			if (line.startsWith(delimiter)) {
				const afterDelim = line.slice(delimiter.length)
				const parenMatch = afterDelim.match(/^([ \t]*)\)/)
				if (parenMatch) {
					closingLineIdx = i
					closeParenLineIdx = i
					const tabPrefix = isDash ? (rawLine.match(/^\t*/)?.[0] ?? "") : ""
					closeParenColIdx = tabPrefix.length + delimiter.length + parenMatch[1]!.length
					break
				}
				if (/^[)}`|&;(<>]/.test(afterDelim)) return null
			}
		}
		if (closingLineIdx === -1) return null
		let endPos = bodyStart
		for (let i = 0; i < closeParenLineIdx; i++) endPos += bodyLines[i]!.length + 1
		endPos += closeParenColIdx + 1
		verified.push({ start, end: endPos })
	}
	// Reject nested matches (indices would corrupt on strip).
	for (const outer of verified) {
		for (const inner of verified) {
			if (inner !== outer && inner.start > outer.start && inner.start < outer.end) return null
		}
	}
	// Strip verified heredocs (reverse order keeps indices valid).
	const sorted = [...verified].sort((a, b) => b.start - a.start)
	let remaining = command
	for (const { start, end } of sorted) {
		remaining = remaining.slice(0, start) + remaining.slice(end)
	}
	// Argument-position requirement: the $() must not be the command name.
	const trimmedRemaining = remaining.trim()
	if (trimmedRemaining.length > 0) {
		const firstHeredocStart = Math.min(...verified.map((v) => v.start))
		if (command.slice(0, firstHeredocStart).trim().length === 0) return null
	}
	// Remaining text: command names/args/quotes/whitespace only — no shell
	// metacharacters that could chain another command after the heredoc.
	if (!/^[a-zA-Z0-9 \t"'.\-/_@=,:+~]*$/.test(remaining)) return null
	return remaining
}

/** Does the command carry command substitution outside a safe heredoc? */
function hasCommandSubstitution(command: string): boolean {
	const stripped = stripSafeHeredocs(command)
	if (stripped === null) return true
	if (stripped === command) {
		// no heredoc involved — test the raw command
		return COMMAND_SUBSTITUTION_PATTERNS.some((re) => re.test(command))
	}
	return COMMAND_SUBSTITUTION_PATTERNS.some((re) => re.test(stripped))
}

/**
 * Does any redirection target land on a CC-sensitive path? Reuses the W3
 * extractor's tokenizer semantics via a light local scan (segment tokens,
 * redirect operators, quoted-literal unquoting).
 */
function redirectTargetsSensitivePath(command: string, cwd: string): boolean {
	for (const segment of splitShellSegments(command)) {
		const tokens = segment.split(/\s+/).filter(Boolean)
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i]!
			const base = t.replace(/^\d+/, "")
			if (base !== ">" && base !== ">>" && base !== "&>" && base !== "&>>") continue
			const dst = tokens[i + 1]
			if (dst === undefined || dst === "/dev/null" || dst.startsWith("&")) continue
			// unquote a full-literal target; anything uncertain fails open
			let candidate = dst
			if ((dst.startsWith("'") && dst.endsWith("'")) || (dst.startsWith('"') && dst.endsWith('"'))) {
				const inner = dst.slice(1, -1)
				if (inner.includes("$") || inner.includes("`") || inner.includes("\\")) continue
				candidate = inner
		} else if (/[`$*?\[\]]/.test(dst)) continue
			if (isCcSafetyPath(candidate, cwd)) return true
		}
	}
	return false
}

function commandMatchesRule(
	command: string,
	rule: ShellPermissionRule,
	behavior: "allow" | "deny" | "ask",
): boolean {
	const stripAllEnv = behavior !== "allow"
	const candidates = buildCommandCandidates(command, stripAllEnv)
	const matchMode = behavior === "allow" ? "prefix" : "prefix"
	const allowCompound = behavior !== "allow"

	for (const cmd of candidates) {
		const segments = splitShellSegments(cmd)
		const segmentsToCheck =
			behavior === "allow"
				? segments.length === 1
					? segments
					: []
				: segments.length > 0
					? segments
					: [cmd]

		for (const seg of segmentsToCheck) {
			const segTrim = seg.trim()
			if (!segTrim) continue
			const isCompound = splitShellSegments(segTrim).length > 1
			if (
				matchShellRule(
					rule,
					segTrim,
					matchMode,
					behavior === "allow" ? !isCompound : true,
				)
			) {
				return true
			}
			if (rule.type === "exact" && rule.command === segTrim) {
				return true
			}
		}

		// Tool-wide Bash rule (no content) matches any command
		if (rule.type === "exact" && rule.command === "*") {
			return true
		}
	}

	return false
}

export function bashCommandMatchesRuleContent(
	command: string,
	ruleContent: string | undefined,
	behavior: "allow" | "deny" | "ask",
	opts?: { allowHardening?: boolean; cwd?: string },
): boolean {
	if (ruleContent === undefined) {
		// Bare Bash — matches all commands
		return true
	}
	// P0-1 (2026-11-08): allow rules never match commands carrying command
	// substitution (outside CC's safe-heredoc form) or a sensitive-path
	// redirection — they fall back to passthrough so each mode asks. Gated
	// by the W5 safety tier; opts.allowHardening lets tests pin both states.
	if (behavior === "allow") {
		const hardening = opts?.allowHardening ?? safetyTierActive()
		if (hardening) {
			if (hasCommandSubstitution(command)) return false
			if (redirectTargetsSensitivePath(command, opts?.cwd ?? process.cwd())) return false
		}
	}
	const rule = parseRuleContent(ruleContent)
	if (!rule) return false
	return commandMatchesRule(command, rule, behavior)
}

function safetyTierActive(): boolean {
	try {
		const mode = resolveBashPathChecks(loadPermissionModesConfig())
		return mode === "all" || mode === "safety"
	} catch {
		return false
	}
}

export function suggestBashAllowRule(command: string): string {
	const trimmed = command.trim()
	if (!trimmed) return "Bash"

	// For multi-line commands, use the first line
	const firstLine = trimmed.includes("\n") ? trimmed.split("\n")[0]!.trim() : trimmed

	const tokens = firstLine.split(/\s+/).filter(Boolean)
	// Skip leading env var assignments
	let i = 0
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
		i++
	}

	const baseCmd = tokens[i]
	if (!baseCmd) return "Bash"

	// Package managers and git: suggest broad tool-wide rule
	const BROAD_RULE_COMMANDS = new Set([
		"npm", "pnpm", "yarn", "bun", "git", "cargo", "go", "docker", "make",
	])
	if (BROAD_RULE_COMMANDS.has(baseCmd)) {
		return `Bash(${baseCmd}:*)`
	}

	// Other commands: suggest two-level prefix (command + subcommand)
	const subCmd = tokens[i + 1]
	if (subCmd && !subCmd.startsWith("-")) {
		return `Bash(${baseCmd} ${subCmd}:*)`
	}
	return `Bash(${baseCmd}:*)`
}

function escapeBashRuleContent(content: string): string {
	return content
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)")
}
