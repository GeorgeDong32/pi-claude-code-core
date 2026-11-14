/**
 * FX-2 (spec 2026-11-14-followup-small-fixes): manual host model switches
 * (/model command, ctrl+p cycling — any path that does NOT go through the
 * modes profile bracket) reset the thinking level INSIDE the switch:
 *
 *   AgentSession.setModel / _cycleScopedModel / _cycleAvailableModel:
 *     1. agent.state.model = newModel          (synchronous)
 *     2. setThinkingLevel(switch default)      — emits thinking_level_select
 *       synchronously from inside the switch (dist agent-session.js
 *       2115-2125 / 2210-2229)
 *     3. await _emitModelSelect(...)           — model_select arrives last
 *
 * BH-E5 only bracketed the profile-driven path (modes wraps pi.setModel in
 * beginModelSwitch/endModelSwitch). On a manual switch the reset reached the
 * EFF-01 adoption path and became an EXPLICIT choice (source "session"),
 * overriding the user's /effort selection, killing the profile `:effort`
 * mapping, and drifting away from a PI_CORE_EFFORT pin until /effort reset.
 *
 * These tests run the REAL AgentSession (same harness as integration.test.ts)
 * so the host ordering is the production ordering, not a mock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, LoadExtensionsResult, ResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createEventBus,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import effortExtension from "../index.ts";
import { getSharedEffortOwner } from "../../../lib/effort-owner.ts";

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

// Same ladder as reasoningModel but a different id, so setModel treats it as
// a real switch (modelsAreEqual compares provider+id) while every thinking
// level resolves identically — needed for the no-level-change case (⑤).
const reasoningModelAlt: Model<any> = {
  ...reasoningModel,
  id: "minimax/minimax-m2.8",
  name: "MiniMax M2.8",
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

function createResourceLoader(extensionsResult: LoadExtensionsResult): ResourceLoader {
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
  };
}

function makeSessionConfig(factory: (pi: ExtensionAPI) => void) {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-effort-fx2-"));
  const agentDir = join(tempRoot, "agent");
  const cwd = join(tempRoot, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const runtime = createExtensionRuntime();
  const eventBus = createEventBus();
  const extensionPromise = loadExtensionFromFactory(factory, cwd, eventBus, runtime, "<pi-effort-fx2-test>");

  return { tempRoot, agentDir, cwd, previousAgentDir, extensionPromise, runtime, eventBus };
}

async function createTestSession(
  model: Model<any>,
  thinkingLevel: PiThinkingLevel,
  defaultThinkingLevel?: PiThinkingLevel,
  factory: (pi: ExtensionAPI) => void = effortExtension
) {
  const config = makeSessionConfig(factory);
  const extension = await config.extensionPromise;
  const extensionsResult: LoadExtensionsResult = { extensions: [extension], errors: [], runtime: config.runtime };
  const resourceLoader = createResourceLoader(extensionsResult);

  const settingsManager = SettingsManager.create(config.cwd, config.agentDir);
  if (defaultThinkingLevel) {
    settingsManager.applyOverrides({ defaultThinkingLevel });
  }

  const authStorage = AuthStorage.create(join(config.agentDir, "auth.json"));
  await authStorage.modify("openrouter", async () => ({ type: "api_key", key: "test" }));
  const sessionManager = SessionManager.inMemory();

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

  return { session, previousAgentDir: config.previousAgentDir };
}

function cleanupSession(previousAgentDir: string | undefined) {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

/** The effort channel of the capability bus — the user-visible source of truth. */
function busEffort(): { level: string | null; source: string } {
  const snapshot = (globalThis as Record<string, any>).__piClaudeCodeCore;
  return snapshot?.effort ?? { level: null, source: "model-default" };
}

/**
 * effortExtension plus the exact owner call the modes module makes when a
 * mode switch applies a profile's `:effort` (profile-apply.ts:
 * getSharedEffortOwner(pi).setFromProfile(level, activeProfile)). Loaded as
 * ONE factory so both halves share the same ExtensionAPI — the same
 * shared-owner resolution as the production assembly (extensions/index.ts).
 * This is the "next mode switch" of acceptance item ②; the profile config
 * parsing itself is modes-internal and covered by the modes suite.
 */
