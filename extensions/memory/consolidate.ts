/**
 * memory/consolidate.ts — memory_consolidate tool + directive + auto-trigger
 * (V2-C, DESIGN-MEMORY-V2 §5).
 *
 * Form (user-approved): a consolidation is a DIRECTIVE injected via
 * sendMessage({triggerTurn: true, deliverAs: "followUp"}); the in-session
 * model reads the listed files and calls the memory_consolidate tool ONCE
 * with a full batch. Tool call + result render through pi's native
 * ●/⎿ pipeline — no custom status UI.
 *
 * S2 (OPT-3): consolidation is a POLICY on the shared write engine —
 * validation rules (filename predicate, frontmatter, secret scan, size
 * cap) and the atomic write primitive all come from store.ts; what stays
 * here is the must-shrink invariant, the mkdir lock, and the trigger.
 *
 * Batch-member exclusivity (2026-10-18): writes and deletes may not name
 * the same file, and write keys must be unique. Both shapes previously
 * skewed the bytesAfter accounting (content counted for a file that never
 * lands, or counted twice for one landing) and could produce a false
 * "does not shrink" rejection; they are now explicit validation failures.
 * Guard messages carry the name-format and layer hints that field usage
 * showed models need (a 6-rejected-attempt consolidation run tripped on
 * exactly these two unstated contracts).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { listMemoryFiles, parseMemoryFrontmatter } from "./memdir.ts";
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
import { USER_INDEX_MAX } from "./policy.ts";
import { consolidateResultRows, renderConsolidateCall, type ConsolidateArgs } from "./renderers.ts";
import { renderRows } from "../../lib/tool-render.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";

export const CONSOLIDATE_DIRECTIVE_TYPE = "pi-memory-consolidate";

export interface ConsolidateWrite {
	file: string;
	content: string;
	/** G2-C11 provenance: the delete targets this write absorbed. */
	merged_from?: string[];
}

/** G2-C11: a delete is a bare file name, or a file name plus its per-file
 * reason (why it disappeared without being merged anywhere). */
export type ConsolidateDelete = string | { file: string; reason: string };

/** Normalize the union to {file, reason?} entries (old shape: no reason). */
export function normalizeDeletes(deletes: ConsolidateDelete[]): Array<{ file: string; reason?: string }> {
	return deletes.map((d) => (typeof d === "string" ? { file: d } : { file: d.file, reason: d.reason }));
}

