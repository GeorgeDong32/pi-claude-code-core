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
	/(^|[^<])>(?!>)/,
	/>>/,
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
	/\bcurl\b/i,
	/\bwget\b/i,
];

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
	/^\s*sed\s+-n(?![^\n]*(?:["',;/0-9}]|\s)w\s*["']?\s*[/~])/i,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

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

export function splitShellSegments(command: string): string[] {
	return splitShellChain(command).map((node) => node.segment)
}

export interface ShellChainNode {
	segment: string
	connector: ";" | "&&" | "||" | "|" | "&" | "\n" | null
}

export function splitShellChain(command: string): ShellChainNode[] {
	const nodes: ShellChainNode[] = []
	let current = ""
	let quote: "'" | '"' | null = null

	const push = (connector: ShellChainNode["connector"]) => {
		if (current.trim()) nodes.push({ segment: current.trim(), connector })
		current = ""
	}

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
			push(";")
			continue
		}
		if (
			(command.startsWith("&&", i) || command.startsWith("||", i)) &&
			!isCharEscaped(command, i)
		) {
			push(command.startsWith("&&", i) ? "&&" : "||")
			i += 1
			continue
		}
		if (ch === "|" && command[i + 1] !== "|" && !isCharEscaped(command, i)) {
			push("|")
			continue
		}
		if (ch === "&" && command[i + 1] !== "&" && !isCharEscaped(command, i)) {
			if (command[i - 1] === ">" || command[i + 1] === ">") {
				current += ch
				continue
			}
			push("&")
			continue
		}
		if (ch === "\n" && !isCharEscaped(command, i)) {
			push("\n")
			continue
		}
		current += ch
	}

	push(null)
	return nodes
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

// shell quote juxtaposition (`>/dev/null"leak"` writes `/dev/nullleak`) forces the `(?![\w/.'"])` near-miss guard
function stripNullRedirects(command: string): string {
	return command.replace(/(?:&>>|\d+>>|>>|&>|\d*>|>)\/dev\/null(?![\w/.'"])/g, " ")
}

const GIT_DASH_C_PATTERN =
	/(^|[;&|\s])git\s+-C\s+([^\s'"`&|;<>()$*?[\]\\]+)/

function stripGitDashC(command: string): string {
	let out = command
	for (;;) {
		const next = out.replace(GIT_DASH_C_PATTERN, "$1git")
		if (next === out) return out
		out = next
	}
}

function isSafeLiteralCdSegment(segment: string): boolean {
	const m = /^cd\s+(\S+)$/.exec(segment)
	if (!m) return false
	const target = m[1]!
	return !target.startsWith("-") && !/[$`~*?[\]'"\\;&|<>()]/.test(target)
}

function isSafeSingleCommand(command: string): boolean {
	if (hasNestedShellExecution(command)) return false
	const base = stripNullRedirects(stripFdToFdRedirects(command))
	const gitView = stripGitDashC(base)
	const isDestructive =
		DESTRUCTIVE_PATTERNS.some((p) => p.test(base)) ||
		DESTRUCTIVE_PATTERNS.some((p) => p.test(gitView))
	const isSafe = SAFE_PATTERNS.some((p) => p.test(gitView))
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

export function isSafeCommand(command: string): boolean {
	return chainIsSafe(splitShellChain(command))
}

export function isAutoFallbackBash(command: string): boolean {
	const segments = splitShellSegments(command)
	if (segments.length === 0) return false
	return segments.every(
		(seg) =>
			!hasNestedShellExecution(seg) &&
			(isSafeSingleCommand(seg) || matchesAutoFallbackPattern(seg)),
	)
}

function chainIsSafe(nodes: ShellChainNode[]): boolean {
	return (
		nodes.length > 0 &&
		nodes.every(
			(node) =>
				isSafeSingleCommand(node.segment) ||
				(node.connector === "&&" && isSafeLiteralCdSegment(node.segment)),
		)
	)
}

export function classifyBashTiers(command: string): {
	safe: boolean
	autoApprovable: boolean
} {
	const nodes = splitShellChain(command)
	return {
		safe: chainIsSafe(nodes),
		autoApprovable:
			nodes.length > 0 &&
			nodes.every(
				(node) =>
					!hasNestedShellExecution(node.segment) &&
					(isSafeSingleCommand(node.segment) ||
						isAutoApprovableSingleCommand(node.segment)),
			),
	}
}

const AUTO_APPROVABLE_PATTERNS: RegExp[] = [
	new RegExp(`^\\s*npm\\s+run\\s+(${AUTO_FALLBACK_SCRIPT_NAMES})${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
	new RegExp(`^\\s*(pnpm|yarn|bun)\\s+run\\s+(${AUTO_FALLBACK_SCRIPT_NAMES})${AUTO_FALLBACK_SCRIPT_TAIL}`, "i"),
	/^\s*(make|cmake)\b/i,
	/^\s*cargo\s+(build|check|clippy|fmt|test)\b/i,
	/^\s*go\s+(build|vet|fmt|mod|test)\b/i,
	/^\s*git\s+(add|stash|branch|switch|tag|init|clone|reset)\b/i,
	/^\s*mkdir\b/i,
	/^\s*touch\b/i,
	/^\s*cp\b/i,
	/^\s*mv\b/i,
	/^\s*npx\s+(prettier|eslint|tsc|esbuild|vite|next|nuxt|astro)\b/i,
	/^\s*(prettier|eslint|biome)\b/i,
	/^\s*tsc\b/i,
	/^\s*npm\s+test\b/i,
	/^\s*(pnpm|yarn|bun)\s+test\b/i,
	/^\s*(vitest|jest|mocha|ava|tap)\b/i,
	/^\s*pytest\b/i,
	/^\s*go\s+test\b/i,
	/^\s*cargo\s+test\b/i,
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
	if (hasUnsafeFallbackArgs(normalized)) return false
	if (hasOutsideCwdFallbackTargets(normalized)) return false
	return AUTO_APPROVABLE_PATTERNS.some((p) => p.test(normalized))
}

export function isAutoApprovableBash(command: string): boolean {
	return classifyBashTiers(command).autoApprovable
}
