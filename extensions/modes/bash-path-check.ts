import { splitShellChain, isSafeCommand } from "./bash-analysis.ts"
import { isCcSafetyPath, expandUserPath } from "./path-safety.ts"
import type { PermissionModesConfig } from "./config.ts"
import type { PermissionRule } from "./permissions.ts"
import { pathToolMatchesRuleContent } from "./path-permission-match.ts"
import { matchProtectedPath } from "../memory/protected-paths.ts"
import { homedir } from "node:os"
import path from "node:path"


export type BashPathCheckMode = "all" | "safety" | "deny" | "off"

const VALID_MODES: readonly BashPathCheckMode[] = ["all", "safety", "deny", "off"]

function coerceMode(v: string | undefined): BashPathCheckMode | null {
	if (v === undefined || v === "") return null
	const lower = v.toLowerCase()
	return (VALID_MODES as readonly string[]).includes(lower) ? (lower as BashPathCheckMode) : null
}

export function resolveBashPathChecks(config: PermissionModesConfig): BashPathCheckMode {
	return coerceMode(process.env.PI_CORE_BASH_PATH_CHECKS)
		?? coerceMode(config.bashPathChecks)
		?? "all"
}


export interface BashPathTarget {
	path: string
	kind: "redirect" | "argument" | "mv-cp-flag-form"
}

function unquoteLiteral(token: string): string | null {
	if (token.length < 2) return null
	const first = token[0]!
	const last = token[token.length - 1]!
	if (!((first === "'" && last === "'") || (first === '"' && last === '"'))) return null
	const inner = token.slice(1, -1)
	if (inner.length === 0) return null
	if (inner.includes("$") || inner.includes("`") || inner.includes("\\")) return null
	if (inner.includes("'") || inner.includes('"')) return null
	return inner
}

