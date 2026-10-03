/**
 * mode-prompt injection + skills-filter tests — carved from utils.test.ts (arch review C3).
 */
import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { filterSkillsFromPrompt, injectModePrompt, resolveModePrompt } from "./mode-prompt.ts";

describe("filterSkillsFromPrompt", () => {
	const sampleSkillBlock =
		"  <skill>\n" +
		"    <name>systematic-debugging</name>\n" +
		"    <description>Use when encountering any bug</description>\n" +
		"    <location>/home/user/.pi/agent/skills/systematic-debugging/SKILL.md</location>\n" +
		"  </skill>"

	const multiSkillPrompt = [
		"<available_skills>",
		"  <skill>",
		"    <name>brainstorming</name>",
		"    <description>Use before any creative work</description>",
		"    <location>/home/user/.pi/agent/skills/brainstorming/SKILL.md</location>",
		"  </skill>",
		"  <skill>",
		"    <name>writing-plans</name>",
		"    <description>Use when you have a spec</description>",
		"    <location>/home/user/.pi/agent/skills/writing-plans/SKILL.md</location>",
		"  </skill>",
		sampleSkillBlock,
		"</available_skills>",
		"",
		"## Available tools",
		"- read: Read files",
		"- bash: Execute commands",
	].join("\n")

	it("returns prompt unchanged when allowedSkills is ['*']", () => {
		const result = filterSkillsFromPrompt(multiSkillPrompt, ["*"])
		expect(result).toBe(multiSkillPrompt)
	})

	it("returns prompt unchanged when allowedSkills is empty", () => {
		const result = filterSkillsFromPrompt(multiSkillPrompt, [])
		expect(result).toBe(multiSkillPrompt)
	})

	it("returns prompt unchanged when no skill blocks found", () => {
		const plain = "Just a regular prompt without skill blocks."
		const result = filterSkillsFromPrompt(plain, ["brainstorming"])
		expect(result).toBe(plain)
	})

	it("returns prompt unchanged when allowedSkills includes all present skills", () => {
		const result = filterSkillsFromPrompt(multiSkillPrompt, [
			"brainstorming",
			"writing-plans",
			"systematic-debugging",
		])
		expect(result).toBe(multiSkillPrompt)
	})

	it("removes skill blocks not in the allowlist", () => {
		const result = filterSkillsFromPrompt(multiSkillPrompt, [
			"brainstorming",
			"writing-plans",
		])

		// Should still contain the allowed skills
		expect(result).toContain("brainstorming")
		expect(result).toContain("writing-plans")
		// Should NOT contain the filtered skill
		expect(result).not.toContain("systematic-debugging")
		// Should still contain non-skill content
		expect(result).toContain("Available tools")
		// Wrapper tags should still be present (we don't strip <available_skills>)
		expect(result).toContain("<available_skills>")
		expect(result).toContain("</available_skills>")
	})

	it("removes ALL skill blocks when allowedSkills list doesn't match any", () => {
		const result = filterSkillsFromPrompt(multiSkillPrompt, [
			"nonexistent-skill",
		])
		expect(result).not.toContain("<skill>")
		expect(result).not.toContain("</skill>")
		expect(result).not.toContain("brainstorming")
		expect(result).not.toContain("systematic-debugging")
		expect(result).toContain("Available tools")
		// Wrapper stays — caller can decide what to do with empty <available_skills>
		expect(result).toContain("<available_skills>")
		expect(result).toContain("</available_skills>")
	})

	it("handles multiline skill description and content", () => {
		const prompt = [
			"<available_skills>",
			"  <skill>",
			"    <name>multi</name>",
			"    <description>test</description>",
			"    <location>/path/to/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
		].join("\n")
		const result = filterSkillsFromPrompt(prompt, ["multi"])
		expect(result).toBe(prompt)
	})

	it("preserves description and location of kept skills", () => {
		// Ensure we don't accidentally keep just the <name> and lose
		// the description/location lines.
		const result = filterSkillsFromPrompt(multiSkillPrompt, ["brainstorming"])
		expect(result).toContain("Use before any creative work")
		expect(result).toContain("/home/user/.pi/agent/skills/brainstorming/SKILL.md")
		expect(result).not.toContain("Use when you have a spec")
		expect(result).not.toContain("/home/user/.pi/agent/skills/writing-plans/SKILL.md")
	})

	it("handles a realistic mixed prompt (skills + instructions + mode context)", () => {
		const realisticPrompt = [
			"You are a helpful coding assistant...",
			"",
			"<available_skills>",
			"  <skill>",
			"    <name>brainstorming</name>",
			"    <description>Use before any creative work</description>",
			"    <location>/home/user/.pi/agent/skills/brainstorming/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>systematic-debugging</name>",
			"    <description>Debug systematically</description>",
			"    <location>/home/user/.pi/agent/skills/systematic-debugging/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
			"",
			"[ASK MODE ACTIVE] Standard mode...",
			"",
			"## Available tools",
			"- read",
			"- bash",
		].join("\n")

		const result = filterSkillsFromPrompt(realisticPrompt, ["brainstorming"])

		expect(result).toContain("brainstorming")
		expect(result).toContain("Use before any creative work")
		expect(result).not.toContain("systematic-debugging")
		expect(result).not.toContain("Debug systematically")
		expect(result).toContain("[ASK MODE ACTIVE]")
		expect(result).toContain("Available tools")
	})

	it("is a no-op for empty string prompt", () => {
		expect(filterSkillsFromPrompt("", ["brainstorming"])).toBe("")
	})

	it("handles skill name at regex boundary (single char)", () => {
		// Per Agent Skills spec, names are [a-z0-9-] with min length 1
		const prompt = [
			"<available_skills>",
			"  <skill>",
			"    <name>a</name>",
			"    <description>single</description>",
			"    <location>/x/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
		].join("\n")
		const result = filterSkillsFromPrompt(prompt, ["a"])
		expect(result).toBe(prompt)
	})

	it("preserves whitespace between remaining skill blocks", () => {
		const prompt = [
			"<available_skills>",
			"  <skill>",
			"    <name>a</name>",
			"    <description>a</description>",
			"    <location>/a/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>b</name>",
			"    <description>b</description>",
			"    <location>/b/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>c</name>",
			"    <description>c</description>",
			"    <location>/c/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
		].join("\n")
		const result = filterSkillsFromPrompt(prompt, ["a", "c"])
		// Should keep a and c, remove b
		expect(result).toContain("<name>a</name>")
		expect(result).toContain("<name>c</name>")
		expect(result).not.toContain("<name>b</name>")
		expect(result).not.toContain("/b/SKILL.md")
	})

	it("handles consecutive non-skill text correctly", () => {
		const prompt = [
			"Header",
			"",
			"<available_skills>",
			"  <skill>",
			"    <name>skill-a</name>",
			"    <description>a</description>",
			"    <location>/a/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>skill-b</name>",
			"    <description>b</description>",
			"    <location>/b/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
			"",
			"Middle text",
			"",
			"Footer",
		].join("\n")
		const result = filterSkillsFromPrompt(prompt, ["skill-a"])
		expect(result).toContain("Header")
		expect(result).toContain("Middle text")
		expect(result).toContain("Footer")
		expect(result).not.toContain("skill-b")
		expect(result).not.toContain("/b/SKILL.md")
	})

	it("does NOT match the Agent Skills spec attribute format (regression guard)", () => {
		// The bug from v1.1.4: regex matched `<skill name="...">` instead of
		// pi's actual `<skill><name>...</name>...</skill>` schema. This guard
		// ensures the filter does NOT silently pass through skills just
		// because the prompt uses an unrelated format.
		const attrFormatPrompt = [
			"<available_skills>",
			'<skill name="brainstorming" location="/x">',
			"  Brainstorming body",
			"</skill>",
			'<skill name="writing-plans" location="/y">',
			"  Writing plans body",
			"</skill>",
			"</available_skills>",
		].join("\n")
		const result = filterSkillsFromPrompt(attrFormatPrompt, ["brainstorming"])
		// We document the v1.1.5 behavior: the regex is keyed on the <skill>
		// wrapper + child <name> element, so the attribute format is treated
		// as opaque non-matching content. The skill NAMES happen to still be
		// substring-matched by `not.toContain`, but the OUTER <skill name=...>
		// wrappers remain intact. This guards against a regression where the
		// regex silently expands to swallow the wrong format.
		expect(result).toContain('<skill name="brainstorming"')
		expect(result).toContain('<skill name="writing-plans"')
	})

	it("matches the EXACT output of pi's formatSkillsForPrompt (integration)", () => {
		// Verbatim copy of the format emitted by `@earendil-works/
		// pi-coding-agent/dist/core/skills.js:formatSkillsForPrompt`.
		// If pi ever changes this schema, this test must be updated FIRST,
		// then the regex in utils.ts.
		const realFormatPrompt = [
			"",
			"",
			"The following skills provide specialized instructions for specific tasks.",
			"Use the read tool to load a skill's file when the task matches its description.",
			"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
			"",
			"<available_skills>",
			"  <skill>",
			"    <name>brainstorming</name>",
			"    <description>You MUST use this before any creative work</description>",
			"    <location>/home/user/.pi/agent/skills/brainstorming/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>systematic-debugging</name>",
			"    <description>Use when encountering any bug</description>",
			"    <location>/home/user/.pi/agent/skills/systematic-debugging/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>caveman</name>",
			"    <description>Ultra-compressed communication</description>",
			"    <location>/home/user/.pi/agent/skills/caveman/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
			"Current date: 2026-06-29",
			"Current working directory: /home/user/proj",
		].join("\n")

		const result = filterSkillsFromPrompt(realFormatPrompt, [
			"brainstorming",
			"using-superpowers",
			"writing-plans",
		])

		// Allowed skills present
		expect(result).toContain("<name>brainstorming</name>")
		// Disallowed skills removed
		expect(result).not.toContain("<name>systematic-debugging</name>")
		expect(result).not.toContain("<name>caveman</name>")
		expect(result).not.toContain(
			"/home/user/.pi/agent/skills/systematic-debugging/SKILL.md",
		)
		// Non-skill content preserved
		expect(result).toContain("The following skills provide specialized instructions")
		expect(result).toContain("Current date: 2026-06-29")
		expect(result).toContain("Current working directory: /home/user/proj")
		// Wrapper tags preserved (caller decides what to do with empty)
		expect(result).toContain("<available_skills>")
		expect(result).toContain("</available_skills>")
	})
})

