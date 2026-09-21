/**
 * Contract-suite fake host (P0-CT-12).
 *
 * Instantiates extension factories from the REAL packages (P0: the four
 * source packages; P1+: core modules via targets.ts) without booting pi.
 * Shape follows pm's index.test.ts `createFakePi` (plan2 C1 pattern), with
 * the recording surface the contracts need:
 *
 *   - event registry + async fire()
 *   - appendEntry / sendMessage / command / shortcut / flag registries
 *   - setStatus / setWidget call log (P0-CT-07)
 *   - setWorkingMessage call log (P0-CT-02 suppression)
 *   - env snapshot/restore + controllable globalThis cleanup (P0-CT-01..03)
 *
 * The four factories type their `pi` parameter against different installed
 * versions of ExtensionAPI, so `asPi()` intentionally crosses types at the
 * call site; runtime structure is what the contracts pin.
 */

type Handler = (...args: any[]) => unknown;
type CommandHandler = (args: string, ctx: any) => unknown | Promise<unknown>;

export interface StatusCall {
	slot: string;
	value: unknown;
}
export interface WidgetCall {
	key: string;
	value: unknown;
}
export interface SentMessage {
	message: { customType?: string; content?: unknown; display?: boolean };
	opts?: unknown;
}

export interface FakeCtxOptions {
	cwd: string;
	/** Present = hasUI true and ctx.ui methods callable. */
	ui?: boolean;
	sessionEntries?: unknown[];
}

export const CORE_GLOBAL_KEYS = [
	"__piPermissionModes",
	"__pmWorkingStats",
	"__piCcTui",
	"__ccTuiActive",
	"__piClaudeCodeCore",
	"__piClaudeCodeCoreCmd",
] as const;

/** Remove every capability key a core module (or a consumer) may publish. */
export function clearCoreGlobals(): void {
	const g = globalThis as Record<string, unknown>;
	for (const key of CORE_GLOBAL_KEYS) delete g[key];
}

export function snapshotCoreGlobals(): Record<string, unknown> {
	const g = globalThis as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of CORE_GLOBAL_KEYS) if (key in g) out[key] = g[key];
	return out;
}

export function restoreCoreGlobals(snapshot: Record<string, unknown>): void {
	clearCoreGlobals();
	const g = globalThis as Record<string, unknown>;
	for (const [key, value] of Object.entries(snapshot)) g[key] = value;
}

/** Save the given env vars (plus a fixed contract-relevant set). */
export function snapshotEnv(extra: string[] = []): Record<string, string | undefined> {
	const keys = new Set([
		...extra,
		"PERMISSION_MODES_INHERITED_MODE",
		"PI_SUBAGENT_PARENT_SESSION",
	]);
	const out: Record<string, string | undefined> = {};
	for (const key of keys) out[key] = process.env[key];
	return out;
}