function resolveToken(token: string): string | null {
	if (token === "") return null
	if (token.includes("'") || token.includes('"')) return unquoteLiteral(token)
	if (/[`$*?\[\]]/.test(token)) return null
	return token
}

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
		if (ch === ">" || (ch === "&" && segment[i + 1] === ">")) {
			push()
			let op = ch
			i++
			while (i < segment.length && segment[i] === ">") {
				op += ">"
				i++
			}
			tokens.push(op)
			i--
			continue
		}
		current += ch
	}
	push()
	return tokens
}

interface ParsedSegment {
	base: string
	args: string[]
	operands: string[]
	redirects: string[]
	postDashStart: number
}

function isRedirectOp(token: string): boolean {
	const base = token.replace(/^\d+/, "")
	return base === ">" || base === ">>" || base === "&>" || base === "&>>"
}

function parseSegment(segment: string): ParsedSegment | null {
	const tokens = tokenizeSegment(segment)
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
			if (dst !== undefined && dst !== "/dev/null" && !dst.startsWith("&")) {
				const resolved = resolveToken(dst)
				if (resolved !== null) redirects.push(resolved)
			}
			i++
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

export { tokenizeSegment }

interface SedAnalysis {
	inPlace: boolean
	paths: string[]
}

const SED_LONG_FILE = new Set(["-f", "--file"])
const SED_LONG_EXPR = new Set(["-e", "--expression"])

function analyzeSed(operands: string[], postDashStart: number): SedAnalysis {
	const paths: string[] = []
	let scriptFound = false
	let inPlace = false
	for (let i = 0; i < operands.length; i++) {
		const arg = operands[i]!
		const isFlag = postDashStart === -1 || i < postDashStart
		if (isFlag && arg.startsWith("-") && arg !== "-") {
			if (SED_LONG_FILE.has(arg)) {
				const scriptFile = operands[i + 1]
				if (scriptFile !== undefined && resolveToken(scriptFile) !== null) {
					paths.push(resolveToken(scriptFile)!)
					i++
				}
				scriptFound = true
				continue
			}
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
			if (arg.startsWith("--")) continue
			const letters = arg.replace(/^-+/, "")
			if (letters.includes("i")) inPlace = true
			if (letters.includes("e") || letters.includes("f")) scriptFound = true
			continue
		}
		if (!scriptFound) {
			scriptFound = true
			continue
		}
		const resolved = resolveToken(arg)
		if (resolved !== null) paths.push(resolved)
	}
	return { inPlace, paths }
}

function sedInPlace(segment: string): boolean {
	const parsed = parseSegment(segment)
	if (!parsed || parsed.base !== "sed") return false
	return analyzeSed(parsed.operands, parsed.postDashStart).inPlace
}

interface ChainNode {
	segment: string
	dir: string
	isCd: boolean
}

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

export function checkBashWriteTargets(
	command: string,
	cwd: string,
): BashPathTarget | null {
	if (!command || !command.trim()) return null
	const chain = walkCdChain(command, cwd)
	let hit: BashPathTarget | null = null
	for (const node of chain) {
		if (hit !== null) {
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
		const dst = parsed.args[parsed.args.length - 1]!
		if (isCcSafetyPath(dst, cwd)) return { path: dst, kind: "argument" }
		return null
	}
	for (const a of parsed.args) {
		if (isCcSafetyPath(a, cwd)) return { path: a, kind: "argument" }
	}
	return null
}


export interface BashProtectedWrite {
	target: string
	kind: string
}

function resolveAbs(p: string, cwd: string): string {
	const expanded = expandUserPath(p)
	return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded)
}

export function checkBashProtectedWrite(
	command: string,
	cwd: string,
): BashProtectedWrite | null {
	if (!command || !command.trim()) return null
	const home = homedir()
	for (const node of walkCdChain(command, cwd)) {
		if (node.isCd) continue
		const cwdFor = node.dir
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
		if (moveCpUnrecognized !== null) {
			return { target: moveCpUnrecognized, kind: "mv-cp-flag-form" }
		}
	}
	return null
}


const W4_READ_COMMANDS: readonly string[] = [
	"cat", "head", "tail", "sort", "uniq", "wc", "cut", "paste", "column",
	"tr", "file", "stat", "diff", "awk", "strings", "hexdump", "od",
	"base64", "nl", "grep", "rg", "jq", "sha256sum", "sha1sum", "md5sum",
	"ls", "find", "sed",
]

const W4_WRITE_COMMANDS: readonly string[] = [
	"rm", "rmdir", "mv", "cp", "touch", "mkdir",
]

const PATTERN_FIRST = new Set(["grep", "rg", "awk", "jq"])

export interface BashDenyHit {
	path: string
	rule: string
	source: string
}

export interface BashFlagEscalation {
	flag: string
}

function pathArgsFor(parsed: ParsedSegment): string[] {
	if (parsed.base === "find") {
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

const FLAG_SENSITIVE_MOVE_COMMANDS = new Set(["mv", "cp"])

const MOVE_CP_HARMLESS_SHORT = new Set([
	"r", "R",
	"f",
	"i",
	"n",
	"v",
	"a",
	"p",
	"u",
	"b",
	"T",
	"l",
	"H", "L", "P", "d",
	"Z",
	"x",
])

const MOVE_CP_HARMLESS_LONG = new Set([
	"recursive", "force", "interactive", "no-clobber", "verbose", "archive",
	"preserve", "no-preserve", "backup", "strip-trailing-slashes", "debug",
	"no-target-directory", "link", "dereference-recursive", "attributes-only",
	"copy-contents", "no-copy", "exchange", "discard-destination",
	"update", "context",
])

const MOVE_CP_VALUED_LONG = new Set(["suffix"])

const MOVE_CP_VALUED_SHORT = new Set(["S"])

export interface MoveCpAnalysis {
	targetDir: string | null
	paths: string[]
	unrecognizedFlag: string | null
}

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
					if (eq === -1 && value !== null) i++
				} else if (MOVE_CP_VALUED_LONG.has(name)) {
					if (eq === -1 && parsed.operands[i + 1] !== undefined) i++
				} else if (!MOVE_CP_HARMLESS_LONG.has(name)) {
					unrecognizedFlag ??= op
				}
				continue
			}
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
					if (chars.slice(c + 1) === "") i++
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
	if (targetDir !== null && /[$`'"]/.test(targetDir)) {
		unrecognizedFlag ??= targetDir
		targetDir = null
	}
	return { targetDir, paths, unrecognizedFlag }
}


interface HeredocOpener {
	delimiter: string
	isDash: boolean
	prefixMaskedSource: string
	opIndex: number
}

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

function findHeredocOpener(line: string): HeredocOpener | null {
	if (!line.includes("<<")) return null
	const masked = maskQuotedSpans(line)
	for (let i = 0; i < masked.length; i++) {
		if (masked[i] !== "<" || masked[i + 1] !== "<") continue
		if (masked[i - 1] === "<" || masked[i + 2] === "<") continue
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

function remoteBoundHeredoc(prefix: string): boolean {
	const pieces = prefix.split(/&&|\|\||[|;]/)
	const last = (pieces[pieces.length - 1] ?? "").trim()
	const tokens = last.split(/[ \t]+/).filter(Boolean)
	while (tokens.length > 0 && /^\w+=/.test(tokens[0]!)) tokens.shift()
	const cmd = tokens[0]
	if (!cmd) return false
	return cmd.slice(cmd.lastIndexOf("/") + 1) === "ssh"
}

// a heredoc body piped to `ssh host …` executes on the REMOTE host — its lines are not local commands
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

export function checkBashDenyScan(
	command: string,
	cwd: string,
	rules: PermissionRule[],
): { deny: BashDenyHit | null; flagAsk: BashFlagEscalation | null } {
	if (!command || !command.trim()) return { deny: null, flagAsk: null }
	return scanBashDeny(command, cwd, rules)
}

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
