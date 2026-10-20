/**
 * B4 (cherry-batch3 spec) declaration meter + /core exposure tests.
 * Fixtures are SELF-MADE with statically expected byte lengths (the recon
 * numbers belong to the recon report only); MCP names use the as-declared
 * `mcp__<server>__<tool>` form.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDeclarationMeter } from "../../extensions/mcp-gov/declaration-meter.ts";

afterEach(() => {
	// restore the test HOME seam (code-review R1 P2: the old version deleted
	// a variable nothing ever set and leaked PI_B4_TEST_HOME across files)
	delete process.env.PI_B4_TEST_HOME;
});

describe("B4-F1 declaration meter", () => {
	it("F1-1: exact-byte bucketing with a self-made fixture (flat dialect)", () => {
		const exa1 = { type: "function", function: { name: "mcp__exa__search", parameters: { a: 1 } } };
		const exa2 = { type: "function", function: { name: "mcp__exa__fetch", parameters: { b: 2 } } };
		const coreTool = { type: "function", function: { name: "TaskList", parameters: {} } };
		const otherTool = { type: "function", function: { name: "read", parameters: {} } };
		const meter = createDeclarationMeter();
		meter.observe({ tools: [exa1, exa2, coreTool, otherTool] });
		const snap = meter.last()!;
		expect(snap.toolCount).toBe(4);
		expect(snap.perServer.exa).toBe(JSON.stringify(exa1).length + JSON.stringify(exa2).length);
		expect(snap.perClass.mcp).toBe(snap.perServer.exa);
		expect(snap.perClass.core).toBe(JSON.stringify(coreTool).length);
		expect(snap.perClass.other).toBe(JSON.stringify(otherTool).length);
		expect(snap.totalBytes).toBe(snap.perClass.mcp + snap.perClass.core + snap.perClass.other);
		expect(snap.maxBytes).toBe(snap.totalBytes);
	});

	it("F1-2a: payload without tools / non-array / null — silently skipped (fail-open)", () => {
		const meter = createDeclarationMeter();
		expect(() => meter.observe({ model: "x" })).not.toThrow();
		expect(() => meter.observe({ tools: null })).not.toThrow();
		expect(() => meter.observe(null)).not.toThrow();
		expect(meter.last()).toBeNull();
	});

	it("F1-2b: Bedrock toolConfig.tools + name field dialects", () => {
		const bedrockTool = { toolSpec: { name: "mcp__exa__search", inputSchema: { a: 1 } } };
		const meter = createDeclarationMeter();
		meter.observe({ toolConfig: { tools: [bedrockTool] } });
		const snap = meter.last()!;
		expect(snap.toolCount).toBe(1);
		expect(snap.perServer.exa).toBe(JSON.stringify(bedrockTool).length);
	});

	it("F1-2c: Google nested functionDeclarations expand", () => {
		const fd = { name: "mcp__exa__search", parameters: { a: 1 } };
		const meter = createDeclarationMeter();
		meter.observe({ tools: [{ functionDeclarations: [fd] }] });
		const snap = meter.last()!;
		expect(snap.toolCount).toBe(1);
		expect(snap.perServer.exa).toBe(JSON.stringify(fd).length);
	});

	it("F1-3: two observations — last() is the newest snapshot; maxBytes is the historical max", () => {
		const big = { type: "function", function: { name: "mcp__exa__x", parameters: { pad: "x".repeat(500) } } };
		const small = { type: "function", function: { name: "read", parameters: {} } };
		const meter = createDeclarationMeter();
		meter.observe({ tools: [big] });
		meter.observe({ tools: [small] });
		const snap = meter.last()!;
		expect(snap.toolCount).toBe(1);
		expect(snap.perClass.other).toBe(JSON.stringify(small).length);
		expect(snap.maxBytes).toBeGreaterThanOrEqual(JSON.stringify(big).length);
	});
});

describe("B4-F2 /core exposure wiring (switchExposure behavior via module import)", () => {
	it("F2-1: exposure is written atomically; unrelated servers and unknown top-level keys survive verbatim", async () => {
		const dir = mkdtempSync(join(tmpdir(), "b4-f2-"));
		try {
			const home = join(dir, "home");
			const globalPath = join(home, ".pi", "agent", "mcp.json");
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			writeFileSync(
				globalPath,
				JSON.stringify({
					mcpServers: {
						exa: { url: "https://mcp.exa.ai/mcp", exposure: "direct" },
						other: { command: "x", env: { TOKEN: "secret" } },
					},
					topLevelUnknown: { keep: true },
				}),
				{ flag: "w" },
			);
			const { switchExposure } = await import("../../extensions/mcp-gov/index.ts");
			process.env.PI_B4_TEST_HOME = home;
			const result = switchExposure(["exposure", "exa", "codemode"], { cwd: join(dir, "proj") } as never);
			expect(result).toContain("codemode");
			expect(result).toMatch(/reload|restart/);
			const after = JSON.parse(readFileSync(globalPath, "utf8"));
			expect(after.mcpServers.exa.exposure).toBe("codemode");
			expect(after.mcpServers.other.env.TOKEN).toBe("secret"); // unrelated server verbatim
			expect(after.topLevelUnknown).toEqual({ keep: true }); // unknown top-level key survives
			expect(readdirSync(join(home, ".pi", "agent")).filter((f) => f.includes(".tmp"))).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("F2-2: bad tier / unknown server / project-level override — error lines, file byte-identical; alias normalizes to codemode (real calls)", async () => {
		const { switchExposure } = await import("../../extensions/mcp-gov/index.ts");
		const dir = mkdtempSync(join(tmpdir(), "b4-f2b-"));
		try {
			const home = join(dir, "home");
			const agentDir = join(home, ".pi", "agent");
			const globalPath = join(agentDir, "mcp.json");
			mkdirSync(agentDir, { recursive: true });
			const original = JSON.stringify({
				mcpServers: { exa: { url: "https://mcp.exa.ai/mcp", exposure: "direct" } },
			});
			writeFileSync(globalPath, original);
			process.env.PI_B4_TEST_HOME = home;
			const projDir = join(dir, "proj");
			mkdirSync(projDir, { recursive: true });
			const ctx = { cwd: projDir } as never;

			// bad tier
			const badTier = switchExposure(["exposure", "exa", "bogus"], ctx);
			expect(badTier).toContain("unknown tier");
			expect(readFileSync(globalPath, "utf8")).toBe(original);
			// unknown server
			const badServer = switchExposure(["exposure", "nope", "codemode"], ctx);
			expect(badServer).toContain("not found");
			expect(readFileSync(globalPath, "utf8")).toBe(original);

			// alias normalizes to codemode and lands on disk as "codemode"
			const aliased = switchExposure(["exposure", "exa", "codemode-deferred"], ctx);
			expect(aliased).toContain("codemode");
			const afterAlias = JSON.parse(readFileSync(globalPath, "utf8"));
			expect(afterAlias.mcpServers.exa.exposure).toBe("codemode");

			// project-level override refuses to write the global file
			writeFileSync(globalPath, original);
			mkdirSync(join(projDir, ".pi"), { recursive: true });
			writeFileSync(
				join(projDir, ".pi", "mcp.json"),
				JSON.stringify({ mcpServers: { exa: { exposure: "direct" } } }),
			);
			const refused = switchExposure(["exposure", "exa", "codemode"], ctx);
			expect(refused).toContain("project-level");
			expect(readFileSync(globalPath, "utf8")).toBe(original);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("F2-3: missing/malformed mcp.json — error line, no crash, nothing written", async () => {
		const { switchExposure } = await import("../../extensions/mcp-gov/index.ts");
		const dir = mkdtempSync(join(tmpdir(), "b4-f2c-"));
		try {
			const agentDir = join(dir, "home", ".pi", "agent");
			mkdirSync(agentDir, { recursive: true });
			process.env.PI_B4_TEST_HOME = join(dir, "home");
			// missing
			const missing = switchExposure(["exposure", "exa", "codemode"], { cwd: dir } as never);
			expect(missing).toContain("not found");
			expect(existsSync(join(agentDir, "mcp.json"))).toBe(false);
			// malformed
			writeFileSync(join(agentDir, "mcp.json"), "{not json");
			const malformed = switchExposure(["exposure", "exa", "codemode"], { cwd: dir } as never);
			expect(malformed).toContain("not found");
			expect(readFileSync(join(agentDir, "mcp.json"), "utf8")).toBe("{not json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("F1-4: /core panel renders the declarations line in BOTH live and static states", async () => {
		const { renderMcpPanel } = await import("../../extensions/mcp-gov/panel.ts");
		const line = "declarations: 25 tools ≈ 6.9K tok (test)";
		const { probeMcpAdapterPort } = await import("../../extensions/mcp-gov/broker.ts");
		const port = await probeMcpAdapterPort();
		for (const present of [port.present, false]) {
			const section = renderMcpPanel({
				port: present ? port : { present: false },
				ruleSummary: ["allow: (none)", "deny: (none)", "ask: (none)"],
				denyCount: 0,
				home: tmpdir(),
				extraLines: [line],
			});
			expect(section.lines.some((l) => l.includes("declarations: 25 tools"))).toBe(true);
		}
	});
});
