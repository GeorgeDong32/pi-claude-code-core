/**
 * Characterization tests for the plan flow (SPEC SR W-M, E13b + CORE-17).
 *
 * These tests pin the CURRENT plan-mode behavior — agent_end offer flow,
 * cooldown/suppress window, turn_end [DONE:n] marking, plan-complete,
 * /plan-execute, headless plan_ready, session-restore overlay semantics,
 * the exact `modes` entry key order, and the registration-order snapshot —
 * BEFORE the modes/index.ts split moves this state into plan-session.ts.
 * They must stay green unmodified across the split (pure refactor proof).
 *
 * Fake-pi pattern mirrors index.test.ts (compact copy; this file only needs
 * the plan-flow slice of the surface).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import permissionModesExtension from "./index.ts"
import { coreBus, resetCoreBusForTests } from "../../extensions/bus.ts"
import { setConfigPath } from "./config.ts"
import { setModelsPath } from "./profiles.ts"
import { setFooterLine } from "../ui/footer-lines.ts"
import { writePlanFile, getPlanFilePath } from "./plan.ts"
import { customMsg } from "./test-fixtures.ts"

// ---- compact fake pi (mirrors index.test.ts createFakePi) ----------------

type Handler = (...args: any[]) => unknown

function createFakePi() {
	const handlers = new Map<string, Handler[]>()
	const onOrder: string[] = []
	const commands = new Map<string, Handler>()
	const shortcuts = new Map<string, Handler>()
	const tools = new Map<string, { name: string; execute: (...args: any[]) => Promise<unknown> }>()
	const flagOrder: string[] = []
	const userMessages: Array<{ text: string; opts?: unknown }> = []
	const sentMessages: Array<{ message: any; opts?: unknown }> = []
	const appendEntries: Array<{ type: string; data: unknown }> = []
	const widgetCalls: Array<{ key: string; value: unknown }> = []
	const setModelCalls: Array<{ model: unknown }> = []
	const activeTools = ["read", "edit", "write", "bash", "grep", "find"]
	const allTools = activeTools.map((name) => ({
		name,
		description: `fake ${name} tool`,
		exposure: "direct",
		parameters: { type: "object", properties: {} },
		sourceInfo: { path: `fake://${name}`, source: "fake", scope: "user", origin: "top-level" },
	}))
	const flags: Record<string, boolean | string | undefined> = {}
	const registryStore = new Map<string, Map<string, unknown>>()
	let thinkingLevel = "off" as ReturnType<() => string>

	const pi = {
		handlers,
		onOrder,
		commands,
		shortcuts,
		tools,
		flagOrder,
		userMessages,
		sentMessages,
		appendEntries,
		widgetCalls,
		setModelCalls,
		activeTools,
		flags,
		events: { emit: () => {}, on: () => () => {} },
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (l: string) => {
			thinkingLevel = l
		},
		modelRegistry: {
			find: (provider: string, model: string) => registryStore.get(provider)?.get(model),
		},
		on(event: string, handler: Handler) {
			onOrder.push(event)
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
			return () => {
				const current = handlers.get(event)
				if (!current) return
				const idx = current.indexOf(handler)
				if (idx >= 0) current.splice(idx, 1)
			}
		},
		registerCommand(name: string, def: { handler: Handler }) {
			commands.set(name, def.handler)
		},
		registerShortcut(key: string, def: { handler: Handler }) {
			shortcuts.set(key, def.handler)
		},
		registerTool(def: { name: string; execute: (...args: any[]) => Promise<unknown> }) {
			tools.set(def.name, def)
		},
		registerToolRenderer(_resolver: unknown): void {},
		registerFlag(name: string, def: { default?: unknown }) {
			flagOrder.push(name)
			if (def?.default !== undefined) flags[name] = def.default as string
			else if (!(name in flags)) flags[name] = undefined
		},
		getFlag(name: string) {
			return flags[name]
		},
		registerMessageRenderer(_customType: string, _renderer: unknown) {},
		registerMarkdownTransformer(_transformer: unknown) {},
		registerEntryRenderer(_customType: string, _renderer: unknown) {},
		appendEntry(type: string, data: unknown) {
			appendEntries.push({ type, data })
		},
		getSettings: () => ({}) as never,
		registerMcpServer: () => {},
		unregisterMcpServer: () => {},
		getMcpServers: () => [] as never,
		registerVirtualModel: () => ({}) as never,
		unregisterVirtualModel: () => {},
		getActiveTools() {
			return [...activeTools]
		},
		getAllTools() {
			return [...(allTools as never[])]
		},
		setActiveTools(tools: string[]) {
			activeTools.length = 0
			activeTools.push(...tools)
		},
		sendUserMessage(text: string, opts?: unknown) {
			userMessages.push({ text, opts })
		},
		sendMessage(message: unknown, opts?: unknown) {
			sentMessages.push({ message: message as never, opts })
		},
		async setModel(model: unknown) {
			setModelCalls.push({ model })
			return true
		},
		setSessionName(_name: string) {},
		getSessionName() {
			return undefined
		},
		setLabel(_entryId: string, _label: string | undefined) {},
		async exec(): Promise<unknown> {
			return { exitCode: 0, code: 0, killed: false, stdout: "", stderr: "", truncated: false }
		},
		getCommands() {
			return []
		},
		registerProvider(..._args: unknown[]) {},
		unregisterProvider(_name: string) {},

		// Test helpers
		async simulateSessionStart(
			cwd: string,
			ui?: Partial<Parameters<typeof makeCtx>[1]["ui"]>,
			_registry?: unknown,
			sessionManager?: { getEntries?: () => unknown[]; getBranch?: () => unknown[]; getGitBranch?: () => string },
		) {
			const ctx = makeCtx(pi, { cwd, ui, sessionManager })
			for (const h of handlers.get("session_start") ?? []) await h({}, ctx)
		},
		async simulateCommand(name: string, args: string, ctx: unknown) {
			const handler = commands.get(name)
			if (!handler) throw new Error(`No command registered: ${name}`)
			return handler(args, ctx)
		},
	}
	return pi
}

function makeCtx(
	p: any,
	opts: {
		cwd: string
		ui?: {
			select?: (label: string, options: string[]) => Promise<string>
			custom?: (factory: unknown, options?: unknown) => Promise<unknown>
			editor?: (label: string, val: string) => Promise<string | undefined>
		}
		sessionManager?: { getEntries?: () => unknown[]; getBranch?: () => unknown[]; getGitBranch?: () => string }
	},
) {
	const ui = opts.ui ?? {}
	return {
		cwd: opts.cwd,
		hasUI: !!opts.ui,
		modelRegistry: p.modelRegistry,
		ui: {
			select: ui.select ?? (async () => "Block"),
			custom: ui.custom ?? (async () => "stay"),
			notify: () => {},
			editor: ui.editor ?? (async () => undefined),
			setStatus: () => {},
			setWidget: (key: string, value: unknown) => p.widgetCalls.push({ key, value }),
			setFooter: () => {},
			setWorkingIndicator: () => {},
			setWorkingMessage: () => {},
			theme: { fg: (_role: string, text: string) => text, strikethrough: (t: string) => t },
		},
		sessionManager: opts.sessionManager ?? {
			getBranch: () => [],
			getGitBranch: () => "",
			getEntries: () => [],
		},
	}
}

// ---- harness --------------------------------------------------------------

const MODES_ON_SEQUENCE = [
	"tool_call",
	"before_agent_start",
	"context",
	"turn_start",
	"before_provider_request",
	"message_update",
	"message_end",
	"model_select",
	"turn_end",
	"agent_end",
	"session_compact",
	"session_start",
	"session_tree",
	"session_start",
	"session_tree",
	"session_start",
	"session_shutdown",
]

function makePlanBody(steps: string[]): string {
	return `**Plan:**\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
}

async function fireAgentEnd(pi: ReturnType<typeof createFakePi>, event: unknown, ctx: unknown) {
	for (const h of pi.handlers.get("agent_end") ?? []) await h(event, ctx)
}

async function fireTurnEnd(pi: ReturnType<typeof createFakePi>, message: unknown, ctx: unknown) {
	for (const h of pi.handlers.get("turn_end") ?? []) await h({ type: "turn_end", message }, ctx)
}

async function lastModesEntry(pi: ReturnType<typeof createFakePi>): Promise<Record<string, unknown>> {
	const modes = pi.appendEntries.filter((e) => e.type === "modes")
	expect(modes.length).toBeGreaterThan(0)
	return modes[modes.length - 1]!.data as Record<string, unknown>
}

describe("plan flow characterization (SPEC SR W-M)", () => {
	let pi: ReturnType<typeof createFakePi>
	let projDir: string
	let configTmp: string
	let nowMs: number
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let dateSpy: any

	beforeEach(() => {
		resetCoreBusForTests()
		setFooterLine("modes", undefined)
		pi = createFakePi()
		projDir = mkdtempSync(join(tmpdir(), "pm-plan-flow-"))
		configTmp = mkdtempSync(join(tmpdir(), "pm-plan-flow-cfg-"))
		setConfigPath(join(configTmp, "permission-modes.json"))
		writeFileSync(join(configTmp, "permission-modes.json"), JSON.stringify({ classifier: { enabled: false } }))
		setModelsPath(join(configTmp, "model-profiles.json"))
		delete process.env.PERMISSION_MODES_INHERITED_MODE
		nowMs = 1_700_000_000_000
		dateSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs)
	})

	afterEach(() => {
		dateSpy.mockRestore()
		rmSync(projDir, { recursive: true, force: true })
		rmSync(configTmp, { recursive: true, force: true })
	})

	async function switchMode(mode: string) {
		pi.flags["permission-mode"] = mode
		await pi.simulateSessionStart(projDir)
	}

	function uiCtx(ui: Partial<Parameters<typeof makeCtx>[1]["ui"]> = {}) {
		return makeCtx(pi, { cwd: projDir, ui: ui as never })
	}

	function headlessCtx() {
		return makeCtx(pi, { cwd: projDir })
	}

	it("registration-order snapshot: commands, tools, shortcuts, flags, and the 17 pi.on registrations in order", () => {
		permissionModesExtension(pi as never)
		expect(Array.from(pi.commands.keys())).toEqual([
			"model-profile",
			"ask",
			"plan",
			"auto",
			"bypass",
			"permissions",
			"permissions-clear-grants",
			"mode",
			"plan-execute",
			"outside-writes",
			"undo-outside-writes",
		])
		expect(Array.from(pi.tools.keys())).toEqual(["plan_ready"])
		expect(Array.from(pi.shortcuts.keys())).toEqual(["alt+i", "shift+tab"])
		expect(pi.flagOrder).toEqual(["model-profile", "permission-mode"])
		expect(pi.onOrder).toEqual(MODES_ON_SEQUENCE)
		// getToolCallHandler consumers rely on tool_call being the FIRST pi.on.
		expect(pi.onOrder[0]).toBe("tool_call")
	})

	it("modes entry JSON.stringify pins the exact key order", async () => {
		permissionModesExtension(pi as never)
		await pi.simulateSessionStart(projDir)
		// persistState fires on setMode tails and session_compact — force one.
		for (const h of pi.handlers.get("session_compact") ?? []) await h({}, headlessCtx())
		const data = await lastModesEntry(pi)
		expect(Object.keys(data)).toEqual([
			"currentMode",
			"activeProfile",
			"planPhase",
			"planExecuting",
			"planTodos",
			"lastExtractedPlanHash",
		])
		expect(JSON.stringify(data)).toBe(
			'{"currentMode":"ask","planPhase":"exploring","planExecuting":false,"planTodos":[],"lastExtractedPlanHash":""}',
		)
	})

	it("restore: overlay-only — a later entry missing plan fields keeps the earlier in-memory values", async () => {
		permissionModesExtension(pi as never)
		const full = {
			currentMode: "auto",
			activeProfile: undefined,
			planPhase: "executing",
			planExecuting: true,
			planTodos: [{ step: 1, text: "carry this step", completed: false }],
			lastExtractedPlanHash: "hash-1",
		}
		const smFull = { getEntries: () => [customMsg("modes", full)], getBranch: () => [], getGitBranch: () => "" }
		await pi.simulateSessionStart(projDir, undefined, undefined, smFull)
		for (const h of pi.handlers.get("session_compact") ?? []) await h({}, headlessCtx())
		// overlay applied
		const afterFull = await lastModesEntry(pi)
		expect(afterFull).toMatchObject({
			currentMode: "auto",
			planPhase: "executing",
			planExecuting: true,
			lastExtractedPlanHash: "hash-1",
		})
		expect(afterFull.planTodos).toEqual([{ step: 1, text: "carry this step", completed: false }])

		// a later entry with ONLY currentMode must not reset the plan fields
		pi.appendEntries.length = 0
		const smPartial = { getEntries: () => [customMsg("modes", { currentMode: "plan" })], getBranch: () => [], getGitBranch: () => "" }
		await pi.simulateSessionStart(projDir, undefined, undefined, smPartial)
		for (const h of pi.handlers.get("session_compact") ?? []) await h({}, headlessCtx())
		const afterPartial = await lastModesEntry(pi)
		expect(afterPartial).toMatchObject({
			currentMode: "plan",
			planPhase: "executing",
			planExecuting: true,
			lastExtractedPlanHash: "hash-1",
		})
	})

	it("restore: legacy mode-name mapping (normal→default→ask, accept-edits→ask)", async () => {
		permissionModesExtension(pi as never)
		for (const [legacy, expected] of [
			["normal", "ask"],
			["default", "ask"],
			["accept-edits", "ask"],
		] as const) {
			pi.appendEntries.length = 0
			const sm = { getEntries: () => [customMsg("modes", { currentMode: legacy })], getBranch: () => [], getGitBranch: () => "" }
			await pi.simulateSessionStart(projDir, undefined, undefined, sm)
			for (const h of pi.handlers.get("session_compact") ?? []) await h({}, headlessCtx())
			expect(await lastModesEntry(pi)).toMatchObject({ currentMode: expected })
		}
	})

	it("/plan-execute outside plan mode (headless) is refused with a warning and no execution", async () => {
		permissionModesExtension(pi as never)
		await pi.simulateSessionStart(projDir)
		await pi.simulateCommand("plan-execute", "", headlessCtx())
		expect(pi.sentMessages.filter((m) => m.message.customType === "modes-execute")).toHaveLength(0)
		const notices = coreBus().snapshot().notifications ?? []
		expect(notices.some((n) => n.msg.includes("Not in plan mode"))).toBe(true)
	})

	it("/plan-execute runs the plan: raw auto switch, execution block on next turn, [DONE:n] marking, plan-complete", async () => {
		permissionModesExtension(pi as never)
		await switchMode("plan")
		writePlanFile(projDir, makePlanBody(["implement the parser module", "add tests for the parser"]))

		await pi.simulateCommand("plan-execute", "", headlessCtx())

		// execution started: modes-execute followUp with the steps
		const exec = pi.sentMessages.filter((m) => m.message.customType === "modes-execute")
		expect(exec).toHaveLength(1)
		expect(exec[0]!.message.content).toContain("1. Implement the parser module")
		// cleanStepText strips the leading "Add" verb — pin the cleaned form
		expect(exec[0]!.message.content).toContain("2. Tests for the parser")
		expect(exec[0]!.opts).toMatchObject({ triggerTurn: true, deliverAs: "followUp" })
		// raw mode write skipped the capability publish — bus still says plan
		expect(coreBus().snapshot().modes.mode).toBe("plan")
		// tool restrictions restored the pre-plan set (plan_ready gone)
		expect(pi.activeTools).not.toContain("plan_ready")
		const started = await lastModesEntry(pi)
		expect(started).toMatchObject({ currentMode: "auto", planPhase: "executing", planExecuting: true })

		// before_agent_start injects the executing block while executing
		const basHandlers = pi.handlers.get("before_agent_start") ?? []
		const basResult = await basHandlers[0]!({ systemPrompt: "base" }, headlessCtx())
		expect(String((basResult as { systemPrompt?: string })?.systemPrompt)).toContain("[Plan/executing]")
		expect(String((basResult as { systemPrompt?: string })?.systemPrompt)).toContain("Implement the parser module")

		// turn_end marks step 1 done in place and re-publishes the widget
		pi.widgetCalls.length = 0
		pi.appendEntries.length = 0
		await fireTurnEnd(
			pi,
			{ role: "assistant", content: [{ type: "text", text: "Did the first step. [DONE:1]" }] },
			uiCtx(),
		)
		const afterDone = await lastModesEntry(pi)
		expect((afterDone.planTodos as Array<{ step: number; completed: boolean }>)[0]).toMatchObject({ step: 1, completed: true })
		expect((afterDone.planTodos as Array<{ step: number; completed: boolean }>)[1]).toMatchObject({ step: 2, completed: false })
		expect(pi.widgetCalls.some((w) => w.key === "plan-todos")).toBe(true)

		// /plan-execute again WHILE executing is allowed (planExecuting gate);
		// it re-extracts from plan.md, so step 1 is un-marked again.
		pi.sentMessages.length = 0
		await pi.simulateCommand("plan-execute", "", headlessCtx())
		expect(pi.sentMessages.filter((m) => m.message.customType === "modes-execute")).toHaveLength(1)

		// mark both steps in one turn; agent_end announces completion and resets
		await fireTurnEnd(
			pi,
			{ role: "assistant", content: [{ type: "text", text: "Everything finished. [DONE:1] [DONE:2]" }] },
			uiCtx(),
		)
		pi.sentMessages.length = 0
		pi.widgetCalls.length = 0
		pi.appendEntries.length = 0
		await fireAgentEnd(pi, { messages: [] }, uiCtx())
		const complete = pi.sentMessages.filter((m) => m.message.customType === "plan-complete")
		expect(complete).toHaveLength(1)
		const reset = await lastModesEntry(pi)
		expect(reset).toMatchObject({ planExecuting: false, planTodos: [] })
		expect(pi.widgetCalls.some((w) => w.key === "plan-todos" && w.value === undefined)).toBe(true)
	})

	it("agent_end offer flow: hash change opens the dialog; execute switches to execution; refine opens the editor", async () => {
		permissionModesExtension(pi as never)
		await switchMode("plan")
		writePlanFile(projDir, makePlanBody(["implement the parser module", "add tests for the parser"]))

		// 1) execute choice
		const ctxExecute = uiCtx({ custom: async () => "execute" })
		await fireAgentEnd(pi, { messages: [] }, ctxExecute)
		expect(pi.sentMessages.filter((m) => m.message.customType === "modes-execute")).toHaveLength(1)
		expect((await lastModesEntry(pi))).toMatchObject({ currentMode: "auto", planExecuting: true })

		// reset to plan for the refine path
		pi = createFakePi()
		permissionModesExtension(pi as never)
		await switchMode("plan")
		writePlanFile(projDir, makePlanBody(["implement the parser module", "add tests for the parser"]))

		// 2) refine choice — editor text becomes a followUp user message
		let editorTitle = ""
		const ctxRefine = uiCtx({
			custom: async () => "refine",
			editor: async (label: string) => {
				editorTitle = label
				return "please add tests"
			},
		})
		await fireAgentEnd(pi, { messages: [] }, ctxRefine)
		expect(editorTitle).toBe("Refine the plan:")
		expect(pi.userMessages).toEqual([{ text: "please add tests", opts: { deliverAs: "followUp" } }])
	})

	it("agent_end offer cooldown: no re-offer within 60s even when the hash changes; re-offer after 61s", async () => {
		permissionModesExtension(pi as never)
		await switchMode("plan")
		writePlanFile(projDir, makePlanBody(["implement the parser module alone"]))
		let customCalls = 0
		const ctx = uiCtx({
			custom: async () => {
				customCalls++
				return "stay"
			},
		})

		await fireAgentEnd(pi, { messages: [] }, ctx)
		expect(customCalls).toBe(1)

		// content changed but we are inside the 60s window → suppressed
		nowMs += 30_000
		writePlanFile(projDir, makePlanBody(["implement the parser module alone", "add tests for the parser"]))
		await fireAgentEnd(pi, { messages: [] }, ctx)
		expect(customCalls).toBe(1)

		// past the window with a changed hash → dialog opens again
		nowMs += 31_000
		await fireAgentEnd(pi, { messages: [] }, ctx)
		expect(customCalls).toBe(2)
	})

	it("plan_ready headless: reports auto-execute text but does NOT execute", async () => {
		permissionModesExtension(pi as never)
		await switchMode("plan")
		writePlanFile(projDir, makePlanBody(["implement the parser module only"]))

		const result = (await pi.tools.get("plan_ready")!.execute(
			"test-call",
			{ summary: "Ship it" },
			undefined,
			undefined,
			headlessCtx(),
		)) as { content: Array<{ type: string; text: string }> }

		const text = result.content.find((c) => c.type === "text")!.text
		expect(text).toContain("headless auto-execute")
		expect(text).toContain("Implement the parser module only")
		// no execution was triggered
		expect(pi.sentMessages.filter((m) => m.message.customType === "modes-execute")).toHaveLength(0)
		expect(pi.userMessages).toHaveLength(0)
		// state was persisted (planTodos set) but the mode is untouched
		expect(await lastModesEntry(pi)).toMatchObject({ currentMode: "plan", planExecuting: false })
	})

	it("session_start restores an executing plan and re-renders the widget", async () => {
		permissionModesExtension(pi as never)
		const entry = {
			currentMode: "auto",
			activeProfile: undefined,
			planPhase: "executing",
			planExecuting: true,
			planTodos: [{ step: 1, text: "restored step text", completed: false }],
			lastExtractedPlanHash: "",
		}
		const sm = { getEntries: () => [customMsg("modes", entry)], getBranch: () => [], getGitBranch: () => "" }
		await pi.simulateSessionStart(projDir, {}, undefined, sm)
		expect(pi.widgetCalls.some((w) => w.key === "plan-todos" && JSON.stringify(w.value).includes("restored step text"))).toBe(true)
	})

	it("plan mode settled via /plan command creates plan.md (BH-E4 pinned here too)", async () => {
		permissionModesExtension(pi as never)
		await pi.simulateSessionStart(projDir)
		await pi.simulateCommand("plan", "", headlessCtx())
		expect(existsSync(getPlanFilePath(projDir))).toBe(true)
	})
})
