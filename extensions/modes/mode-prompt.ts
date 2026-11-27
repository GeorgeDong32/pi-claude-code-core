
export const MODE_PROMPT_BEGIN = "<!-- permission-modes:context -->"
export const MODE_PROMPT_END = "<!-- /permission-modes:context -->"

const MODE_PROMPT_BLOCK_RE =
	/<!-- permission-modes:context -->[\s\S]*?<!-- \/permission-modes:context -->\n?/

export type PermissionMode = "ask" | "plan" | "auto" | "bypass"
export type PlanPhase = "exploring" | "refining" | "executing"

export function injectModePrompt(
	systemPrompt: string,
	modeBlock: string,
): string {
	const stripped = systemPrompt.replace(MODE_PROMPT_BLOCK_RE, "")
	if (!modeBlock.trim()) return stripped
	return `${stripped}\n${MODE_PROMPT_BEGIN}\n${modeBlock.trim()}\n${MODE_PROMPT_END}`
}

export interface ResolveModePromptOpts {
	mode: PermissionMode
	planPhase?: PlanPhase
	planFilePath?: string
	needsAskReminder?: boolean
	needsBypassSecurityReminder?: boolean
	pendingComplianceInject?: boolean
	complianceCategory?: string
}

export function resolveModePrompt(opts: ResolveModePromptOpts): string {
	const {
		mode,
		planPhase = "exploring",
		planFilePath,
		needsAskReminder,
		needsBypassSecurityReminder,
		pendingComplianceInject,
		complianceCategory,
	} = opts

	if (pendingComplianceInject) {
		const cat = complianceCategory ? ` (${complianceCategory})` : ""
		return `[Auto] Your last tool call was blocked${cat}. Confirm the action aligns with the user's request and is the safest approach. Retry with a safer alternative if unsure.`
	}

	if (mode === "ask" && needsAskReminder) {
		return "[Ask] Edits, outside-cwd access, and mutating commands need approval. Inside-cwd reads are automatic."
	}

	if (mode === "plan" && planFilePath) {
		let block = `[Plan Mode] You are in plan mode. In this mode:
- Only use read-only tools (read, grep, find, ls, and read-only bash like git status/log/diff).
- Explore the codebase, understand architecture, and design an implementation approach.
- Do NOT edit, write, or run mutating commands. Do NOT implement anything yet.
- Maintain your plan as a numbered list in: ${planFilePath}
- Use \`read\` to review and \`edit\` to update ONLY the plan file.
- When your plan is complete and concrete, tell the user it is ready for review.
- The user will approve or refine the plan before execution begins.`;
		if (planPhase === "executing") {
			block = `[Plan/executing] Execute steps from plan.md. Mark progress with [DONE:n] tags.`;
		}
		return block;
	}

	if (mode === "bypass" && needsBypassSecurityReminder) {
		return "[Bypass] All tool calls are auto-approved with no permission checks. You are responsible for security: avoid exfiltrating secrets, running untrusted downloads, or destructive commands outside the user's intent. Prefer isolated environments."
	}

	return ""
}

/**
 * Skill blocks in the pi prompt follow this schema (see
 * `@earendil-works/pi-coding-agent/dist/core/skills.js:formatSkillsForPrompt`)
 * — NOT the Agent Skills spec's `<skill name="...">` attribute format:
 *
 *   <skill>
 *     <name>SKILL_NAME</name>
 *     <description>...</description>
 *     <location>...absolute path to SKILL.md...</location>
 *   </skill>
 *
 * Skill names are constrained to [a-z0-9-] per the Agent Skills spec, so
 * no regex escaping is needed.
 */

export function filterSkillsFromPrompt(
	prompt: string,
	allowedSkills: string[],
): string {
	if (
		!allowedSkills ||
		allowedSkills.length === 0 ||
		(allowedSkills.length === 1 && allowedSkills[0] === "*")
	) {
		return prompt
	}

	if (!prompt.includes("<skill")) return prompt

	// `\s*` between <skill> and <name>: pi's formatSkillsForPrompt indents,
	// external callers may re-format. `[\s\S]*?` is lazy — stops at the
	// first </skill>; skills never nest (Agent Skills spec).
	return prompt.replace(
		/<skill>\s*<name>([^<]+)<\/name>[\s\S]*?<\/skill>/g,
		(match, name: string) => (allowedSkills.includes(name) ? match : ""),
	)
}
