
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { listMemoryFiles, parseMemoryFrontmatter } from "./memdir.ts";
import { DESCRIPTION_MAX, descriptionTooLong } from "./policy.ts";
import { INDEX_MAX_LINES, removeDocument, reindex } from "./writer.ts";
import { findSecret } from "./guard.ts";
import {
	acquireLayerLock,
	atomicWriteFile,
	fileBytes,
	layerStats,
	MEMORY_FILE_TOTAL_MAX,
	safeMemoryFileName,
	type LayerLock,
	type LayerStats,
} from "./store.ts";
import { consolidateResultRows, renderConsolidateCall, type ConsolidateArgs } from "./renderers.ts";
import { renderRows } from "../../lib/tool-render.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";

export const CONSOLIDATE_DIRECTIVE_TYPE = "pi-memory-consolidate";

export interface ConsolidateWrite {
	file: string;
	content: string;
	merged_from?: string[];
}

export type ConsolidateDelete = string | { file: string; reason: string };

export function normalizeDeletes(deletes: ConsolidateDelete[]): Array<{ file: string; reason?: string }> {
	return deletes.map((d) => (typeof d === "string" ? { file: d } : { file: d.file, reason: d.reason }));
}

export function buildConsolidationDirective(
	stats: LayerStats,
	cap: number,
	reason: string,
): string {
	return [
		`[memory] The PROJECT memory store is over budget (${reason}: index ${stats.indexBytes}/${cap} bytes, ${stats.files} files). Consolidate it now:`,
		`1. Read the memory files in ${stats.dir} (list the directory, read each file).`,
		"2. Merge overlapping or duplicate memories into single files, delete stale or superseded ones, split files that mix unrelated facts. Every retained fact must survive the merge.",
		'3. Call the memory_consolidate tool ONCE with the whole batch: writes=[complete new file contents incl. frontmatter], deletes=[file names].',
		"The batch is rejected unless it reduces total bytes or file count.",
	].join("\n");
}

export interface ConsolidateResult {
	ok: boolean;
	written: number;
	deleted: number;
	beforeBytes: number;
	afterBytes: number;
	beforeFiles: number;
	afterFiles: number;
	message: string;
}

