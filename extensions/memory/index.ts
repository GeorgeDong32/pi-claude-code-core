/**
 * memory/index.ts — the memory module wiring (DESIGN-MEMORY 定稿形状:
 * 1 tool + 3 commands + 5 hooks, 0 exported types, zero deps, zero LLM).
 *
 *   session_start       reconcile + budget reset + static yield probe
 *   session_compact     per-turn budget reset
 *   before_agent_start  dynamic yield probe → policy + capped index (gated)
 *   context             lexical selectForTurn injection (gated, not persisted)
 *   tool_call           guardMemoryWrites secret interceptor
 *   registerTool        session_recall
 *   registerCommand     /memory, /memory-import-claude, /memory-import-hermes
 *
 * Injection failures NEVER block a turn (P3-ME-09): every hook body is
 * try/catch-wrapped at the boundary.
 */
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { coreBus } from "../bus.js";
import { reconcileMemoryIndex, scanMemoryDir, scanMemoryDirCached } from "./memdir.ts";
import { resolveMemoryPaths, sessionsDirFor } from "./paths.ts";
import { buildPolicyInjection, POLICY_COMPACT } from "./policy.ts";
import { selectForTurn, freshnessHeader, byteLength, type SelectableMemory } from "./selection.ts";
import { guardMemoryWrites } from "./guard.ts";
import { InjectionGate } from "./yield.ts";
import { sessionRecall } from "./session-recall.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.js";
import { importFromClaude, importFromHermes } from "./importers.ts";

