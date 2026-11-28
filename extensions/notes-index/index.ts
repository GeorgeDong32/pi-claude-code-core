import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentDir, defaultNotesDir } from "../../lib/agent-paths.ts";
import { loadCoreEconomy } from "../../lib/core-economy.ts";
import { notify as uiNotify } from "../ui/notify.ts";
import { readSessionProjection } from "../modes/session-branch.ts";
import { isDirectory, scanNotesDirCached, type NoteFile, type NoteScan } from "./notes-dir.ts";
import { buildIndexBlock } from "./render.ts";

function pinnedNotes(): NoteFile[] {
	const dir = loadCoreEconomy().notesIndex.pinnedDir ?? join(agentDir(), "memory");
	if (!isDirectory(dir)) return [];
	return scanNotesDirCached(dir).files.filter((n) => n.pinned);
}

function countCompactions(ctx: ExtensionContext): number {
	let n = 0;
	for (const m of readSessionProjection(ctx.sessionManager) as Array<{ role?: string }>) {
		if (m?.role === "compactionSummary") n += 1;
	}
	return n;
}

// Index injection is the only memory feature core keeps: the notes directory
// (default: the project layer; the Obsidian vault when configured) is the
// store, capture lives in the global AGENTS.md discipline and the dream agent.
export default function notesIndexExtension(pi: ExtensionAPI): void {
	let cache: { text: string; compactions: number; dir: string } | null = null;
	let warned = false;

	function injectionFor(ctx: ExtensionContext): string | null {
		const config = loadCoreEconomy().notesIndex;
		if (!config.enabled) return null;
		const dir = config.dir ?? defaultNotesDir(ctx.cwd ?? process.cwd());
		if (!isDirectory(dir)) return null;
		const compactions = countCompactions(ctx);
		if (cache && cache.compactions === compactions && cache.dir === dir) return cache.text;
		const scan: NoteScan = scanNotesDirCached(dir);
		const text = buildIndexBlock(dir, scan.files, pinnedNotes(), scan.skipped);
		cache = { text, compactions, dir };
		return text;
	}

	pi.on("session_start", () => {
		cache = null;
		warned = false;
	});

	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		let text: string | null = null;
		try {
			text = injectionFor(ctx);
		} catch {
			if (!warned && ctx?.hasUI) {
				warned = true;
				uiNotify(ctx, "project notes index could not be read — running without it", "warning");
			}
		}
		if (!text) return undefined;
		return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${text}` };
	});
}