/** The directive the model receives (content of the custom message). */
export function buildConsolidationDirective(
	layer: "user" | "project",
	stats: LayerStats,
	cap: number,
	reason: string,
): string {
	const label = layer === "user" ? "USER" : "PROJECT";
	return [
		`[memory] The ${label} memory store is over budget (${reason}: index ${stats.indexBytes}/${cap} bytes, ${stats.files} files). Consolidate it now:`,
		`1. Read the memory files in ${stats.dir} (list the directory, read each file).`,
		"2. Merge overlapping or duplicate memories into single files, delete stale or superseded ones, split files that mix unrelated facts. Every retained fact must survive the merge.",
		'3. Call the memory_consolidate tool ONCE with the whole batch: writes=[complete new file contents incl. frontmatter], deletes=[file names].',
		"The batch is rejected unless it reduces total bytes or file count. Do not touch the other memory layer.",
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

/** Text-level frontmatter field read (G2-C12/C13) — no reparse, no reorder. */
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

/** Insert created/consolidated_at lines just before the closing --- (G2-C12). */
export function stampConsolidationFields(content: string, created: string | undefined, consolidatedAt: string | undefined): string {
	if (!content.startsWith("---")) return content; // invalid shape is the pre-write validator's failure, not ours
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

/** G2-C12: the oldest creation timestamp among the write's sources — the
 * sources' created field when present, else their mtime (still on disk at
 * this point: deletes run after writes' planning but BEFORE removal… no —
 * removal runs after stamping in the same try block, so stats are valid). */
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
		// no merged_from: fall back to the overwritten same-name file, if any
		const existing = join(dir, w.file);
		if (!existsSync(existing)) return undefined;
		const content = (readOrUndefined(existing)) ?? "";
		const createdField = readFrontmatterField(content, "created");
		return createdField ?? new Date(statSync(existing).mtimeMs).toISOString();
	}
	return new Date(Math.min(...stamps)).toISOString();
}

// tiny sync read helper (try/catch'd)
function readOrUndefined(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** Validate + apply a consolidation batch (the tool's core; exported for tests). */
export function runConsolidation(
	dir: string,
	writes: ConsolidateWrite[],
	deletes: ConsolidateDelete[],
	userLayer = false,
): ConsolidateResult {
	const fail = (message: string): ConsolidateResult => ({
		ok: false, written: 0, deleted: 0, beforeBytes: 0, afterBytes: 0, beforeFiles: 0, afterFiles: 0, message,
	});
	const cap = userLayer ? USER_INDEX_MAX : MEMORY_INDEX_MAX;

	if (writes.length === 0 && deletes.length === 0) return fail("empty batch: provide writes and/or deletes");
	if (writes.length > 100 || deletes.length > 100) return fail("batch too large (max 100 writes / 100 deletes)");

	const before = layerStats(dir);

	// validate every write BEFORE touching anything
	const safe = safeMemoryFileName; // S2: the engine's one filename predicate
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
		const secret = findSecret(w.content);
		if (secret) return fail(`${w.file}: looks like a ${secret}`);
		if (Buffer.byteLength(w.content, "utf8") > MEMORY_FILE_TOTAL_MAX) return fail(`${w.file}: exceeds ${MEMORY_FILE_TOTAL_MAX} bytes`);
	}
	for (const d of deletesNorm) {
		if (!safe(d.file)) return fail(`unsafe delete target "${d.file}" (bare kebab-case name ending in .md, not MEMORY.md)`);
		if (!existsSync(join(dir, d.file))) {
			// write/delete overlap was already rejected above, so no write can
			// supply this name — existence on disk is the only remaining source
			return fail(`delete target "${d.file}" not found (check the "layer" argument — it defaults to "project")`);
		}
		if (d.reason !== undefined && typeof d.reason !== "string") return fail(`delete "${d.file}": reason must be a string`);
	}

	// G2-C11 provenance: every deleted file must be absorbed by some write's
	// merged_from or carry its own reason — orphan deletions are rejected.
	const orphaned = deletesNorm
		.filter((d) => d.reason === undefined && !writes.some((w) => (w.merged_from ?? []).includes(d.file)))
		.map((d) => d.file);
	if (orphaned.length > 0) {
		return fail(`delete(s) without provenance: ${orphaned.join(", ")} — name them in the absorbing write's merged_from, or give each a per-file reason`);
	}

	// must-shrink invariant: post state strictly smaller in bytes or files
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
		// G2-C12: stamp created/consolidated_at so a merge never resets fact age.
		const consolidatedAt = new Date().toISOString();
		for (const w of writes) {
			const created = earliestCreatedFor(dir, w);
			const content = stampConsolidationFields(w.content, created, w.merged_from !== undefined || created !== undefined ? consolidatedAt : undefined);
			atomicWriteFile(dir, w.file, content); // C7: invalidates the scan cache
		}
		for (const d of deletesNorm) removeDocument(dir, d.file); // W1: ENOENT-idempotent, cache dropped per delete
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



// ─── auto-trigger state machine (V2-C) ───

export interface TriggerDeps {
	sendDirective: (layer: "user" | "project", directive: string) => void;
	/** test seam for lock TTL clock */
	now?: () => number;
}

export interface TriggerState {
	attempts: number;
	turnsSinceAttempt: number;
	inFlight: boolean;
	lastReason?: string;
}

/** Over-budget probe for one layer: index truncated, index bytes over the
 * layer's cap, or file count over the threshold (all mean the index can no
 * longer represent the store). B1 (OPT-3): the bytes check closes the gap
 * where a 9-24KB user-layer index had no WARNING yet injected at 8KB. */
export function needsConsolidation(stats: LayerStats, indexCap: number): string | null {
	if (stats.indexTruncated) return "index truncated";
	if (stats.indexBytes > indexCap) return `index ${stats.indexBytes}/${indexCap} bytes`;
	if (stats.files > INDEX_MAX_LINES) return `${stats.files} files`;
	return null;
}

export class ConsolidationTrigger {
	readonly state: TriggerState = { attempts: 0, turnsSinceAttempt: 0, inFlight: false };
	/** set while the directive-driven turn is running, so P3 counters can
	 * exclude it from review/correction accounting */
	directiveTurnActive = false;

	constructor(private readonly deps: TriggerDeps) {}

	/** turn_end tick: throttled, at most 2 directives per session. */
	onTurnEnd(projectDir: string, userDir: string): void {
		this.state.turnsSinceAttempt++;
		if (this.state.inFlight) return;
		if (this.state.attempts >= 2) return;
		if (this.state.attempts > 0 && this.state.turnsSinceAttempt < 10) return;
		for (const [layer, dir, cap] of [
			["project", projectDir, MEMORY_INDEX_MAX],
			["user", userDir, USER_INDEX_MAX],
		] as const) {
			const stats = layerStats(dir);
			const reason = needsConsolidation(stats, cap);
			if (!reason) continue;
			this.fire(layer, stats, cap, reason);
			return;
		}
	}

	/** manual /memory-consolidate: bypasses throttle, still one directive. */
	manual(projectDir: string, userDir: string, layerArg?: string): { sent: boolean; detail: string } {
		const order: Array<["user" | "project", string, number]> =
			layerArg === "user"
				? [["user", userDir, USER_INDEX_MAX]]
				: layerArg === "project"
					? [["project", projectDir, MEMORY_INDEX_MAX]]
					: [
							["project", projectDir, MEMORY_INDEX_MAX],
							["user", userDir, USER_INDEX_MAX],
						];
		for (const [layer, dir, cap] of order) {
			const stats = layerStats(dir);
			if (stats.files === 0) continue;
			this.fire(layer, stats, cap, needsConsolidation(stats, cap) ?? "manual request");
			return { sent: true, detail: `${layer} layer (${stats.files} files)` };
		}
		return { sent: false, detail: "no memory files to consolidate" };
	}

	private fire(layer: "user" | "project", stats: LayerStats, cap: number, reason: string): void {
		this.state.attempts++;
		this.state.turnsSinceAttempt = 0;
		this.state.inFlight = true;
		this.state.lastReason = `${layer}: ${reason}`;
		this.directiveTurnActive = true;
		this.deps.sendDirective(layer, buildConsolidationDirective(layer, stats, cap, reason));
	}

	/** tool_result(memory_consolidate) or agent_settled clears in-flight.
	 * B3 (OPT-3): only agent_settled clears directiveTurnActive — clearing it
	 * at tool_result let the tail of the consolidation turn (the model's
	 * summary) leak into review/correction accounting. */
	settle(options?: { directive?: boolean }): void {
		this.state.inFlight = false;
		if (options?.directive) this.directiveTurnActive = false;
	}
}

/** Register the tool + /memory-consolidate command + wiring hooks. */
export function registerConsolidation(
	pi: ExtensionAPI,
	dirs: (ctx?: { cwd?: string }) => { project: string; user: string },
	trigger: ConsolidationTrigger,
	onApplied?: () => void,
): void {
	pi.registerTool(
		defineTool({
			name: "memory_consolidate",
			label: "Memory Consolidate",
			description:
				"Apply a consolidation batch to one memory layer: writes (complete file contents incl. frontmatter) + deletes. The batch must reduce total bytes or file count. Use for merging/deduplicating/pruning memory files — never for adding new memories (write those as files directly).",
			promptSnippet: "memory_consolidate(writes, deletes, layer) — batch-rewrite memory files to shrink an over-budget store",
			parameters: Type.Object({
				writes: Type.Array(
					Type.Object({
						file: Type.String({ description: "File name within the layer dir (e.g. merged-prefs.md)" }),
						content: Type.String({ description: "Complete new file content including frontmatter" }),
						merged_from: Type.Optional(Type.Array(Type.String(), { description: "Files this write absorbs (provenance for deletes)" })),
					}),
					{ description: "Files to write (created or replaced)" },
				),
				deletes: Type.Array(
					Type.Union([Type.String(), Type.Object({ file: Type.String(), reason: Type.String({ description: "Why this file disappears without being merged" }) })]),
					{ description: "Files to delete: bare names, or {file, reason}. Every delete must appear in some write's merged_from or carry a reason." },
				),
				layer: Type.Optional(Type.String({ description: '"project" (default) or "user"' })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const p = params as { writes: ConsolidateWrite[]; deletes: ConsolidateDelete[]; layer?: string };
				const userLayer = p.layer === "user";
				const dir = userLayer ? dirs(ctx).user : dirs(ctx).project;
				const result = runConsolidation(dir, p.writes ?? [], p.deletes ?? [], userLayer);
				if (!result.ok) throw new Error(result.message);
				onApplied?.(); // G2-C14: mark the session as having consolidated
				return {
					content: [{ type: "text", text: `memory_consolidate: ${result.message}` }],
					details: { ok: true, written: result.written, deleted: result.deleted },
				};
			},
			// TR C: one row per outcome — the batch manifest stays in the text.
			renderCall: (args, theme) => renderConsolidateCall(args as ConsolidateArgs, theme as never),
			renderResult: (result, _options, theme) =>
				renderRows(consolidateResultRows(result), theme as never),
		}),
	);

	pi.registerCommand("memory-consolidate", {
		description: "Send the memory consolidation directive to the agent (fallback; normally automatic)",
		handler: async (args, ctx) => {
			const { project, user } = dirs(ctx);
			const r = trigger.manual(project, user, args.trim() || undefined);
			try {
				(ctx as { ui?: { notify?: (m: string, t?: string) => void } }).ui?.notify?.(
					r.sent ? `memory consolidation directive sent — ${r.detail}` : r.detail,
					"info",
				);
			} catch {
				/* stale ctx — the directive was already sent */
			}
		},
	});
}
