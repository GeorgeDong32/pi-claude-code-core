/*
 * Host-faithful compaction test scaffold (SPEC SC §4.1 H16, task W0).
 *
 * Recipe (verified against pi 1.5.0, 2026-11-09 smoke):
 *   fauxProvider() (pi-ai root export)
 *   + ModelRuntime.create({authPath, modelsPath: null, refreshOnCreate: false})
 *   + runtime.registerNativeProvider(faux.provider)
 *   + createAgentSession({cwd, agentDir, model: faux.getModel(), modelRuntime,
 *       settingsManager, sessionManager: SessionManager.inMemory(), resourceLoader: <stub>})
 *   + session.bindExtensions({})
 * The extension under test (a test-local probe factory — never extensions/
 * production code) is loaded via the TEST-ONLY deep imports
 * createExtensionRuntime/loadExtensionFromFactory (precedent:
 * extensions/effort/tests/integration.test.ts). compat.registerFauxProvider
 * does NOT work here (ModelRuntime reports "no API implementation").
 *
 * Design decisions:
 * - session.prompt() does NOT throw on provider errors (stopReason:"error"
 *   only) — tests must assert stopReason / faux.state.callCount instead.
 * - faux responses may be factories, which is how tests capture the context
 *   of each provider request (S1②⑦, BLK-1 call counting).
 * - The probe records every extension-visible event in arrival order; the
 *   reconcile trigger set (APP-08) is derived from that log.
 * - Every session gets isolated tmp agentDir/cwd; cleanup removes the tree.
 * All fixtures are synthetic (INV-7): no real session content in repo.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxProvider,
	fauxToolCall,
	type AssistantMessage,
	type FauxProviderHandle,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createEventBus,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionFactory,
	type LoadExtensionsResult,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
// Test-only deep imports (loader is not part of the package exports map;
// relative-path resolution bypasses it — the same exception S2's oracle uses).
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

/** Faux model shape knobs — BLK-1/BLK-3 need custom windows/limits. */
export interface FauxModelSpec {
	id?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

/** What the probe records per event: name + optional payload slices. */
export interface RecordedEvent {
	name: string;
	/** turn_end / agent_before_settle outcome, when present. */
	outcome?: string;
	/** session_before_compact reason. */
	reason?: string;
	willRetry?: boolean;
	/** session_compact fromExtension flag. */
	fromExtension?: boolean;
	/** stopReason of the turn_end assistant message. */
	stopReason?: string;
}

export interface ProbeConfig {
	/** Draft entries to return from turn_end (entries appended after event.entries). */
	turnEndDraft?: (event: Record<string, any>, ctx: any) => any[] | undefined;
	/** Draft entries to return from agent_before_settle. */
	beforeSettleDraft?: (event: Record<string, any>, ctx: any) => any[] | undefined;
	/** Optional extra turn_end handlers registered AFTER the draft one (BLK-2 override/append). */
	extraTurnEndHandlers?: Array<(event: Record<string, any>, ctx: any) => any>;
	/** session_before_compact handler (return undefined / {cancel} / {compaction}). */
	beforeCompact?: (event: Record<string, any>, ctx: any) => any;
	/** Extra session_before_compact handler registered after `beforeCompact` (H6 last-wins pin). */
	extraBeforeCompact?: (event: Record<string, any>, ctx: any) => any;
	/** Register the synthetic tool so tool turns can be driven. */
	registerTestTool?: boolean;
	/** Capture getContextUsage() at every event (H7 pin). */
	captureContextUsage?: boolean;
}

export interface CompactionHost {
	session: AgentSession;
	faux: FauxProviderHandle;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	agentDir: string;
	cwd: string;
	/** Ordered extension-visible events (probe). */
	events: RecordedEvent[];
	/** getContextUsage() snapshots keyed by event index (when enabled). */
	contextUsage: Array<ReturnType<AgentSession["getContextUsage"]> | undefined>;
	/** Contexts captured by the faux response factory, one per provider call. */
	requestContexts: Array<{ roles: string[]; texts: string[]; customTypes: string[] }>;
	cleanup(): void;
}

const RECORDED_EVENTS = [
	"session_start",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
	"session_tree",
	"session_shutdown",
	"before_agent_start",
	"agent_start",
	"turn_start",
	"turn_end",
	"agent_end",
	"agent_before_settle",
	"agent_settled",
	"message_start",
	"message_end",
	"input",
	"context",
	"before_provider_request",
] as const;

function stubResourceLoader(extensionsResult: LoadExtensionsResult): ResourceLoader {
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		getSystemPromptSource: () => undefined,
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	} as ResourceLoader;
}

