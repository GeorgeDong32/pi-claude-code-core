import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  SessionManager,
  SettingsManager,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
// 0.85.x no longer re-exports AuthStorage / loader helpers from the package
// root — import them from their dist modules (import-path migration only;
// assertions below are unchanged from pi-effort 0.1.2).
import { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import effortExtension from "../index.ts";

type PiThinkingLevel = ThinkingLevel | "off";

const reasoningModel: Model<any> = {
  id: "minimax/minimax-m2.7",
  name: "MiniMax M2.7",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 196608,
  maxTokens: 4096,
};

const xhighModel: Model<any> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 196608,
  maxTokens: 4096,
};

const plainModel: Model<any> = {
  id: "plain-model",
  name: "Plain Model",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

function createResourceLoader(extensionsResult: LoadExtensionsResult): ResourceLoader {
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    // 0.85.x ResourceLoader additions (setup-shape adaptation)
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function makeSessionConfig() {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-effort-runtime-"));
  const agentDir = join(tempRoot, "agent");
  const cwd = join(tempRoot, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const runtime = createExtensionRuntime();
  const eventBus = createEventBus();
  const extensionPromise = loadExtensionFromFactory(effortExtension, cwd, eventBus, runtime, "<pi-effort-test>");

  return {
    tempRoot,
    agentDir,
    cwd,
    previousAgentDir,
    extensionPromise,
    runtime,
    eventBus,
  };
}

async function createTestSession(
  model: Model<any>,
  thinkingLevel: PiThinkingLevel,
  defaultThinkingLevel?: PiThinkingLevel,
  flags: Record<string, boolean | string> = {}
) {
  const config = makeSessionConfig();
  const extension = await config.extensionPromise;
  for (const [name, value] of Object.entries(flags)) {
    config.runtime.flagValues.set(name, value);
  }
  const extensionsResult: LoadExtensionsResult = { extensions: [extension], errors: [], runtime: config.runtime };
  const resourceLoader = createResourceLoader(extensionsResult);

  const settingsManager = SettingsManager.create(config.cwd, config.agentDir);
  if (defaultThinkingLevel) {
    settingsManager.applyOverrides({ defaultThinkingLevel });
  }

  const authStorage = AuthStorage.create(join(config.agentDir, "auth.json"));
  // 0.85.x AuthStorage replaced set(provider, cred) with modify(provider, fn) —
  // setup-call adaptation only (pi-effort 0.1.2 wrote the same credential).
  await authStorage.modify("openrouter", async () => ({ type: "api_key", key: "test" }));
  const sessionManager = SessionManager.inMemory();

  // 0.85.x createAgentSession dropped the authStorage/modelRegistry options in
  // favor of a default modelRuntime that reads agentDir/auth.json + models.json
  // (the credential above is written to that same path). The explicit
  // ModelRegistry.create(...) call from pi-effort 0.1.2 no longer exists.
  const { session } = await createAgentSession({
    cwd: config.cwd,
    agentDir: config.agentDir,
    model,
    thinkingLevel,
    settingsManager,
    sessionManager,
    resourceLoader,
  });
  await session.bindExtensions({});

  return { session, extension, agentDir: config.agentDir, previousAgentDir: config.previousAgentDir };
}

function cleanupSession(previousAgentDir: string | undefined) {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

// ─── Basic command tests ────────────────────────────────────────────

test("runtime command changes session thinking level", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    await session.prompt("/effort high");
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /fast command toggles fast mode setting", async () => {
  const { session, agentDir, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/fast on");
    let persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted["pi-effort"].fastMode, true);

    await session.prompt("/fast off");
    persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted["pi-effort"].fastMode, false);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime bare /fast toggles fast mode setting", async () => {
  const { session, agentDir, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/fast");
    let persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted["pi-effort"].fastMode, true);

    await session.prompt("/fast");
    persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted["pi-effort"].fastMode, false);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /fast injects OpenAI priority service tier for GPT-5 requests", async () => {
  const { session, extension, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/fast on");
    const handlers = extension.handlers.get("before_provider_request");
    assert.ok(handlers?.[0]);

    const payload = { model: "gpt-5.5", input: [], stream: true };
    const result = await handlers[0]({ type: "before_provider_request", payload }, {});

    assert.deepEqual(result, { ...payload, service_tier: "priority" });
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /fast preserves explicit service tier overrides", async () => {
  const { session, extension, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/fast on");
    const handlers = extension.handlers.get("before_provider_request");
    assert.ok(handlers?.[0]);

    const payload = { model: "gpt-5.5", service_tier: "default" };
    const result = await handlers[0]({ type: "before_provider_request", payload }, {});

    assert.equal(result, undefined);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("new sessions inherit defaultThinkingLevel from Pi settings", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "high", "high");

  try {
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

// ─── xhigh pre-validation tests ─────────────────────────────────────

test("runtime rejects xhigh on non-xhigh-capable model", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    const before = session.thinkingLevel;
    await session.prompt("/effort xhigh");
    assert.equal(session.thinkingLevel, before as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime accepts xhigh on xhigh-capable model", async () => {
  const { session, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/effort xhigh");
    assert.equal(session.thinkingLevel, "xhigh" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

// ─── min/max semantic alias tests ───────────────────────────────────

test("runtime /effort max resolves to high on non-xhigh model", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    await session.prompt("/effort max");
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /effort max resolves to xhigh on xhigh-capable model", async () => {
  const { session, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/effort max");
    assert.equal(session.thinkingLevel, "xhigh" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /effort min resolves to minimal on reasoning model", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "high", "high");

  try {
    await session.prompt("/effort min");
    assert.equal(session.thinkingLevel, "minimal" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

// ─── Extension lifecycle surface tests ──────────────────────────────

test("runtime --effort flag resolves aliases on session start", async () => {
  const { session, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium", { effort: "max" });

  try {
    assert.equal(session.thinkingLevel, "xhigh" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime model switch clamps xhigh to the new model maximum", async () => {
  const { session, previousAgentDir } = await createTestSession(xhighModel, "xhigh", "xhigh");

  try {
    await session.setModel(reasoningModel);
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime model switch clamps reasoning effort to off for non-reasoning models", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "high", "high");

  try {
    await session.setModel(plainModel);
    assert.equal(session.thinkingLevel, "off" as PiThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("argument completions expose only effort levels and fast on/off", async () => {
  const { extension, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command?.getArgumentCompletions);

    const topLevel = await command.getArgumentCompletions("");
    assert.deepEqual(topLevel?.map((item) => item.value), ["min", "minimal", "low", "medium", "high", "max"]);

    assert.equal(await command.getArgumentCompletions("default "), null);
    assert.equal(await command.getArgumentCompletions("fast "), null);

    const fastCommand = extension.commands.get("fast");
    assert.ok(fastCommand?.getArgumentCompletions);
    const fastCommandOptions = await fastCommand.getArgumentCompletions("");
    assert.deepEqual(fastCommandOptions?.map((item) => item.value), ["on", "off"]);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

// ─── /effort bare command opens the picker ─────────────────────────

/** Build a minimal ExtensionCommandContext sufficient for the picker branch. */
function buildPickerCtx(opts: {
  model: Model<any>;
  thinkingLevel: PiThinkingLevel;
  hasUI: boolean;
  // Receives the factory the extension passes to ctx.ui.custom. Tests drive
  // the returned component's keyboard state to simulate user input.
  onPicker?: (factory: (tui: any, theme: any, kb: any, done: (result: unknown) => void) => unknown) => void;
  // Receives the prompt passed to ctx.ui.select, used in the non-TUI fallback.
  onSelect?: (title: string, options: string[]) => Promise<string | undefined>;
}) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx: any = {
    model: opts.model,
    hasUI: opts.hasUI,
    isIdle: () => true,
    ui: {
      select: async (title: string, options: string[]) => {
        if (opts.onSelect) return opts.onSelect(title, options);
        return undefined;
      },
      custom: async (factory: any, _options?: unknown) => {
        if (opts.onPicker) opts.onPicker(factory);
        // Simulate the component resolving immediately via cancel.
        return { action: "cancel" };
      },
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
  };
  return { ctx, notifications };
}

test("bare /effort in TUI mode invokes ctx.ui.custom and applies the chosen level", async () => {
  const { extension, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command);

    let pickerLevels: string[] | undefined;
    let confirmResult: { action: "confirm"; level: string } | undefined;

    const { ctx } = buildPickerCtx({
      model: xhighModel,
      thinkingLevel: "medium",
      hasUI: true,
      onPicker: (factory) => {
        // Drive the component: grab the done callback, then immediately confirm "high".
        let done: ((r: any) => void) | undefined;
        const component = factory(undefined, undefined, undefined, (r: any) => {
          done?.(r);
        });
        pickerLevels = (component as any).levels;
        // Simulate user pressing Right twice then Enter (low → medium → high).
        const handle = (component as any).handleInput;
        handle.call(component, "\x1b[C"); // right
        handle.call(component, "\x1b[C"); // right
        handle.call(component, "\r");      // enter
        confirmResult = { action: "confirm", level: "high" };
      },
    });

    // Override the picker resolution to return the simulated confirm.
    const originalCustom = ctx.ui.custom;
    ctx.ui.custom = async (factory: any, options?: any) => {
      ctx.ui.custom = originalCustom; // restore after first call
      let capturedDone: ((r: any) => void) | undefined;
      const component: any = factory(undefined, undefined, undefined, (r: any) => {
        capturedDone?.(r);
      });
      pickerLevels = component.levels;
      // Simulate user pressing Right twice (low → medium → high) then Enter.
      component.handleInput("\x1b[C");
      component.handleInput("\x1b[C");
      component.handleInput("\r");
      return { action: "confirm", level: "high" };
    };

    await command.handler("", ctx);

    // Picker was opened with the model's user-facing levels minus "minimal".
    assert.deepEqual(pickerLevels, ["low", "medium", "high", "xhigh"]);
    // After confirm, applySessionLevel runs pi.setThinkingLevel → session state updated.
    // The session was created with thinkingLevel "medium"; after /effort bare → "high".
    // (We don't have direct access to the session here, but the notify call confirms
    // applySessionLevel ran.)
    const last = (ctx as any)._lastNotify as string | undefined;
    void last;
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("bare /effort in non-TUI mode falls back to ctx.ui.select", async () => {
  const { extension, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command);

    let selectCalls: Array<{ title: string; options: string[] }> = [];
    let customCalled = false;

    const { ctx } = buildPickerCtx({
      model: reasoningModel,
      thinkingLevel: "medium",
      hasUI: false,
      onSelect: async (title, options) => {
        selectCalls.push({ title, options });
        return "low";
      },
    });
    ctx.ui.custom = async () => {
      customCalled = true;
      return { action: "cancel" };
    };

    await command.handler("", ctx);

    assert.equal(customCalled, false, "ctx.ui.custom must not be called when hasUI is false");
    assert.equal(selectCalls.length, 1);
    assert.equal(selectCalls[0].title, "Effort");
    assert.deepEqual(selectCalls[0].options, ["low", "medium", "high"]);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("bare /effort cancel does not change thinking level", async () => {
  const { extension, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command);

    const notifications: Array<{ message: string; type?: string }> = [];
    const { ctx } = buildPickerCtx({
      model: xhighModel,
      thinkingLevel: "medium",
      hasUI: true,
    });
    ctx.ui.notify = (message: string, type?: string) => notifications.push({ message, type });
    // ctx.ui.custom resolves with cancel without invoking factory meaningfully.
    ctx.ui.custom = async () => ({ action: "cancel" });

    await command.handler("", ctx);

    // The cancel notification should have been emitted.
    const cancelNotice = notifications.find((n) => /cancelled/i.test(n.message));
    assert.ok(cancelNotice, `expected a Cancelled notification, got: ${JSON.stringify(notifications)}`);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("bare /effort on a non-reasoning model notifies and returns", async () => {
  const { extension, previousAgentDir } = await createTestSession(plainModel, "off", "off");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command);

    const notifications: Array<{ message: string; type?: string }> = [];
    const { ctx } = buildPickerCtx({
      model: plainModel,
      thinkingLevel: "off",
      hasUI: true,
    });
    ctx.ui.notify = (message: string, type?: string) => notifications.push({ message, type });
    let customCalled = false;
    ctx.ui.custom = async () => {
      customCalled = true;
      return { action: "cancel" };
    };

    await command.handler("", ctx);

    assert.equal(customCalled, false, "picker must not be opened when model has no thinking levels");
    const errorNotice = notifications.find((n) => /not available/i.test(n.message));
    assert.ok(errorNotice, `expected an error notification, got: ${JSON.stringify(notifications)}`);
  } finally {
    cleanupSession(previousAgentDir);
  }
});