const effortWithProfileFixture = (pi: ExtensionAPI): void => {
  effortExtension(pi);
  pi.registerCommand("profile-effort-fixture", {
    description: "FX-2 test fixture: apply a profile :effort through the shared owner",
    handler: async () => {
      getSharedEffortOwner(pi).setFromProfile("high", "main");
    },
  });
};

// ─── FX-2 acceptance ①–③: red on the BH-E5 base ─────────────────────

test("FX-2① manual model switch keeps the /effort choice authoritative", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");
  try {
    await session.prompt("/effort high");
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);

    // user switches model via /model or ctrl+p (non-profile path): the host
    // resets thinking to the global switch default ("medium") INSIDE the
    // switch, then emits model_select
    await session.setModel(xhighModel);

    // the reset is the model's switch default, not user intent — the
    // explicit choice must be restored on the new model
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
    assert.equal(busEffort().source, "session");
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("FX-2② profile :effort still applies on the next mode switch after a manual model switch", async () => {
  // start AWAY from the switch default ("medium"): the host only emits
  // thinking_level_select when the level actually changes, so a
  // default-level session would switch silently and never reach the bug
  const { session, previousAgentDir } = await createTestSession(
    reasoningModel,
    "high",
    "medium",
    effortWithProfileFixture
  );
  try {
    // manual model switch — no /effort involvement anywhere in this session
    await session.setModel(xhighModel);

    // the next mode switch applies the profile's :effort through the shared
    // owner; it must win (no explicit slot was created by the switch)
    await session.prompt("/profile-effort-fixture");
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
    assert.equal(busEffort().source, "profile");
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("FX-2③ PI_CORE_EFFORT pin is restored after a manual model switch", async () => {
  const previousPin = process.env.PI_CORE_EFFORT;
  process.env.PI_CORE_EFFORT = "high";
  try {
    const { session, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");
    try {
      assert.equal(session.thinkingLevel, "high" as ThinkingLevel);

      await session.setModel(xhighModel);

      // the host reset to "medium" must not leave the level off the pin
      assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
      assert.equal(busEffort().source, "env");
    } finally {
      cleanupSession(previousAgentDir);
    }
  } finally {
    if (previousPin === undefined) {
      delete process.env.PI_CORE_EFFORT;
    } else {
      process.env.PI_CORE_EFFORT = previousPin;
    }
  }
});

// ─── FX-2 acceptance ④–⑤: anti-false-positive, green on base ─────────

test("FX-2④ without a model switch, cycleThinkingLevel still adopts as explicit", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");
  try {
    const before = session.thinkingLevel;
    const next = session.cycleThinkingLevel();
    assert.ok(next !== undefined, "reasoning model supports cycling");
    assert.equal(session.thinkingLevel, next as ThinkingLevel);
    assert.notEqual(session.thinkingLevel, before);
    // a genuine user action through the host keybinding stays an explicit
    // adoption (EFF-01 unchanged)
    assert.equal(busEffort().source, "session");
    assert.equal(busEffort().level, next as string);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("FX-2⑤ manual switch without a level change (no thinking event): a later user cycle still adopts", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");
  try {
    // the switch default resolves to the global default "medium" — the same
    // level the session already runs at — so the host emits NO
    // thinking_level_select for this switch
    await session.setModel(reasoningModelAlt);
    assert.equal(session.thinkingLevel, "medium" as ThinkingLevel);

    const next = session.cycleThinkingLevel();
    assert.ok(next !== undefined, "reasoning model supports cycling");
    assert.notEqual(session.thinkingLevel, "medium");
    // the cycle after the silent switch is still user intent → explicit
    assert.equal(busEffort().source, "session");
    assert.equal(busEffort().level, next as string);
  } finally {
    cleanupSession(previousAgentDir);
  }
});
