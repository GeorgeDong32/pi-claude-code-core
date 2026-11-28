import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify as uiNotify } from "../ui/notify.ts";
import {
	matchProtectedPath,
	protectedPathBlockReason,
	protectedPathFiles,
	sessionHome,
} from "./protected-paths.ts";

type Baseline = Map<string, string | null>;

function sha256Of(file: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return null;
	}
}

function takeBaseline(ctx: ExtensionContext): Baseline {
	try {
		return new Map(
			protectedPathFiles({ home: sessionHome(), cwd: ctx.cwd ?? process.cwd() }).map((f) => [f, sha256Of(f)] as const),
		);
	} catch {
		return new Map();
	}
}

function changedSince(baseline: Baseline): string[] {
	const changed: string[] = [];
	for (const [file, was] of baseline) {
		if (sha256Of(file) !== was) changed.push(file);
	}
	return changed;
}

// [C4] self-modification boundary: the write/edit tools never touch pi's own
// governance files, in every mode; a sha256 baseline catches edits made by
// other means between session_start and agent_end and warns once.
export default function protectedWritesExtension(pi: ExtensionAPI): void {
	let baseline: Baseline = new Map();
	let noticeShown = false;

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		noticeShown = false;
		baseline = takeBaseline(ctx);
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		try {
			const input = (event.input ?? {}) as Record<string, unknown>;
			const target = typeof input.path === "string" ? input.path : "";
			const hit = matchProtectedPath(target, { home: sessionHome(), cwd: ctx.cwd ?? process.cwd() });
			if (hit) return { block: true, reason: protectedPathBlockReason(hit) };
		} catch {
		}
		return undefined;
	});

	pi.on("agent_end", (_event, ctx: ExtensionContext) => {
		try {
			if (noticeShown || baseline.size === 0) return;
			const changed = changedSince(baseline);
			if (changed.length === 0) return;
			noticeShown = true;
			if (ctx?.hasUI) {
				uiNotify(
					ctx,
					`Protected files changed outside the tool guard: ${changed.join(", ")} — if this was not your own manual edit, review them.`,
					"warning",
				);
			}
		} catch {
		}
	});
}
