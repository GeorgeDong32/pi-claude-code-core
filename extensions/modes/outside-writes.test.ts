import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterSkillsFromPrompt } from "./mode-prompt.ts";
import { OutsideWriteSnapshot, listTrackedOutsideWrites, popTrackedOutsideWrite, restoreOutsideWrite, trackOutsideWrite } from "./outside-writes.ts";
import { getProjectTmpDir } from "./path-safety.ts";

describe("trackOutsideWrite + listTrackedOutsideWrites", () => {
	let tmpDir: string;
	let cwd: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-track-"));
		cwd = tmpDir;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes a snapshot file with all fields", () => {
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: "/home/user/.bashrc",
			toolName: "write",
			backupContent: "old content\n",
		};
		trackOutsideWrite(cwd, snap);
		const list = listTrackedOutsideWrites(cwd);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject(snap);
	});

	it("records null backupContent for new files", () => {
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: "/tmp/brand-new.txt",
			toolName: "write",
			backupContent: null,
		};
		trackOutsideWrite(cwd, snap);
		expect(listTrackedOutsideWrites(cwd)[0].backupContent).toBeNull();
	});

	it("sorts multiple snapshots by timestamp ascending", () => {
		trackOutsideWrite(cwd, { timestamp: "2026-06-29T12:00:02.000Z", originalPath: "/a", toolName: "write", backupContent: null });
		trackOutsideWrite(cwd, { timestamp: "2026-06-29T12:00:01.000Z", originalPath: "/b", toolName: "edit", backupContent: "x" });
		trackOutsideWrite(cwd, { timestamp: "2026-06-29T12:00:03.000Z", originalPath: "/c", toolName: "write", backupContent: null });
		const list = listTrackedOutsideWrites(cwd);
		expect(list.map((s) => s.originalPath)).toEqual(["/b", "/a", "/c"]);
	});

	it("returns empty array when no snapshots exist", () => {
		expect(listTrackedOutsideWrites(cwd)).toEqual([]);
	});

	it("skips malformed snapshot files without throwing", () => {
		const dir = getProjectTmpDir(cwd);
		writeFileSync(join(dir, "garbage.json"), "{not json");
		expect(listTrackedOutsideWrites(cwd)).toEqual([]);
	});

	it("caps at MAX_TRACKED_WRITES (100) and LRU-evicts oldest", () => {
		for (let i = 0; i < 101; i++) {
			trackOutsideWrite(cwd, {
				timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
				originalPath: `/p/${i}`,
				toolName: "write",
				backupContent: null,
			});
		}
		const list = listTrackedOutsideWrites(cwd);
		expect(list).toHaveLength(100);
		expect(list[0].originalPath).toBe("/p/1");
		expect(list[99].originalPath).toBe("/p/100");
	});
});

describe("restoreOutsideWrite + popTrackedOutsideWrite", () => {
	let tmpDir: string;
	let outsideFile: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-restore-"));
		outsideFile = join(tmpDir, "outside.txt");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("restores backup content when backupContent is non-null", () => {
		writeFileSync(outsideFile, "new content");
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: outsideFile,
			toolName: "write",
			backupContent: "original content",
		};
		const result = restoreOutsideWrite(snap);
		expect(result).toEqual({ restored: true, action: "restored" });
		expect(readFileSync(outsideFile, "utf-8")).toBe("original content");
	});

	it("deletes file when backupContent is null", () => {
		writeFileSync(outsideFile, "new content");
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: outsideFile,
			toolName: "write",
			backupContent: null,
		};
		const result = restoreOutsideWrite(snap);
		expect(result).toEqual({ restored: true, action: "deleted" });
		expect(existsSync(outsideFile)).toBe(false);
	});

	it("returns noop when file already restored", () => {
		writeFileSync(outsideFile, "original");
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: outsideFile,
			toolName: "write",
			backupContent: "original",
		};
		const result = restoreOutsideWrite(snap);
		expect(result.action).toBe("noop");
		expect(readFileSync(outsideFile, "utf-8")).toBe("original");
	});

	it("deletes file on noop when backupContent is null and file missing", () => {
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: outsideFile,
			toolName: "write",
			backupContent: null,
		};
		const result = restoreOutsideWrite(snap);
		expect(result.action).toBe("noop");
	});

	it("popTrackedOutsideWrite removes the snapshot file", () => {
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: "/x",
			toolName: "write",
			backupContent: null,
		};
		trackOutsideWrite(tmpDir, snap);
		expect(listTrackedOutsideWrites(tmpDir)).toHaveLength(1);
		popTrackedOutsideWrite(tmpDir, snap);
		expect(listTrackedOutsideWrites(tmpDir)).toHaveLength(0);
	});

	it("popTrackedOutsideWrite is safe when file missing", () => {
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: "/x",
			toolName: "write",
			backupContent: null,
		};
		expect(() => popTrackedOutsideWrite(tmpDir, snap)).not.toThrow();
	});
});
