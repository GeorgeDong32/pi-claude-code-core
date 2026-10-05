/*
 * AR1005-RC-HOST scenario (contract AR1005-RC-HOST, spec 2026-10-05 §13/§4).
 *
 * Runs the REAL memory extension inside a REAL ExtensionRunner
 * (pi-coding-agent 1.0.1), parks a recall selection, then invalidates the
 * ctx (what session replacement does) and emits session_shutdown, and only
 * THEN lets the controlled selector complete — the abort-ignoring late
 * result. Expected post-fix behavior: no sendMessage, no history access on
 * the stale ctx, and no unhandled rejection.
 *
 * Runs as an ISOLATED subprocess (spec §4.5: the unhandledRejection probe
 * must not install a permanent process-wide safety net into the shared
 * test process) — spawned by pi-host-semantics.test.ts.
 */
process.on("unhandledRejection", (reason) => {
	// The one sanctioned handler, inside this throwaway process only.
	console.log(`SCENARIO_UNHANDLED:${reason instanceof Error ? reason.message : String(reason)}`);
	process.exitCode = 2;
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createExtensionRuntime,
	ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
// Deep-path imports via relative resolution: `loadExtensionFromFactory` /
// `createEventBus` are not re-exported at the package root, and node (which
// may host vitest) enforces the package "exports" map for bare deep
// specifiers — bun does not.
import { loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

import memoryExtension from "../../extensions/memory/index.ts";
import { resolveMemoryPaths } from "../../extensions/memory/paths.ts";
import type { Selector, SelectorOutcome } from "../../extensions/memory/selector.ts";

const home = mkdtempSync(join(tmpdir(), "rc-host-home-"));
const project = mkdtempSync(join(tmpdir(), "rc-host-proj-"));
process.env.HOME = home;
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(
	join(home, ".pi", "agent", "settings.json"),
	JSON.stringify({ memory: { automation: false, recallModel: "test/sel-1", recallWaitMs: 0 } }),
);
// The project memory layer lives under the HOME projects tree, not <cwd>/memory.
const projectMemoryDir = resolveMemoryPaths(project, home).memoryDir;
mkdirSync(projectMemoryDir, { recursive: true });
writeFileSync(join(projectMemoryDir, "a.md"), "---\nname: a\ndescription: convention\nmetadata:\n  type: project\n---\n\nbody of a");

let release: ((outcome: SelectorOutcome) => void) | null = null;
let selectorCalls = 0;
const factory = (): Selector => ({
	select() {
		selectorCalls++;
		return new Promise<SelectorOutcome>((resolve) => {
			release = resolve;
		});
	},
});

const runtime = createExtensionRuntime();
const sent: unknown[] = [];
runtime.sendMessage = ((message: unknown) => {
	sent.push(message);
}) as never;

const extension = await loadExtensionFromFactory(
	(pi) => memoryExtension(pi as never, { selectorFactory: factory }),
	project,
	createEventBus(),
	runtime,
);
const runner = new ExtensionRunner(
	[extension],
	runtime,
	project,
	// The scenario never touches ctx.sessionManager getters before invalidate;
	// readSessionProjection defensively handles absence.
	undefined as never,
	{ getAll: () => [{ provider: "test", id: "sel-1" }] } as never,
);

await runner.emit({ type: "session_start" } as never);
await runner.emit({
	type: "message_end",
	message: { role: "user", content: [{ type: "text", text: "steer message parking a selection now" }] },
} as never);
console.log(`SCENARIO_SELECTOR_CALLS:${selectorCalls}`);

// Session replacement: ctx getters start throwing from here on.
runner.invalidate("session replaced (AR1005-RC-HOST scenario)");
await runner.emit({ type: "session_shutdown", reason: "replaced" } as never);

// The late, abort-ignoring completion — must be dropped silently.
// (Cast: flow analysis can't see the closure assignment, narrowing to null.)
(release as ((outcome: SelectorOutcome) => void) | null)?.({ kind: "selected", keys: ["memory/a.md"], elapsedMs: 1 });
await new Promise((resolve) => setTimeout(resolve, 150));

console.log(`SCENARIO_SENT:${sent.length}`);
console.log("SCENARIO_DONE");
rmSync(home, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
