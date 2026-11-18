
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson } from "../../lib/settings.ts";
import type { McpEventPort } from "./broker.ts";

export interface McpPanelSection {
	status: "green" | "warn" | "absent";
	lines: string[];
}

const inventoryCache = new Map<string, { fingerprint: string; servers: string[]; sources: string[] }>();

export function readStaticMcpInventory(home = homedir()): { servers: string[]; sources: string[] } {
	const mcpJson = join(home, ".pi", "agent", "mcp.json");
	let fp: string | null = null;
	try {
		const st = statSync(mcpJson);
		fp = `${st.mtimeMs}:${st.size}:${st.ino}`;
	} catch {
		return { servers: [], sources: [] };
	}
	const cached = inventoryCache.get(mcpJson);
	if (cached && cached.fingerprint === fp) return { servers: cached.servers, sources: cached.sources };
	const servers: string[] = [];
	const sources: string[] = [];
	const parsed = readJson<{ mcpServers?: Record<string, unknown> }>(mcpJson, {} as { mcpServers?: Record<string, unknown> }, (reason) => {
		if (reason === "malformed" || reason === "non-object") sources.push("mcp.json (unreadable)");
	});
	const names = Object.keys(parsed.mcpServers ?? {});
	if (names.length > 0) {
		servers.push(...names);
		sources.push(`mcp.json (${names.length})`);
	}
	inventoryCache.set(mcpJson, { fingerprint: fp, servers: [...servers], sources: [...sources] });
	return { servers, sources };
}

export function renderMcpPanel(input: {
	port: McpEventPort;
	ruleSummary: string[];
	denyCount: number;
	home?: string;
	extraLines?: string[];
}): McpPanelSection {
	const home = input.home ?? homedir();
	if (input.port.present && input.port.snapshot) {
		try {
			const snap = input.port.snapshot();
			const hasAllow = input.ruleSummary.some((l) => l.startsWith("allow:"));
			const status: McpPanelSection["status"] = snap.connected && hasAllow ? "green" : "warn";
			return {
				status,
				lines: [
					`mcp: adapter connected (v${snap.version}), servers: ${(snap.servers ?? []).join(", ") || "(none)"}`,
					...input.ruleSummary,
					`mirror deny count: ${input.denyCount}`,
					...(input.extraLines ?? []),
				],
			};
		} catch {
		}
	}
	const inventory = readStaticMcpInventory(home);
	const lines = ["mcp: adapter not installed"];
	if (inventory.sources.length > 0) {
		lines.push(`configured servers (static): ${inventory.servers.join(", ") || "(none)"} via ${inventory.sources.join(", ")}`);
	}
	lines.push(...input.ruleSummary);
	lines.push(`mirror deny count: ${input.denyCount}`);
	for (const l of input.extraLines ?? []) lines.push(l);
	lines.push("install: pi install npm:pi-mcp-adapter");
	return { status: "absent", lines };
}