export function readFrontmatterField(content: string, key: string): string | undefined {
	if (!content.startsWith("---")) return undefined;
	const lines = content.split("\n");
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]!.trim() === "---") break;
		const m = new RegExp(`^${key}:\\s*(\\S.*)$`).exec(lines[i]!.trim());
		if (m) return m[1]!.trim().replace(/^(["'])(.*)\1$/, "$2");
	}
	return undefined;
}

export function stampConsolidationFields(content: string, created: string | undefined, consolidatedAt: string | undefined): string {
	if (!content.startsWith("---")) return content;
	const lines = content.split("\n");
	const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (close === -1) return content;
	const insert: string[] = [];
	if (created !== undefined && readFrontmatterField(content, "created") === undefined) insert.push(`created: ${created}`);
	if (consolidatedAt !== undefined && readFrontmatterField(content, "consolidated_at") === undefined) insert.push(`consolidated_at: ${consolidatedAt}`);
	if (insert.length === 0) return content;
	lines.splice(close, 0, ...insert);
	return lines.join("\n");
}

function earliestCreatedFor(dir: string, w: ConsolidateWrite): string | undefined {
	const stamps: number[] = [];
	for (const src of w.merged_from ?? []) {
		const full = join(dir, src);
		if (!existsSync(full)) continue;
		const content = (readOrUndefined(full)) ?? "";
		const createdField = readFrontmatterField(content, "created");
		const createdMs = createdField !== undefined ? Date.parse(createdField) : NaN;
		stamps.push(Number.isFinite(createdMs) ? createdMs : statSync(full).mtimeMs);
	}
	if (stamps.length === 0) {
		const existing = join(dir, w.file);
		if (!existsSync(existing)) return undefined;
		const content = (readOrUndefined(existing)) ?? "";
		const createdField = readFrontmatterField(content, "created");
		return createdField ?? new Date(statSync(existing).mtimeMs).toISOString();
	}
	return new Date(Math.min(...stamps)).toISOString();
}

function readOrUndefined(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

export function runConsolidation(
	dir: string,
	writes: ConsolidateWrite[],
	deletes: ConsolidateDelete[],
): ConsolidateResult {
	const fail = (message: string): ConsolidateResult => ({
		ok: false, written: 0, deleted: 0, beforeBytes: 0, afterBytes: 0, beforeFiles: 0, afterFiles: 0, message,
	});
	const cap = MEMORY_INDEX_MAX;

	if (writes.length === 0 && deletes.length === 0) return fail("empty batch: provide writes and/or deletes");
	if (writes.length > 100 || deletes.length > 100) return fail("batch too large (max 100 writes / 100 deletes)");

	const before = layerStats(dir);

	const safe = safeMemoryFileName;
	const deletesNorm = normalizeDeletes(deletes);
	const deleteSet = new Set(deletesNorm.map((d) => d.file));
	const seenWrites = new Set<string>();
	for (const w of writes) {
		if (!safe(w.file)) return fail(`unsafe file name "${w.file}" (bare kebab-case name ending in .md, not MEMORY.md)`);
		if (seenWrites.has(w.file)) return fail(`duplicate write key "${w.file}" (one entry per file)`);
		seenWrites.add(w.file);
		if (deleteSet.has(w.file)) return fail(`write and delete the same file "${w.file}" in one batch — pick one side`);
		const fm = parseMemoryFrontmatter(w.content);
		if (!fm) return fail(`${w.file}: invalid frontmatter (need name/description/type)`);
		if (descriptionTooLong(fm.description)) return fail(`${w.file}: description exceeds ${DESCRIPTION_MAX} characters — rewrite as a noun phrase with the topic keywords`);
		const secret = findSecret(w.content);
		if (secret) return fail(`${w.file}: looks like a ${secret}`);
		if (Buffer.byteLength(w.content, "utf8") > MEMORY_FILE_TOTAL_MAX) return fail(`${w.file}: exceeds ${MEMORY_FILE_TOTAL_MAX} bytes`);
	}
	for (const d of deletesNorm) {
		if (!safe(d.file)) return fail(`unsafe delete target "${d.file}" (bare kebab-case name ending in .md, not MEMORY.md)`);
		if (!existsSync(join(dir, d.file))) {
			return fail(`delete target "${d.file}" not found (check the "layer" argument — it defaults to "project")`);
		}
		if (d.reason !== undefined && typeof d.reason !== "string") return fail(`delete "${d.file}": reason must be a string`);
	}

	const orphaned = deletesNorm
		.filter((d) => d.reason === undefined && !writes.some((w) => (w.merged_from ?? []).includes(d.file)))
		.map((d) => d.file);
	if (orphaned.length > 0) {
		return fail(`delete(s) without provenance: ${orphaned.join(", ")} — name them in the absorbing write's merged_from, or give each a per-file reason`);
	}

	const beforeFiles = before.files;
	const fileNamesAfter = new Set<string>(
		[...listMemoryFiles(dir), ...writes.map((w) => w.file)].filter((f) => !deleteSet.has(f)),
	);
	const bytesAfter =
		writes.reduce((sum, w) => sum + Buffer.byteLength(w.content, "utf8"), 0) +
		[...fileNamesAfter]
			.filter((f) => !writes.some((w) => w.file === f))
			.reduce((sum, f) => sum + fileBytes(join(dir, f)), 0);
	if (!(bytesAfter < before.totalBytes || fileNamesAfter.size < beforeFiles)) {
		return fail(`batch does not shrink the store (${beforeFiles} files/${before.totalBytes}B → ${fileNamesAfter.size} files/${bytesAfter}B); merge more or delete stale files`);
	}

	const lock: LayerLock | null = acquireLayerLock(dir);
	if (!lock) return fail("consolidation already in progress (another session holds the lock)");

	try {
		const consolidatedAt = new Date().toISOString();
		for (const w of writes) {
			const created = earliestCreatedFor(dir, w);
			const content = stampConsolidationFields(w.content, created, w.merged_from !== undefined || created !== undefined ? consolidatedAt : undefined);
			atomicWriteFile(dir, w.file, content);
		}
		for (const d of deletesNorm) removeDocument(dir, d.file);
		reindex(dir);
		const after = layerStats(dir);
		return {
			ok: true,
			written: writes.length,
			deleted: deletes.length,
			beforeBytes: before.totalBytes,
			afterBytes: after.totalBytes,
			beforeFiles,
			afterFiles: after.files,
			message: `consolidated: ${writes.length} written, ${deletes.length} deleted — ${before.totalBytes}B/${beforeFiles} files → ${after.totalBytes}B/${after.files} files (index ${after.indexBytes}/${cap}B)`,
		};
	} finally {
		lock.release();
	}
}




export function needsConsolidation(stats: LayerStats, indexCap: number): string | null {
	if (stats.indexTruncated) return "index truncated";
	if (stats.indexBytes > indexCap) return `index ${stats.indexBytes}/${indexCap} bytes`;
	if (stats.files > INDEX_MAX_LINES) return `${stats.files} files`;
	return null;
}

export interface ConsolidationHooks {
	onDirectiveSent?: (reason: string) => void;
	onApplied?: () => void;
}

export function sendConsolidationDirective(
	pi: ExtensionAPI,
	dir: string,
	hooks: ConsolidationHooks,
): { sent: boolean; detail: string } {
	const stats = layerStats(dir);
	if (stats.files === 0) return { sent: false, detail: "no memory files to consolidate" };
	const reason = needsConsolidation(stats, MEMORY_INDEX_MAX) ?? "manual request";
	hooks.onDirectiveSent?.(reason);
	pi.sendMessage(
		{ customType: CONSOLIDATE_DIRECTIVE_TYPE, content: buildConsolidationDirective(stats, MEMORY_INDEX_MAX, reason), display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	return { sent: true, detail: `project layer (${stats.files} files)` };
}

export function registerConsolidation(
	pi: ExtensionAPI,
	dirs: (ctx?: { cwd?: string }) => { project: string },
	hooks: ConsolidationHooks = {},
): void {
	pi.registerTool(
		defineTool({
			name: "memory_consolidate",
			label: "Memory Consolidate",
			description:
				"Apply a consolidation batch to the project memory layer: writes (complete file contents incl. frontmatter) + deletes. The batch must reduce total bytes or file count. Use for merging/deduplicating/pruning memory files — never for adding new memories (write those as files directly).",
			promptSnippet: "memory_consolidate(writes, deletes) — batch-rewrite project memory files to shrink an over-budget store",
			parameters: Type.Object({
				writes: Type.Array(
					Type.Object({
						file: Type.String({ description: "File name within the project memory dir (e.g. merged-lessons.md)" }),
						content: Type.String({ description: "Complete new file content including frontmatter" }),
						merged_from: Type.Optional(Type.Array(Type.String(), { description: "Files this write absorbs (provenance for deletes)" })),
					}),
					{ description: "Files to write (created or replaced)" },
				),
				deletes: Type.Array(
					Type.Union([Type.String(), Type.Object({ file: Type.String(), reason: Type.String({ description: "Why this file disappears without being merged" }) })]),
					{ description: "Files to delete: bare names, or {file, reason}. Every delete must appear in some write's merged_from or carry a reason." },
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
				const p = params as { writes: ConsolidateWrite[]; deletes: ConsolidateDelete[] };
				const result = runConsolidation(dirs(ctx).project, p.writes ?? [], p.deletes ?? []);
				if (!result.ok) throw new Error(result.message);
				hooks.onApplied?.();
				return {
					content: [{ type: "text", text: `memory_consolidate: ${result.message}` }],
					details: { ok: true, written: result.written, deleted: result.deleted },
				};
			},
			renderCall: (args, theme) => renderConsolidateCall(args as ConsolidateArgs, theme as never),
			renderResult: (result, _options, theme) =>
				renderRows(consolidateResultRows(result), theme as never),
		}),
	);

	pi.registerCommand("memory-consolidate", {
		description: "Send the memory consolidation directive to the agent (project layer; consolidation is manual-only)",
		handler: async (args, ctx) => {
			if (args.trim() === "user") {
				try {
					(ctx as { ui?: { notify?: (m: string, t?: string) => void } }).ui?.notify?.(
						"the user memory layer is retired (2026-11-24) — only the project layer consolidates",
						"warning",
					);
				} catch {
				}
				return;
			}
			const r = sendConsolidationDirective(pi, dirs(ctx).project, hooks);
			try {
				(ctx as { ui?: { notify?: (m: string, t?: string) => void } }).ui?.notify?.(
					r.sent ? `memory consolidation directive sent — ${r.detail}` : r.detail,
					"info",
				);
			} catch {
			}
		},
	});
}