export interface HostOptions {
	model?: FauxModelSpec;
	probe?: ProbeConfig;
	/** Applied via settingsManager.applyOverrides before session creation. */
	settingsOverrides?: Record<string, unknown>;
	/**
	 * Smart Compaction controller: settings written to
	 * <agentDir>/core-compaction.json + PI_CORE_COMPACTION=on before the
	 * factories load; the controller factory joins extraFactories (AFTER the
	 * probe — its H5 position). undefined = no controller (baseline hosts).
	 */
	controllerSettings?: Record<string, unknown>;
	/** C6: PI_CORE_COMPACTION override the host sets (default "on"); pass
	 * null to leave the env unset so controllerSettings.mode decides. */
	envMode?: string | null;
	/** Extra extension factories loaded AFTER the probe. */
	extraFactories?: ExtensionFactory[];
	/** Extra extension factories loaded AFTER the controller (the H5(b)
	 * "later handler overrides/appends" position for BLK-2). */
	postFactories?: ExtensionFactory[];
}

/**
 * Build a real-AgentSession host with a faux provider and a recording probe
 * extension. `responses` are scripted onto the faux provider by the caller
 * (faux.setResponses) — response factories receive the request context and
 * are mirrored into host.requestContexts.
 */
export async function createCompactionHost(options: HostOptions = {}): Promise<CompactionHost> {
	const tempRoot = mkdtempSync(join(tmpdir(), "sc-host-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "cwd");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	const faux = fauxProvider({
		models: [
			{
				id: options.model?.id ?? "faux-1",
				name: "Faux Model",
				reasoning: options.model?.reasoning ?? false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: options.model?.contextWindow ?? 128000,
				maxTokens: options.model?.maxTokens ?? 16384,
			},
		],
	});

	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(faux.provider);

	const settingsManager = SettingsManager.create(cwd, agentDir);
	if (options.settingsOverrides) {
		settingsManager.applyOverrides(options.settingsOverrides as never);
		// SC W4: the controller creates its OWN SettingsManager (H8), which
		// reads DISK — persist the compaction overrides into the agentDir's
		// global settings file so controller-visible thresholds match the
		// host's (applyOverrides stays for the session's own manager).
		if (options.settingsOverrides.compaction) {
			const globalPath = join(agentDir, "settings.json");
			let globalSettings: Record<string, unknown> = {};
			try {
				globalSettings = JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
			} catch {
				/* fresh temp dir */
			}
			writeFileSync(globalPath, JSON.stringify({ ...globalSettings, compaction: options.settingsOverrides.compaction }), "utf8");
		}
	}
	if (options.controllerSettings) {
		// SC W4: the controller resolves its settings file from the agent dir
		// (derived from the session dir below) — write them BEFORE loading.
		writeFileSync(join(agentDir, "core-compaction.json"), JSON.stringify(options.controllerSettings), "utf8");
		if (options.envMode !== null) process.env.PI_CORE_COMPACTION = options.envMode ?? "on";
	}

	// SC W4: disk-backed session dir under the temp agentDir so the controller
	// can derive <agentDir> from getSessionDir() AND the jsonl serialization
	// path is exercised for real (inMemory returned "" for getSessionDir).
	const sessionManager = SessionManager.continueRecent(cwd, join(agentDir, "sessions"));

	const events: RecordedEvent[] = [];
	const contextUsage: CompactionHost["contextUsage"] = [];
	const requestContexts: CompactionHost["requestContexts"] = [];
	const probeConfig: ProbeConfig = options.probe ?? {};

	const probeFactory: ExtensionFactory = (pi: ExtensionAPI) => {
		for (const name of RECORDED_EVENTS) {
			pi.on(name as never, ((event: Record<string, any>, ctx: any) => {
				const record: RecordedEvent = { name };
				if (event?.outcome !== undefined) record.outcome = String(event.outcome);
				if (event?.reason !== undefined) record.reason = String(event.reason);
				if (event?.willRetry !== undefined) record.willRetry = Boolean(event.willRetry);
				if (event?.fromExtension !== undefined) record.fromExtension = Boolean(event.fromExtension);
				if (event?.message?.stopReason !== undefined) record.stopReason = String(event.message.stopReason);
				events.push(record);
				if (probeConfig.captureContextUsage) {
					try {
						contextUsage[events.length - 1] = ctx?.getContextUsage?.();
					} catch {
						contextUsage[events.length - 1] = undefined;
					}
				}
				return undefined;
			}) as never);
		}
		// turn_end draft handler (ours) is registered FIRST, so later core
		// modules and extra handlers can override/append — matching the SC
		// controller's position requirement (ST-06: registered after goal/
		// modes/memory; anything after it can still replace entries, H5).
		if (probeConfig.turnEndDraft) {
			const draft = probeConfig.turnEndDraft;
			pi.on("turn_end" as never, ((event: Record<string, any>, ctx: any) => {
				const entries = draft(event, ctx);
				return entries === undefined ? undefined : { entries: [...(event.entries ?? []), ...entries] };
			}) as never);
		}
		if (probeConfig.beforeSettleDraft) {
			const draft = probeConfig.beforeSettleDraft;
			pi.on("agent_before_settle" as never, ((event: Record<string, any>, ctx: any) => {
				const entries = draft(event, ctx);
				return entries === undefined ? undefined : { entries: [...(event.entries ?? []), ...entries] };
			}) as never);
		}
		for (const handler of probeConfig.extraTurnEndHandlers ?? []) {
			pi.on("turn_end" as never, handler as never);
		}
		if (probeConfig.beforeCompact) {
			const handler = probeConfig.beforeCompact;
			pi.on("session_before_compact" as never, ((event: Record<string, any>, ctx: any) => handler(event, ctx)) as never);
		}
		if (probeConfig.extraBeforeCompact) {
			const handler = probeConfig.extraBeforeCompact;
			pi.on("session_before_compact" as never, ((event: Record<string, any>, ctx: any) => handler(event, ctx)) as never);
		}
		if (probeConfig.registerTestTool) {
			pi.registerTool({
				name: "sc_probe_tool",
				parameters: { type: "object", properties: { value: { type: "string" } } },
				execute: async (args: { value?: string }) => ({
					probe: "ok",
					echo: args?.value ?? "",
				}) as never,
			} as never);
		}
	};

	const eventBus = createEventBus();
	const extensionRuntime = createExtensionRuntime();
	// SC W4: controller factory (non-literal on purpose so the contracts tsc
	// pass cannot resolve it ahead of the module's existence — flip history
	// preserved; now that extensions/compaction/index.ts exists it resolves).
	let controllerFactory: ExtensionFactory | undefined;
	if (options.controllerSettings) {
		const specifier = "./../../../extensions/compaction/index.ts";
		const module = (await import(specifier)) as { default: unknown };
		controllerFactory = module.default as ExtensionFactory;
	}
	const factories = [
		probeFactory,
		...(options.extraFactories ?? []),
		...(controllerFactory ? [controllerFactory] : []),
		...(options.postFactories ?? []),
	];
	const extensions = await Promise.all(
		factories.map((factory, index) =>
			loadExtensionFromFactory(factory as never, cwd, eventBus, extensionRuntime, `<sc-probe-${index}>`),
		),
	);
	const extensionsResult: LoadExtensionsResult = {
		extensions,
		errors: [],
		runtime: extensionRuntime,
	};
	const resourceLoader = stubResourceLoader(extensionsResult);

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		modelRuntime: runtime,
		settingsManager,
		sessionManager,
		resourceLoader,
	});
	await session.bindExtensions({});

	return {
		session,
		faux,
		sessionManager,
		settingsManager,
		agentDir,
		cwd,
		events,
		contextUsage,
		requestContexts,
		cleanup: () => {
			delete process.env.PI_CORE_COMPACTION;
			rmSync(tempRoot, { recursive: true, force: true });
		},
	};
}

/**
 * Script a faux response that also mirrors the request context into
 * host.requestContexts (role list + text prefixes + custom types).
 */
export function contextCapturingResponse(
	host: CompactionHost,
	message: AssistantMessage,
): FauxResponseStep {
	return (context) => {
		const messages = (context as { messages?: Array<Record<string, any>> }).messages ?? [];
		host.requestContexts.push({
			roles: messages.map((m) => String(m.role)),
			texts: messages.map((m) =>
				Array.isArray(m.content)
					? m.content.map((b: any) => String(b.text ?? "")).join(" ").slice(0, 400)
					: String(m.content ?? "").slice(0, 400),
			),
			customTypes: messages.map((m) => String(m.customType ?? "")),
		});
		return message;
	};
}

/** Build a compaction draft entry (SC APP-01 shape, W0 probe version). */
export function compactionDraft(
	summary: string,
	firstKeptEntryId: string,
	details?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		type: "compaction",
		summary,
		firstKeptEntryId,
		details: details ?? { readFiles: [], modifiedFiles: [] },
	};
}

export { fauxToolCall };
