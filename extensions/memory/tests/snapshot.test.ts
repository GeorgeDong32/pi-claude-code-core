/**
 * Entropy-control G2 snapshot tests ([C9]/[C10]) — docs/zh/entropy-control-spec.md.
 *
 * Snapshots are full copies of a memory layer into a sidecar OUTSIDE the
 * memory dir, deduped against the newest by content hash, rotated to
 * SNAPSHOT_KEEP, fail-open, and invisible to the index/recall by
 * construction (non-recursive scan + different root).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listSnapshots, newestSnapshot, SNAPSHOT_KEEP, snapshotLayer, snapshotRoot } from "../snapshot.ts";
import { eligibleMemories } from "../memdir.ts";

let dir: string;
let root: string;
const home = mkdtempSync(join(tmpdir(), "g2-home-"));

test.beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "g2-mem-"));
	root = snapshotRoot(home, "user");
});

test.afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

const write = (name: string, content: string): void => {
	writeFileSync(join(dir, name), content, "utf8");
};
const valid = (name: string, title: string): string => `---\nname: ${title}\ndescription: d\nmetadata:\n  type: project\n---\n\nbody ${name}`;

test("[C9] first snapshot of a layer yields exactly 1 snapshot", () => {
	write("a.md", valid("a", "alpha"));
	const snap = snapshotLayer(dir, root);
	assert.ok(snap !== null, "first snapshot taken");
	assert.equal(listSnapshots(root).length, 1);
	assert.ok(snap!.manifest.files.some((f) => f.file === "a.md"));
});

test("[C9] unchanged content skips — still 1 after a second start", () => {
	write("a.md", valid("a", "alpha"));
	snapshotLayer(dir, root);
	const second = snapshotLayer(dir, root);
	assert.equal(second, null, "identical content → skip");
	assert.equal(listSnapshots(root).length, 1);
});

test("[C9] a change lands a second snapshot", () => {
	write("a.md", valid("a", "alpha"));
	snapshotLayer(dir, root);
	write("a.md", valid("a", "alpha-changed"));
	const second = snapshotLayer(dir, root);
	assert.ok(second !== null);
	assert.equal(listSnapshots(root).length, 2);
});

test("[C9] rotation keeps SNAPSHOT_KEEP, evicting the oldest", () => {
	write("a.md", valid("a", "v0"));
	const stamps: string[] = [];
	for (let i = 1; i <= SNAPSHOT_KEEP + 1; i++) {
		write("a.md", valid("a", `v${i}`));
		// force distinct manifest.at ordering even within one second
		const snap = snapshotLayer(dir, root, () => new Date(Date.UTC(2020, 0, 1, 0, 0, i)));
		assert.ok(snap !== null, `snapshot ${i} taken`);
		stamps.push(snap!.manifest.at);
	}
	const all = listSnapshots(root);
	assert.equal(all.length, SNAPSHOT_KEEP, "kept exactly SNAPSHOT_KEEP");
	assert.equal(all[0]!.manifest.at, stamps[1], "oldest (v1) evicted, v2 is now oldest");
	assert.equal(all[all.length - 1]!.manifest.at, stamps[stamps.length - 1], "newest kept");
});

test("[C9] snapshot failure is fail-open (unwritable root → null, no throw)", () => {
	write("a.md", valid("a", "alpha"));
	const bad = join(home, "no", "such", "root", "deeper");
	// snapshotLayer mkdirs recursively — use a FILE as the root parent to break it
	writeFileSync(join(home, "blocker"), "x");
	const brokenRoot = join(home, "blocker", "snapshots");
	assert.equal(snapshotLayer(dir, brokenRoot), null);
});

test("[C10] files inside a snapshot never surface in the index or recall", () => {
	write("a.md", valid("a", "alpha"));
	const snap = snapshotLayer(dir, root);
	assert.ok(snap !== null);
	// Isolation is CONSTRUCTIONAL: index/recall only ever scan the two layer
	// dirs. Pin both halves — (1) the snapshot root lives outside both layers,
	// (2) the real-layer scan never sees the snapshot's copy even though that
	// copy is a fully valid memory file sitting one path away.
	assert.ok(!snap!.dir.startsWith(dir), "snapshot root outside the layer");
	assert.ok(!dir.startsWith(snap!.dir), "layer outside the snapshot root");
	const emptyUser = mkdtempSync(join(tmpdir(), "g2-empty-"));
	const titles = eligibleMemories(emptyUser, dir).map((f) => f.title);
	assert.deepEqual(titles, ["alpha"], "exactly the layer's own file — no snapshot copy");
	rmSync(emptyUser, { recursive: true, force: true });
});
