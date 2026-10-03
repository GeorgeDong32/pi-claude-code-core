/**
 * modes/auto-risk.ts — auto-mode risk heuristics (bash pattern categories,
 * outside-cwd write detection for edit/write). Carved out of the old
 * modes/utils.ts grab-bag (arch review C3, 2026-10-03); behavior unchanged.
 */
import { isOutsideCwd } from "./path-safety.ts"

// ---- Auto risk patterns (v2.0.0) ----------------------------------------

const AUTO_RISK_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
	{ category: "delete", pattern: /\brm\b/i },
	{ category: "delete", pattern: /\brmdir\b/i },
	{ category: "delete", pattern: /\bshred\b/i },
	{ category: "delete", pattern: /\bdd\b/i },
	{ category: "delete", pattern: /\bfind\b[^\n|;&]*\s-delete\b/i },
	{ category: "delete", pattern: /\bfind\b[^\n|;&]*\s-exec\b/i },
	{ category: "delete", pattern: /\bfind\b[^\n|;&]*\s-execdir\b/i },
	{ category: "delete", pattern: /\bfind\b[^\n|;&]*\s-fexec\b/i },
	{ category: "destructive", pattern: /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i },
	{ category: "destructive", pattern: /\bmv\b/i },
	{ category: "destructive", pattern: /\bcp\b/i },
	{ category: "destructive", pattern: /\bmkdir\b/i },
	{ category: "destructive", pattern: /\btouch\b/i },
	{ category: "destructive", pattern: /\d?>(?!&\d)/ },
	{ category: "destructive", pattern: />>/ },
	{ category: "package-install", pattern: /\bnpm\s+(install|uninstall|update|ci|link|publish)/i },
	{ category: "package-install", pattern: /\byarn\s+(add|remove|install|publish)/i },
	{ category: "package-install", pattern: /\bpnpm\s+(add|remove|install|publish)/i },
	{ category: "package-install", pattern: /\bpip\s+(install|uninstall)/i },
	{ category: "package-install", pattern: /\bapt(-get)?\s+(install|remove|purge|upgrade)/i },
	{ category: "package-install", pattern: /\bbrew\s+(install|uninstall|upgrade)/i },
	{ category: "network", pattern: /\bcurl\b/i },
	{ category: "network", pattern: /\bwget\b/i },
	{ category: "network", pattern: /https?:\/\//i },
	{ category: "privilege", pattern: /\bsudo\b/i },
	{ category: "privilege", pattern: /\bchmod\b/i },
	{ category: "privilege", pattern: /\bchown\b/i },
	{ category: "process", pattern: /\bkill\b/i },
	{ category: "process", pattern: /\bpkill\b/i },
	{ category: "process", pattern: /\bkillall\b/i },
	{ category: "system", pattern: /\breboot\b/i },
	{ category: "system", pattern: /\bshutdown\b/i },
	{ category: "system", pattern: /\bsystemctl\s+(start|stop|restart|enable|disable)/i },
]

export interface AutoRiskCheckInput {
	tool: string
	command?: string
	path?: string
}

export interface AutoRiskResult {
	match: boolean
	category: string
	reason: string
}

export function checkAutoRisk(
	input: AutoRiskCheckInput,
	cwd: string,
): AutoRiskResult {
	const noMatch: AutoRiskResult = { match: false, category: "", reason: "" }

	if (input.tool === "bash") {
		const cmd = input.command ?? ""
		for (const { category, pattern } of AUTO_RISK_PATTERNS) {
			if (pattern.test(cmd)) {
				return {
					match: true,
					category,
					reason: `Risky bash (${category}): ${cmd}`,
				}
			}
		}
		return noMatch
	}

	if (input.tool === "edit" || input.tool === "write") {
		const pathStr = input.path ?? ""
		if (pathStr && isOutsideCwd(pathStr, cwd)) {
			return {
				match: true,
				category: "outside-cwd-write",
				reason: `Write outside cwd: ${pathStr}`,
			}
		}
	}

	return noMatch
}
