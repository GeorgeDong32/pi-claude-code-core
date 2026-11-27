import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearCoreGlobals, FakeHost, restoreCoreGlobals, snapshotCoreGlobals, type Handler } from "./fake-host.ts";
import { targets } from "./targets.ts";
import { coreBus, createCoreBus, getCoreBus, type CoreSnapshot } from "../../extensions/bus.ts";

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
		coreBus();

		const host = new FakeHost();
		targets["observation-pack"].factory(host.piObject() as never);
		const root = await mkdtemp(join(tmpdir(), "obs-sites-"));
		await mkdir(join(root, "observation-pack", "sess-sites", "objects"), { recursive: true });
		const ctx = host.makeCtx({ cwd: root, sessionDir: root, sessionId: "sess-sites" });

		const text = Array.from({ length: 420 }, (_, i) => `row-${i}-${"y".repeat(40)}`).join("\n");
		const messages = [
			largeToolResult(text, "bash", "tc-a"),
			largeToolResult(`${text}#grep-variant`, "grep", "tc-b"),
		];
		const handlers = host.handlers.get("context")! as Handler[];

		coreBus().publish({ display: { footer: [] } });
		const onChange = coreBus().snapshot().onChange;
		expect(onChange).toBeTypeOf("function");
		const published: Array<{ revision: number; observation: ObservationChannel | undefined }> = [];
		onChange!(() => {
			const snapshot = coreBus().snapshot() as CoreSnapshot;
			published.push({ revision: snapshot.revision, observation: snapshot.observation as ObservationChannel | undefined });
		});

		for (let i = 0; i < 8; i += 1) {
			await handlers[0]({ type: "context", messages } as never, ctx as never);
		}

		const observationPatches = published.filter((entry) => entry.observation !== undefined);
		expect(observationPatches.length).toBe(1);
		const patch = observationPatches[0].observation;
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
		expect(patch!.placeholders).toBe(2);
		expect(patch!.tokensAvoided).toBe(patch!.sites!.reduce((sum, site) => sum + site.avoidedTokens, 0));
		expect(Object.isFrozen(patch!.sites)).toBe(true);
		expect(published[published.length - 1].revision).toBe(observationPatches[0].revision);

		getCoreBus()?.dispose();
		restoreCoreGlobals(globalsBackup);
	});

	it("② old-shape publishers stay compatible: no sites → undefined field", () => {
		clearCoreGlobals();
		getCoreBus()?.dispose();
		const bus = createCoreBus();

		const oldShape = bus.publish({ observation: { tokensAvoided: 5, placeholders: 1 } });
		expect(oldShape.observation).toEqual({ tokensAvoided: 5, placeholders: 1 });
		expect((oldShape.observation as ObservationChannel | undefined)?.sites).toBeUndefined();
		expect(oldShape.observation?.sites?.map((site) => site.tool) ?? []).toEqual([]);

		const sites: Array<SiteEntry> = [{ tool: "read", id: "obs_0123456789abcdef01234567", avoidedTokens: 2645 }];
		expect(sites[0].toolCallId).toBeUndefined();
		const newShape = bus.publish({ observation: { tokensAvoided: 5 + 2645, placeholders: 2, sites } });
		expect(newShape.observation?.sites).toEqual(sites);
		expect(Object.isFrozen(newShape.observation?.sites)).toBe(true);
		expect(newShape.observation?.sites?.[0].avoidedTokens).toBe(2645);

		bus.dispose();
		restoreCoreGlobals(globalsBackup);
	});
});
