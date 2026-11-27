import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHost } from "./fake-host.ts";
import coreExtension from "../../extensions/index.ts";

const ENTRY_TYPE = "cc-core-memory-stats";
const FIELDS = ["v", "indexBytes", "indexRows", "descTooLong", "memoryReads", "lookups", "searches", "recallInjections", "descRewritten"].sort();

describe("ME-STAT-01: memory stats entry", () => {
	it("appends exactly one entry per agent run with the frozen type and field set, all numbers", async () => {
		const host = new FakeHost();
		await coreExtension(host.piObject() as never);
		const sessionDir = mkdtempSync(join(tmpdir(), "memory-stats-sess-"));
		const ctx = host.makeCtx({ cwd: process.cwd(), sessionDir, sessionId: "sess-memory-stats", ui: true });
		await host.fire("session_start", {}, ctx);
		await host.fire("agent_end", { messages: [] }, ctx);
		const ours = host.appendEntries.filter((e) => e.type === ENTRY_TYPE);
		expect(ours.length).toBe(1);
		const data = ours[0]!.data as Record<string, unknown>;
		expect(Object.keys(data).sort()).toEqual(FIELDS);
		expect(data.v).toBe(1);
		for (const key of FIELDS) expect(typeof data[key], key).toBe("number");
		await host.fire("agent_end", { messages: [] }, ctx);
		expect(host.appendEntries.filter((e) => e.type === ENTRY_TYPE).length).toBe(2);
	});
});
