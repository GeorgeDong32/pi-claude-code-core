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
			const sorted = files.sort()
			const evictCount = files.length - MAX_TRACKED_WRITES + 1
			for (let i = 0; i < evictCount; i++) {
				try {
					unlinkSync(path.join(dir, sorted[i]!))
				} catch {
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
		if (existsSync(originalPath)) {
			const current = readFileSync(originalPath, "utf-8")
			if (current === backupContent) {
				return { restored: true, action: "noop" }
			}
		}
		mkdirSync(path.dirname(originalPath), { recursive: true })
		writeFileSync(originalPath, backupContent, { mode: 0o644 })
		return { restored: true, action: "restored" }
	} catch (err) {
		console.warn("[permission-modes] Failed to restore outside write:", err)
		return { restored: false, action: "noop" }
	}
}

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
