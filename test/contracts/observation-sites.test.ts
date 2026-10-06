/**
 * OBS-09-SITES contract (registry row in ./README.md): the snapshot's
 * optional `observation.sites` field — display-only per-site savings the
 * TUI flashes per tool row (single-shot semantics, upstream SoL-Pi
 * showSolPiSavings parity).
 *
 * ① End-to-end wiring through the REAL observation-pack extension: the
 *    first-replacement request publishes exactly one sites-carrying patch;
 *    later replacement requests publish nothing (counters stay null).
 * ② Bus shape pin + backward compatibility: an old-shape publisher (no
 *    sites) leaves the field undefined for readers; a sites-carrying
 *    publish is carried verbatim as frozen pure data; the published reader
 *    (`readCoreStatus`) is structurally unaffected — its channel whitelist
 *    does not include observation, before and after.
 */
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearCoreGlobals, FakeHost, restoreCoreGlobals, snapshotCoreGlobals, type Handler } from "./fake-host.ts";
import { targets } from "./targets.ts";
import { coreBus, createCoreBus, getCoreBus, type CoreSnapshot } from "../../extensions/bus.ts";
import { readCoreStatus } from "../../types/core-status.mjs";

type SiteEntry = { tool: string; id: string; avoidedTokens: number; toolCallId?: string };
type ObservationChannel = { tokensAvoided: number; placeholders: number; sites?: ReadonlyArray<SiteEntry> };

function largeToolResult(text: string, toolName: string, toolCallId: string) {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		isError: false,
		content: [{ type: "text", text }],
	} as never;
}

const globalsBackup = snapshotCoreGlobals();

describe("OBS-09-SITES: per-site display-only savings on the capability bus", () => {
	it("① the first-replacement request publishes exactly one sites-carrying patch; later requests publish none", async () => {
		clearCoreGlobals();
		getCoreBus()?.dispose();
		coreBus(); // the extension resolves this exact shared instance

		const host = new FakeHost();
		targets["observation-pack"].factory(host.piObject() as never);
		const root = await mkdtemp(join(tmpdir(), "obs-sites-"));
		// OBS-03 topology with a HEALTHY store: `objects` is a real directory
		// (unlike CON-03, which deliberately blocks it with a file).
		await mkdir(join(root, "observation-pack", "sess-sites", "objects"), { recursive: true });
		const ctx = host.makeCtx({ cwd: root, sessionDir: root, sessionId: "sess-sites" });

		const text = Array.from({ length: 420 }, (_, i) => `row-${i}-${"y".repeat(40)}`).join("\n");
		const messages = [
			largeToolResult(text, "bash", "tc-a"),
			largeToolResult(`${text}#grep-variant`, "grep", "tc-b"),
		];
		const handlers = host.handlers.get("context")! as Handler[];

		// DC5 data-carried subscription: record the observation channel on
		// EVERY publish, so "later requests do not publish sites" is observed
		// as publish events, not as stale snapshot state. The subscription point
		// exists on v2 snapshots — prime the bus with one display no-op publish.
		coreBus().publish({ display: { footer: [] } });
		const onChange = coreBus().snapshot().onChange;
		expect(onChange).toBeTypeOf("function");
		const published: Array<{ revision: number; observation: ObservationChannel | undefined }> = [];
		onChange!(() => {
			const snapshot = coreBus().snapshot() as CoreSnapshot;
			published.push({ revision: snapshot.revision, observation: snapshot.observation as ObservationChannel | undefined });
		});

		// FULL_SENDS full-send requests, then the first-replacement request,
		// then later replacement requests.
		for (let i = 0; i < 8; i += 1) {
			await handlers[0]({ type: "context", messages } as never, ctx as never);
		}

		const observationPatches = published.filter((entry) => entry.observation !== undefined);
		expect(observationPatches.length).toBe(1);
		const patch = observationPatches[0].observation;
		// One site per first-replaced observation; shape and semantics pinned.
		expect(patch!.sites?.length).toBe(2);
		const byTool = new Map(patch!.sites!.map((site) => [site.tool, site]));
		expect(new Set(patch!.sites!.map((site) => site.id)).size).toBe(2);
		for (const site of patch!.sites!) {
			expect(Object.keys(site).sort()).toEqual(["avoidedTokens", "id", "tool", "toolCallId"]);
			expect(site.id).toMatch(/^obs_[0-9a-f]{24}$/u);
			expect(site.avoidedTokens).toBeGreaterThan(0);
		}
		expect(byTool.get("bash")!.tool).toBe("bash");
		expect(byTool.get("bash")!.toolCallId).toBe("tc-a");
		expect(byTool.get("grep")!.tool).toBe("grep");
		expect(byTool.get("grep")!.toolCallId).toBe("tc-b");
		// Cumulative counters ride the same patch (OBS-09 unchanged).
		expect(patch!.placeholders).toBe(2);
		expect(patch!.tokensAvoided).toBe(patch!.sites!.reduce((sum, site) => sum + site.avoidedTokens, 0));
		// Pure-data discipline: the sites array is frozen display-only data.
		expect(Object.isFrozen(patch!.sites)).toBe(true);
		// No publish past the first-replacement request (counters stayed null).
		expect(published[published.length - 1].revision).toBe(observationPatches[0].revision);

		getCoreBus()?.dispose();
		restoreCoreGlobals(globalsBackup);
	});

	it("② old-shape publishers/reader stay compatible: no sites → undefined field; readCoreStatus whitelist untouched", () => {
		clearCoreGlobals();
		getCoreBus()?.dispose();
		const bus = createCoreBus();

		// Old publisher shape (a pre-sites core, or any patch without sites).
		const oldShape = bus.publish({ observation: { tokensAvoided: 5, placeholders: 1 } });
		expect(oldShape.observation).toEqual({ tokensAvoided: 5, placeholders: 1 });
		// Old readers touching the new field get undefined — never a throw.
		expect((oldShape.observation as ObservationChannel | undefined)?.sites).toBeUndefined();
		expect(oldShape.observation?.sites?.map((site) => site.tool) ?? []).toEqual([]);

		// New publisher: sites ride verbatim, frozen.
		const sites: Array<SiteEntry> = [{ tool: "read", id: "obs_0123456789abcdef01234567", avoidedTokens: 2645 }];
		// Pre-toolCallId publisher shape (a17097d-era entry) still fits the
		// channel — toolCallId stays optional and absent readers don't throw.
		expect(sites[0].toolCallId).toBeUndefined();
		const newShape = bus.publish({ observation: { tokensAvoided: 5 + 2645, placeholders: 2, sites } });
		expect(newShape.observation?.sites).toEqual(sites);
		expect(Object.isFrozen(newShape.observation?.sites)).toBe(true);
		expect(newShape.observation?.sites?.[0].avoidedTokens).toBe(2645);

		// The published total reader is structurally unaffected: its channel
		// whitelist never included observation — before AND after this field.
		const status = readCoreStatus(globalThis);
		expect(status).not.toBeNull();
		expect("observation" in status).toBe(false);
		// And the reader never throws on a sites-carrying snapshot host.
		expect(() => readCoreStatus(globalThis)).not.toThrow();

		bus.dispose();
		restoreCoreGlobals(globalsBackup);
	});
});