export function restoreEnv(snapshot: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(snapshot)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

export class FakeHost {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, CommandHandler>();
	readonly shortcuts = new Map<string, Handler>();
	readonly tools = new Map<string, { name: string; execute: (...args: any[]) => Promise<unknown> }>();
	readonly flags: Record<string, boolean | string | undefined> = {};
	readonly statusCalls: StatusCall[] = [];
	readonly widgetCalls: WidgetCall[] = [];
	readonly workingMessageCalls: Array<unknown[]> = [];
	readonly appendEntries: Array<{ type: string; data: unknown }> = [];
	readonly sentMessages: SentMessage[] = [];
	readonly userMessages: Array<{ text: string; opts?: unknown }> = [];
	readonly notifications: string[] = [];
	/** ToolInfo list returned by getAllTools(); tests may mutate before firing. */
	readonly toolInfos: Array<{ name: string; sourceInfo?: unknown }> = [];
	private thinkingLevel = "off";

	/** Fresh command context wired to this host's recording surface. */
	makeCtx(opts: FakeCtxOptions): Record<string, unknown> {
		const host = this;
		const ui = opts.ui
			? {
					select: async () => "Block",
					custom: async () => null,
					notify: (msg: string) => host.notifications.push(msg),
					editor: async () => undefined,
					setStatus: (slot: string, value: unknown) => host.statusCalls.push({ slot, value }),
					setWidget: (key: string, value: unknown) => host.widgetCalls.push({ key, value }),
					setFooter: () => {},
					setWorkingIndicator: () => {},
					setWorkingMessage: (...args: unknown[]) => host.workingMessageCalls.push(args),
					onTerminalInput: () => () => {},
					theme: {
						fg: (_role: string, text: string) => text,
						bold: (t: string) => t,
						inverse: (t: string) => t,
						strikethrough: (t: string) => t,
					},
				}
			: {};
		return {
			cwd: opts.cwd,
			hasUI: !!opts.ui,
			ui,
			model: undefined,
			modelRegistry: host.piObject().modelRegistry,
			getContextUsage: () => undefined,
			isProjectTrusted: () => false,
			sessionManager: {
				getBranch: () => opts.sessionEntries ?? [],
				getEntries: () => opts.sessionEntries ?? [],
				getGitBranch: () => "",
			},
		};
	}

	/** The fake ExtensionAPI object handed to a factory. */
	piObject(): Record<string, unknown> {
		const host = this;
		return {
			on(event: string, handler: Handler) {
				const list = host.handlers.get(event) ?? [];
				list.push(handler);
				host.handlers.set(event, list);
			},
			registerCommand(name: string, def: { handler: CommandHandler }) {
				host.commands.set(name, def.handler);
			},
			registerShortcut(key: string, def: { handler: Handler }) {
				host.shortcuts.set(key, def.handler);
			},
			registerTool(def: { name: string; execute: (...args: any[]) => Promise<unknown> }) {
				host.tools.set(def.name, def);
			},
			registerFlag(name: string, def: { default?: unknown }) {
				if (def?.default !== undefined) host.flags[name] = def.default as boolean | string;
				else if (!(name in host.flags)) host.flags[name] = undefined;
			},
			getFlag(name: string) {
				return host.flags[name];
			},
			registerMessageRenderer() {},
			registerEntryRenderer() {},
			registerMarkdownTransformer() {},
			appendEntry(type: string, data: unknown) {
				host.appendEntries.push({ type, data });
			},
			sendMessage(message: unknown, opts?: unknown) {
				host.sentMessages.push({ message: message as SentMessage["message"], opts });
			},
			sendUserMessage(text: string, opts?: unknown) {
				host.userMessages.push({ text, opts });
			},
			getActiveTools: () => ["read", "edit", "write", "bash", "grep", "find"],
			getAllTools: () => [...host.toolInfos],
			setActiveTools() {},
			getThinkingLevel: () => host.thinkingLevel,
			setThinkingLevel(level: unknown) {
				host.thinkingLevel = level as never;
			},
			modelRegistry: { find: () => undefined },
			async setModel() {
				return true;
			},
			setSessionName() {},
			getSessionName: () => undefined,
			setLabel() {},
			async exec() {
				return { exitCode: 0, code: 0, killed: false, stdout: "", stderr: "" };
			},
			getCommands: () => [],
			registerProvider() {},
			unregisterProvider() {},
		};
	}

	/** Cross-version adapter: factories see different ExtensionAPI types. */
	asPi(): never {
		return this.piObject() as never;
	}

	/** Invoke every handler registered for an event, awaiting async ones. */
	async fire(event: string, payload: unknown, ctx: Record<string, unknown>): Promise<unknown> {
		let last: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			const result = await handler(payload, ctx);
			if (result !== undefined) last = result;
		}
		return last;
	}

	/** Slots seen in setStatus calls, excluding undefined-valued cleanup writes. */
	statusSlotsSet(): Set<string> {
		return new Set(this.statusCalls.map((c) => c.slot));
	}

	/** All setStatus calls that were cleanup writes (value === undefined). */
	cleanupStatusSlots(): Set<string> {
		return new Set(this.statusCalls.filter((c) => c.value === undefined).map((c) => c.slot));
	}
}

/** Assistant message with usage — feeds pm's working-stats computation. */
export function usageAssistantEntry(input = 1200, output = 300): unknown {
	return {
		type: "message",
		id: "e-assistant",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: {
				input,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.012 },
			},
		},
	};
}
