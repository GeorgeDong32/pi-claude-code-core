/**
 * modes/outside-writes-commands.ts — the /outside-writes and
 * /undo-outside-writes command layer, extracted verbatim from the modes
 * extension factory (index.ts) in SPEC SR W-M (pure relocation, zero
 * behavior change). Lists and restores outside-cwd writes tracked by the
 * auto-mode engine; the snapshot engine itself (track/list/restore/pop)
 * lives in outside-writes.ts — this module only formats and commands.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { notify as uiNotify } from "../ui/notify.ts";
import {
	OutsideWriteSnapshot,
	listTrackedOutsideWrites,
	popTrackedOutsideWrite,
	restoreOutsideWrite,
} from "./outside-writes.ts";

// ---- /outside-writes + /undo-outside-writes (NEW v1.1.3) --------------
// Format a snapshot for display in lists/selectors.
function formatSnapshotForDisplay(
	snap: OutsideWriteSnapshot,
	externallyModified = false,
): string {
	const ts = snap.timestamp.replace("T", " ").slice(0, 19);
	const action = snap.backupContent === null ? "would delete" : "would restore";
	const flag = externallyModified ? " \u26a0 externally modified" : "";
	return `${ts} \u00b7 ${snap.toolName} \u00b7 ${snap.originalPath} (${action})${flag}`;
}

// Detect if a file has been externally modified since its snapshot was taken.
// Heuristic: if multiple snapshots exist for the same path, OR the current
// file content differs from the snapshot's backupContent, the file is
// considered externally modified.
function isExternallyModified(
	snap: OutsideWriteSnapshot,
	allSnaps: OutsideWriteSnapshot[],
): boolean {
	const samePath = allSnaps.filter((s) => s.originalPath === snap.originalPath);
	if (samePath.length > 1) return true;
	try {
		const current = readFileSync(snap.originalPath, "utf-8");
		return current !== snap.backupContent;
	} catch {
		return false;
	}
}

export function registerOutsideWritesCommands(pi: ExtensionAPI): void {
	pi.registerCommand("outside-writes", {
		description:
			"List tracked outside-cwd writes from auto mode (read-only; does not undo)",
		handler: async (_args, ctx) => {
			const snaps = listTrackedOutsideWrites(ctx.cwd);
			if (!snaps.length) {
				if (ctx.hasUI) uiNotify(ctx, "No tracked outside-cwd writes", "info");
				return;
			}
			const lines = snaps.map((s) => formatSnapshotForDisplay(s, isExternallyModified(s, snaps)));
			pi.sendMessage(
				{
					customType: "outside-writes-list",
					content: `Tracked outside-cwd writes (${snaps.length}):\n${lines.join("\n")}`,
					// display metadata for the CC panel renderer (content untouched)
					details: { command: "/outside-writes" },
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.registerCommand("undo-outside-writes", {
		description:
			"Restore files modified by auto mode outside cwd. No args = selector; 'all' = restore all; '--list' = list only",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();

			// --list: alias for /outside-writes
			if (arg === "--list" || arg === "list") {
				const snaps = listTrackedOutsideWrites(ctx.cwd);
				if (!snaps.length) {
					if (ctx.hasUI) uiNotify(ctx, "No tracked outside-cwd writes", "info");
					return;
				}
				const lines = snaps.map((s) => formatSnapshotForDisplay(s, isExternallyModified(s, snaps)));
				pi.sendMessage(
					{
						customType: "outside-writes-list",
						content: `Tracked outside-cwd writes (${snaps.length}):\n${lines.join("\n")}`,
						// display metadata for the CC panel renderer (content untouched)
						details: { command: "/undo-outside-writes --list" },
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			const allSnaps = listTrackedOutsideWrites(ctx.cwd);
			if (!allSnaps.length) {
				if (ctx.hasUI)
					uiNotify(ctx, "No tracked outside-cwd writes to undo", "info");
				return;
			}

			if (arg === "all") {
				// Restore all without prompting
				let restored = 0;
				let deleted = 0;
				let warned = 0;
				const externallyModifiedPaths = new Set(
					allSnaps
						.filter((s) => isExternallyModified(s, allSnaps))
						.map((s) => s.originalPath),
				);
				for (const snap of allSnaps) {
					const result = restoreOutsideWrite(snap);
					if (result.action === "restored") restored++;
					else if (result.action === "deleted") deleted++;
					if (externallyModifiedPaths.has(snap.originalPath)) warned++;
					popTrackedOutsideWrite(ctx.cwd, snap);
				}
				if (ctx.hasUI) {
					const warnMsg =
						warned > 0
							? ` (${warned} file(s) externally modified \u2014 restored anyway)`
							: "";
					uiNotify(ctx,
						`Restored ${restored}, deleted ${deleted} tracked write(s)${warnMsg}`,
						"info",
					);
				}
				return;
			}

			// No args: interactive selector (newest first)
			if (!ctx.hasUI) return; // (S6: the inner hasUI check was unreachable)
			const ordered = [...allSnaps].reverse();
			const choice = await ctx.ui.select(
				"Restore which tracked outside-cwd write? (newest first)",
				ordered.map((s) =>
					formatSnapshotForDisplay(s, isExternallyModified(s, allSnaps)),
				),
			);
			if (!choice) return;
			const picked = ordered.find(
				(s) =>
					formatSnapshotForDisplay(s, isExternallyModified(s, allSnaps)) === choice,
			);
			if (!picked) return;
			const wasExternal = isExternallyModified(picked, allSnaps);
			const result = restoreOutsideWrite(picked);
			popTrackedOutsideWrite(ctx.cwd, picked);
			const action = result.action === "deleted" ? "Deleted" : "Restored";
			const warnSuffix = wasExternal
				? " (\u26a0 file was externally modified \u2014 restored from snapshot anyway)"
				: "";
			uiNotify(ctx, `${action} ${picked.originalPath}${warnSuffix}`, "info");
		},
	});
}