export default function memoryExtension(pi: ExtensionAPI): void {
	const home = homedir();
	// resolve the agent dir at call time so HOME overrides (tests) apply
	const gate = new InjectionGate(join(process.env.HOME ?? home, ".pi", "agent"));

	let degradedNotified = false;
	let memoryDirWritable = true;
	let sessionBytesUsed = 0;

	function memoryDir(ctx?: { cwd?: string }): string {
		// anchor on the SESSION cwd (ctx.cwd); process.cwd() is only the
		// fallback. Re-resolve per call so HOME overrides (tests) apply.
		return resolveMemoryPaths(ctx?.cwd ?? process.cwd(), process.env.HOME ?? home).memoryDir;
	}

	function notifyOnce(ctx: ExtensionContext | undefined, msg: string): void {
		if (degradedNotified) return;
		degradedNotified = true;
		if (ctx?.hasUI) ctx.ui.notify(msg, "warning");
		else console.log(`pi-memory: ${msg}`);
	}

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		try {
			sessionBytesUsed = 0;
			gate.probeStatic();
			reconcileMemoryIndex(memoryDir(ctx));
			// writability probe: a failed write degrades to policy-only
			try {
				// existence is not writability (review #17): probe the access mode
				accessSync(memoryDir(ctx), fsConstants.W_OK);
				memoryDirWritable = true;
			} catch {
				memoryDirWritable = false;
			}
			coreBus().publish({
				memory: { yielded: gate.state.yielded, ...(gate.state.yielded ? { dir: memoryDir(ctx) } : {}) },
			});
		} catch {
			/* never block session start */
		}
	});

	pi.on("session_compact", () => {
		sessionBytesUsed = 0;
	});

	pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
		try {
			const wasYielded = gate.state.yielded;
			gate.probePrompt(event.systemPrompt ?? "");
			if (gate.state.yielded !== wasYielded) {
				// dynamic probe just flipped — refresh the bus channel
				coreBus().publish({
					memory: { yielded: gate.state.yielded, ...(gate.state.yielded ? { dir: memoryDir(ctx) } : {}) },
				});
			}
			if (gate.state.yielded) return undefined; // hermes owns injection
			const dir = memoryDir(ctx);
			const { files, skipped } = scanMemoryDirCached(dir);
			if (!memoryDirWritable) {
				notifyOnce(ctx, "memory dir not writable — running policy-only");
				// policy-only: the index derives from the (unwritable) dir and
				// cannot be trusted to match, so inject just the policy block
				return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${POLICY_COMPACT}` };
			}
			const injection = buildPolicyInjection(
				files.map((f) => ({ ...f.entry })),
			) + (skipped > 0 ? `\n<!-- memory: ${skipped} file(s) skipped (invalid frontmatter) -->` : "");
			return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${injection}` };
		} catch {
			return undefined; // injection failure never blocks the turn
		}
	});

	pi.on("context", (event, ctx: ExtensionContext): { messages: typeof event.messages } | undefined => {
		try {
			if (gate.state.yielded) return undefined;
			const dir = memoryDir(ctx);
			const messages = event.messages ?? [];
			// skip injected custom blocks (pi-memory-recall, pi-rules-activate…):
			// otherwise our own selection could become the next recall prompt
			const lastUser = [...messages].reverse().find(
				(m: { role?: string; customType?: string }) => m.role === "user" && !m.customType,
			);
			const prompt = extractUserText(lastUser);
			if (!prompt) return undefined;

			const memories: SelectableMemory[] = scanMemoryDirCached(dir).files.map((f) => ({
				...f.entry,
				body: f.body,
				mtimeMs: f.mtimeMs,
			}));

			const { files } = selectForTurn(prompt, memories, sessionBytesUsed);
			if (files.length === 0) return undefined;

			const blocks: string[] = ["<memory-recall>"];
			for (const file of files) {
				const header = freshnessHeader(file.mtimeMs);
				// charge the session budget for the whole rendered block
				// (title + freshness header + body), in bytes, not just body chars
				const block = `## ${file.title} (memory/${file.file})${header ? `\n${header}` : ""}\n\n${file.body}`;
				sessionBytesUsed += byteLength(block);
				blocks.push(block);
			}
			blocks.push("</memory-recall>");
			const injection = {
				customType: "pi-memory-recall",
				role: "user" as const,
				content: [{ type: "text", text: blocks.join("\n\n") }],
				display: false,
			};
			return { messages: [...messages, injection as never] };
		} catch {
			return undefined;
		}
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		try {
			const name = typeof event.toolName === "string" ? event.toolName : "";
			const input = (event.input ?? {}) as Record<string, unknown>;
			const verdict = guardMemoryWrites(name, input, memoryDir(ctx));
			if (verdict.block) {
				return { block: true, reason: verdict.reason };
			}
		} catch {
			/* guard failure must not break the tool call */
		}
		return undefined;
	});

	pi.registerTool(defineTool({
		name: "session_recall",
		label: "Session Recall",
		description:
			"Search past pi sessions for this project (read-only). AND-matched query over user/assistant text. Returns matching excerpts with file/line pointers.",
		parameters: Type.Object({
			query: Type.String({ description: "Space-separated AND terms" }),
			project: Type.Optional(Type.String({ description: "Project cwd (defaults to current)" })),
			since: Type.Optional(Type.String({ description: "ISO date or -Nd (days ago)" })),
			until: Type.Optional(Type.String({ description: "ISO date" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max hits (default 20)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const p = params as { query: string; project?: string; since?: string; until?: string; limit?: number };
			const effectiveCwd = p.project ?? ctx.cwd ?? process.cwd();
			const result = sessionRecall({
				query: p.query,
				project: effectiveCwd,
				since: p.since,
				until: p.until,
				limit: p.limit,
				home,
			});
			if (result.hits.length === 0) {
				const dir = sessionsDirFor(effectiveCwd, home);
				const text = existsSync(dir)
					? `session_recall: no matches for "${p.query}" (${result.scannedFiles} files scanned${result.skippedLines ? `, ${result.skippedLines} malformed lines skipped` : ""})`
					: `session_recall: no sessions found for ${dir}`;
				return { content: [{ type: "text", text }], details: { hits: 0, skippedLines: 0 } };
			}
			const text = result.hits
				.map(
					(h) =>
						`[${h.file}:${h.line}] ${h.role}${h.timestamp ? ` @ ${h.timestamp}` : ""}:\n${h.text.slice(0, 500)}`,
				)
				.join("\n\n");
			return {
				content: [{ type: "text", text: `session_recall: ${result.hits.length} hit(s)\n\n${text}` }],
				details: { hits: result.hits.length, skippedLines: result.skippedLines },
			};
		},
	}));

	pi.registerCommand("memory", {
		description: "Show memory dir status (file count, skipped files, index size)",
		handler: async (_args, ctx) => {
			const dir = memoryDir(ctx as ExtensionContext);
			const { entries, skipped } = scanMemoryDir(dir);
			let indexBytes = 0;
			try {
				indexBytes = byteLength(readFileSync(join(dir, "MEMORY.md"), "utf-8"));
			} catch {
				/* no index */
			}
			const lines = [
				`memory dir: ${dir}`,
				`files: ${entries.length}, skipped (invalid frontmatter): ${skipped}`,
				`MEMORY.md: ${indexBytes}/${MEMORY_INDEX_MAX} bytes`,
				`yielded to hermes: ${gate.state.yielded}${gate.state.detectedBy ? ` (${gate.state.detectedBy})` : ""}`,
				...entries.map((e) => `- [${e.title}](${e.file}) — ${e.description} [${e.type}]`),
			];
			pi.sendMessage({ customType: "pi-memory-status", content: lines.join("\n"), display: true });
		},
	});

	pi.registerCommand("memory-import-claude", {
		description: "Import Claude Code memories from ~/.claude/projects/<this project>/memory",
		handler: async (_args, ctx) => {
			const cwd = (ctx as ExtensionContext).cwd ?? process.cwd();
			const sanitized = cwd.replace(/[\\/]/g, "-");
			const source = join(homedir(), ".claude", "projects", sanitized, "memory");
			const report = importFromClaude(source, memoryDir(ctx as ExtensionContext));
			const text = [
				`memory-import-claude: copied ${report.copied}, skipped ${report.skipped} (idempotent)`,
				...report.notes,
			].join("\n");
			pi.sendMessage({ customType: "pi-memory-status", content: text, display: true });
		},
	});

	pi.registerCommand("memory-import-hermes", {
		description: "Import a hermes §-store file into per-fact memory files",
		handler: async (args, ctx) => {
			const file = args.trim() || join(memoryDir(ctx as ExtensionContext), "hermes-import.md");
			const report = importFromHermes(file, memoryDir(ctx as ExtensionContext));
			const text = [
				`memory-import-hermes: converted ${report.copied}, skipped ${report.skipped} (idempotent)`,
				...report.notes,
			].join("\n");
			pi.sendMessage({ customType: "pi-memory-status", content: text, display: true });
		},
	});
}

function extractUserText(message: unknown): string | null {
	const m = message as { content?: unknown } | undefined;
	if (!m) return null;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		const texts = (m.content as Array<{ type?: string; text?: string }>)
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text!);
		if (texts.length > 0) return texts.join("\n");
	}
	return null;
}
