/**
 * modes/outside-writes.ts — the outside-cwd write snapshot engine.
 * Carved out of the old modes/utils.ts grab-bag (arch review C3, 2026-10-03);
 * behavior unchanged. Owns the <ts>__<hash>.json snapshot records under the
 * project tmp dir (track / list / restore / pop, 100-entry eviction). The
 * command layer lives in modes/index.ts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { getProjectTmpDir, hashPath } from "./path-safety.ts"

const MAX_TRACKED_WRITES = 100

export interface OutsideWriteSnapshot {
	timestamp: string
	originalPath: string
	toolName: "edit" | "write"
	backupContent: string | null
}

/**
 * Persist a snapshot of a write that auto mode performed outside cwd.
 * Filename: `<iso-timestamp-sanitized>__<path-hash>.json`
 *
 * Caps at MAX_TRACKED_WRITES (100) — when full, evicts the oldest by
 * timestamp before writing the new one. This prevents the tmp dir from
 * growing unboundedly in long-running sessions.
 *
 * Never throws — failures are logged via console.warn and swallowed.
 */
export function trackOutsideWrite(
	cwd: string,
	snapshot: OutsideWriteSnapshot,
): void {
	try {
		const dir = getProjectTmpDir(cwd)
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
		if (files.length >= MAX_TRACKED_WRITES) {
			// Evict oldest by filename (which starts with ISO timestamp, sortable)
			const sorted = files.sort()
			const evictCount = files.length - MAX_TRACKED_WRITES + 1
			for (let i = 0; i < evictCount; i++) {
				try {
					unlinkSync(path.join(dir, sorted[i]!))
				} catch {
					/* ignore */
				}
			}
		}
		const safeTs = snapshot.timestamp.replace(/[:.]/g, "-")
		const filename = `${safeTs}__${hashPath(snapshot.originalPath)}.json`
		writeFileSync(
			path.join(dir, filename),
			JSON.stringify(snapshot, null, 2),
			{ mode: 0o600 },
		)
	} catch (err) {
		console.warn("[permission-modes] Failed to track outside write:", err)
	}
}

/**
 * Read all snapshots from the project's tmp dir, sorted by timestamp
 * ascending. Malformed JSON files are skipped (logged). Returns [] on
 * any error or when dir doesn't exist.
 */
export function listTrackedOutsideWrites(
	cwd: string,
): OutsideWriteSnapshot[] {
	try {
		const dir = getProjectTmpDir(cwd)
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
		const snaps: OutsideWriteSnapshot[] = []
		for (const f of files) {
			try {
				const raw = readFileSync(path.join(dir, f), "utf-8")
				const parsed = JSON.parse(raw) as OutsideWriteSnapshot
				// Basic shape validation
				if (
					typeof parsed.timestamp === "string" &&
					typeof parsed.originalPath === "string" &&
					(parsed.toolName === "edit" || parsed.toolName === "write") &&
					(parsed.backupContent === null ||
						typeof parsed.backupContent === "string")
				) {
					snaps.push(parsed)
				}
			} catch (err) {
				console.warn(`[permission-modes] Skipping malformed snapshot ${f}:`, err)
			}
		}
		return snaps.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
	} catch (err) {
		console.warn("[permission-modes] Failed to list tracked writes:", err)
		return []
	}
}

/**
 * Restore the original content (or delete the file if it didn't exist)
 * for a tracked outside write. Returns the action taken.
 *
 * - `backupContent !== null` and file differs → write backup, return `restored`
 * - `backupContent !== null` and file matches → return `noop`
 * - `backupContent === null` and file exists → unlink, return `deleted`
 * - `backupContent === null` and file missing → return `noop`
 *
 * Never throws — file-system errors are returned as `{restored: false, action: "noop"}`.
 */
export function restoreOutsideWrite(snapshot: OutsideWriteSnapshot): {
	restored: boolean
	action: "restored" | "deleted" | "noop"
} {
	try {
		const { originalPath, backupContent } = snapshot
		if (backupContent === null) {
			if (existsSync(originalPath)) {
				unlinkSync(originalPath)
				return { restored: true, action: "deleted" }
			}
			return { restored: true, action: "noop" }
		}
		// Non-null backup: compare current content
		if (existsSync(originalPath)) {
			const current = readFileSync(originalPath, "utf-8")
			if (current === backupContent) {
				return { restored: true, action: "noop" }
			}
		}
		// Write backup (creates parent dirs if needed)
		mkdirSync(path.dirname(originalPath), { recursive: true })
		writeFileSync(originalPath, backupContent, { mode: 0o644 })
		return { restored: true, action: "restored" }
	} catch (err) {
		console.warn("[permission-modes] Failed to restore outside write:", err)
		return { restored: false, action: "noop" }
	}
}

/**
 * Delete the snapshot file corresponding to `snapshot`. Safe to call
 * when the file doesn't exist (no-op).
 *
 * Filename is reconstructed the same way as `trackOutsideWrite`.
 */
export function popTrackedOutsideWrite(
	cwd: string,
	snapshot: OutsideWriteSnapshot,
): void {
	try {
		const dir = getProjectTmpDir(cwd)
		const safeTs = snapshot.timestamp.replace(/[:.]/g, "-")
		const filename = `${safeTs}__${hashPath(snapshot.originalPath)}.json`
		const filepath = path.join(dir, filename)
		if (existsSync(filepath)) unlinkSync(filepath)
	} catch (err) {
		console.warn("[permission-modes] Failed to pop tracked write:", err)
	}
}