describe("injectModePrompt", () => {
	it("injects anchor block and replaces previous block", () => {
		const base = "Base prompt\n"
		const first = injectModePrompt(base, "[Ask] reminder")
		expect(first).toContain("<!-- permission-modes:context -->")
		expect(first).toContain("[Ask] reminder")
		const second = injectModePrompt(first, "[Plan] new")
		expect(second.match(/<!-- permission-modes:context -->/g)?.length).toBe(1)
		expect(second).toContain("[Plan] new")
		expect(second).not.toContain("[Ask] reminder")
	})

	it("returns stripped prompt when mode block is empty", () => {
		const withBlock = injectModePrompt("base", "[Ask] x")
		expect(injectModePrompt(withBlock, "").trimEnd()).toBe("base")
	})
})

describe("resolveModePrompt", () => {
	it("returns ask reminder only when flagged", () => {
		expect(resolveModePrompt({ mode: "ask" })).toBe("")
		expect(
			resolveModePrompt({ mode: "ask", needsAskReminder: true }),
		).toContain("[Ask]")
	})

	it("returns plan path block", () => {
		const block = resolveModePrompt({
			mode: "plan",
			planFilePath: "/tmp/plan.md",
		})
		expect(block).toContain("/tmp/plan.md")
	})

	it("auto has no routine injection", () => {
		expect(resolveModePrompt({ mode: "auto" })).toBe("")
	})
})
