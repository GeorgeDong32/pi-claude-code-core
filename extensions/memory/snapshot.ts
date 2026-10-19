/**
 * memory/snapshot.ts — entropy-control G2 [C9]/[C10]/[C14]: path-independent
 * rollback points for both memory layers (docs/zh/entropy-control-spec.md).
 *
 * Design:
 *   - session_start full-snapshots both layers into a sidecar OUTSIDE the
 *     memory dirs, under the unified cc-core root:
 *     ~/.pi/agent/cc-core/memory-snapshots/<layerKey>/snap-<ts>-<rand>/
 *     The index scan is non-recursive and only reads the memory dirs
 *     themselves, so snapshots are isolated by construction ([C10]).
 *   - identical-to-newest content (name+content hash) skips the snapshot;
 *   - keep the newest SNAPSHOT_KEEP, evict the oldest beyond that;
 *   - everything is fail-open: a snapshot failure must never block
 *     session_start — the rollback point is best-effort infrastructure.
 *
 * [C14] reads back the newest snapshot's manifest at agent_end to detect
 * un-consolidated mass deletions (see checkMassDeletion in index.ts).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { listMemoryFiles } from "./memdir.ts";

/** Rotation cap — named constant per the spec's hard constraint ⑥. */
export const SNAPSHOT_KEEP = 10;

export interface SnapshotManifest {
	/** ISO time the snapshot was taken. */
	at: string;
	/** sha256 over every file's name+content, in name order. */
	contentHash: string;
	files: Array<{ file: string; bytes: number }>;
	totalBytes: number;
}

export interface SnapshotDir {
	dir: string;
	manifest: SnapshotManifest;
}

/** The sidecar root for one layer's snapshots. */
export function snapshotRoot(home: string, layerKey: string): string {
	return join(home, ".pi", "agent", "cc-core", "memory-snapshots", layerKey);
}

/** List this layer's snapshots, OLDEST FIRST (by manifest.at, then name). */
export function listSnapshots(root: string): SnapshotDir[] {
	const out: SnapshotDir[] = [];
	let names: string[];
	try {
		names = readdirSync(root).filter((n) => n.startsWith("snap-")).sort();
	} catch {
		return [];
	}
	for (const name of names) {
		const dir = join(root, name);
		try {
			const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as SnapshotManifest;
			if (typeof manifest?.at === "string" && typeof manifest?.contentHash === "string" && Array.isArray(manifest.files)) {
				out.push({ dir, manifest });
			}
		} catch {
			/* unreadable manifest — skip the corrupt snapshot */
		}
	}
	return out.sort((a, b) => (a.manifest.at === b.manifest.at ? (a.dir < b.dir ? -1 : 1) : a.manifest.at < b.manifest.at ? -1 : 1));
}

/** The newest snapshot, or null when the layer has none. */
export function newestSnapshot(root: string): SnapshotDir | null {
	const all = listSnapshots(root);
	return all.length > 0 ? all[all.length - 1]! : null;
}

function hashLayer(memoryDir: string, files: string[]): { hash: string; totalBytes: number; entries: SnapshotManifest["files"] } {
	const h = createHash("sha256");
	const entries: SnapshotManifest["files"] = [];
	let totalBytes = 0;
	for (const file of files) {
		let content: Buffer;
		try {
			content = readFileSync(join(memoryDir, file));
		} catch {
			continue; // vanished mid-scan; next snapshot catches the delta
		}
		h.update(file);
		h.update(content);
		entries.push({ file, bytes: content.length });
		totalBytes += content.length;
	}
	return { hash: h.digest("hex"), totalBytes, entries };
}

/**
 * Snapshot one memory layer. Returns the snapshot taken, or null when
 * skipped (identical to newest) or failed (fail-open — never throws).
 */
export function snapshotLayer(memoryDir: string, root: string, now = () => new Date()): SnapshotDir | null {
	try {
		const files = listMemoryFiles(memoryDir);
		// include the derived index so a restore is complete on disk
		const indexFile = join(memoryDir, "MEMORY.md");
		const allFiles = existsSync(indexFile) ? [...files, "MEMORY.md"] : files;
		const { hash, totalBytes, entries } = hashLayer(memoryDir, allFiles);

		const newest = newestSnapshot(root);
		if (newest && newest.manifest.contentHash === hash) return null; // unchanged since the last snapshot

		const ts = now();
		const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, "0")}${String(ts.getDate()).padStart(2, "0")}-${String(ts.getHours()).padStart(2, "0")}${String(ts.getMinutes()).padStart(2, "0")}${String(ts.getSeconds()).padStart(2, "0")}`;
		const dir = join(root, `snap-${stamp}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(dir, { recursive: true });
		for (const file of allFiles) {
			try {
				cpSync(join(memoryDir, file), join(dir, file));
			} catch {
				/* vanished mid-copy; manifest records what actually landed */
			}
		}
		const landed = allFiles.filter((f) => existsSync(join(dir, f)));
		const manifest: SnapshotManifest = {
			at: ts.toISOString(),
			contentHash: hash,
			files: landed.map((f) => {
				let bytes = 0;
				try {
					bytes = statSync(join(dir, f)).size;
				} catch {}
				return { file: f, bytes };
			}),
			totalBytes,
		};
		writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

		// rotate: keep the newest SNAPSHOT_KEEP
		const all = listSnapshots(root);
		const excess = all.length - SNAPSHOT_KEEP;
		for (let i = 0; i < excess; i++) {
			try {
				rmSync(all[i]!.dir, { recursive: true, force: true });
			} catch {
				/* eviction is best-effort; the next rotation retries */
			}
		}
		return { dir, manifest };
	} catch {
		return null; // fail-open: snapshots never block startup
	}
}

/** The restore view [C15 docs]: list a snapshot's files (for `cp` commands). */
export function snapshotFiles(snapshot: SnapshotDir): string[] {
	return snapshot.manifest.files.map((f) => f.file);
}
