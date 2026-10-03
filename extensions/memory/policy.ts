/**
 * memory/policy.ts — the persistent policy + two-layer index entrypoint
 * appended to the system prompt on before_agent_start (P3-ME-03, V2-D1).
 *
 * Budget contract (DESIGN-MEMORY-V2 §1): user index (≤ USER_INDEX_MAX,
 * including pinned bodies) renders first, then the project index gets the
 * REMAINder of the memory lane so the total never exceeds
 * lib/context-budget MEMORY_INDEX_MAX.
 *
 * POLICY_COMPACT is our own compact rewrite of the CC memory mechanism
 * (check the index, read files on demand, write plain files with
 * frontmatter) — mechanism-aligned wording, no proprietary text.
 */

import type { MemoryEntry } from "./memdir.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";

/** User-layer index + pinned budget (renders before the project index).
 * S3 (OPT-3): injection-lane budgets live with their only enforcer. */
export const USER_INDEX_MAX = 8_000;

/** Pinned bodies section cap, shared across all pinned files (hermes
 * STANDING_MAX_CHARS=2000 semantics — always-on instructions stay tiny). */
export const PINNED_TOTAL_MAX = 2_000;
export const PINNED_MAX_FILES = 5;

/** Injection-lane marker shared by the policy renderer and the yield
 * probe (B2): the probe greps for this opening tag fragment in the system
 * prompt — one constant, both sides, a rename is a compile error. */
export const POLICY_MARKER = "<memory-policy";

/** The policy block with the REAL project-layer directory interpolated.
 *
 * Path-mismatch fix (2026-10-03, project memory
 * core-memory-policy-path-mismatch): the old static text said
 * `<project>/memory/` (a literal directory inside the repo) while the
 * implementation reads/writes ~/.pi/agent/projects/<git-root>/memory/ — a
 * session followed the literal text and wrote memories into the repo root
 * (untracked, never indexed, never recalled). The model now sees the
 * actual absolute path; the explicit "NOT inside the repository" clause
 * guards the residual habit. */
export function policyCompact(projectMemoryDir: string): string {
	return `${POLICY_MARKER}>
You have persistent memory in TWO layers. Before answering, scan the memory
indexes below; when a listed memory is relevant, read the file (its path is
in the index line) before relying on assumptions.

- USER memory (~/.pi/agent/memory/): who the user is, cross-project
  preferences, communication style — true in every project.
- PROJECT memory (${projectMemoryDir}): facts about this repository —
  paths, workflows, conventions, lessons that only apply here. Write
  project memories HERE, exactly at this path — NOT in a memory/
  directory inside the repository (that location is never read).

Writing memories: create plain markdown files in the RIGHT layer with a
frontmatter block:

\`\`\`
---
name: short-kebab-slug
description: one-line summary used for recall
metadata:
  type: user | feedback | project | reference
  pinned: true          # optional — always-active instruction (use sparingly)
---

Facts, then "Why:" / "How to apply:" lines for guidance-type memories. Link
related memories with [[their-slug]].
\`\`\`

Both memory directories already exist — write files directly, no ls/mkdir
needed. The MEMORY.md index in each layer is derived automatically; do not
edit it by hand.
Scope: THIS repository's facts belong in PROJECT memory; only what holds in
every project belongs in USER memory. A user-layer file that should stay out
of most projects may carry a scoping line in its frontmatter —
paths: ["~/Coding/SomeRepo/**"] (inline list; ~ expands at read time).
Write memories proactively when the user states a durable preference, a
correction, or a project fact that is not derivable from the repo. Never
store secrets or credentials.
</memory-policy>`;
}

/** Rows of a capped index; returns [rows, bytesUsed]. */
function cappedRows(
	entries: Array<{ title: string; description: string; file: string }>,
	maxBytes: number,
): [string[], number] {
	const rows: string[] = [];
	let size = 0;
	for (const e of entries) {
		const row = `- [${e.title}](${e.file}) — ${e.description}`;
		const rowBytes = Buffer.byteLength(row, "utf8");
		if (size + rowBytes > maxBytes) break;
		rows.push(row);
		size += rowBytes + 1;
	}
	return [rows, size];
}

/** Pinned bodies section (V2-D5): always-active instructions, ≤5 files,
 * PINNED_TOTAL_MAX bytes shared — a file that does not fit whole is DROPPED,
 * never truncated (a cut instruction is worse than a missing one). */
function pinnedSection(files: Array<{ entry: MemoryEntry; body: string }>): { text: string | null; bytes: number; dropped: number } {
	// a standing instruction longer than this is not a standing instruction
	const candidates = files.filter((f) => f.entry.pinned && f.body.length <= 1200);
	if (candidates.length === 0) return { text: null, bytes: 0, dropped: files.filter((f) => f.entry.pinned).length };
	const pinned = candidates.slice(0, PINNED_MAX_FILES);
	const blocks: string[] = [];
	let size = 0;
	for (const f of pinned) {
		const block = `### ${f.entry.title}\n\n${f.body}`;
		const blockBytes = Buffer.byteLength(block, "utf8");
		if (size + blockBytes > PINNED_TOTAL_MAX) break;
		blocks.push(block);
		size += blockBytes;
	}
	const rendered = blocks.length;
	const dropped = files.filter((f) => f.entry.pinned).length - rendered;
	if (rendered === 0) return { text: null, bytes: 0, dropped };
	return { text: `## Pinned memories (always active)\n\n${blocks.join("\n\n")}`, bytes: size, dropped };
}

export interface LayerInput {
	entries: Array<{ title: string; description: string; file: string }>;
	/** Full files (frontmatter+body) — only pinned ones are rendered. */
	files?: Array<{ entry: MemoryEntry; body: string }>;
}

/** User-layer section: index rows + pinned bodies, capped at USER_INDEX_MAX
 * with EXACT byte accounting (B5, OPT-3) — headers and joins count, so the
 * lane total below is a hard bound, not ~70B-over. Pinned files that don't
 * fit (per-file cap, the 5-file cap, or lane overflow) are dropped whole
 * and reported in a trailing comment. */
export function userLayerSection(input: LayerInput): { text: string; bytes: number } {
	const pinned = pinnedSection(input.files ?? []);
	const pinnedBytes = pinned.text ? Buffer.byteLength(pinned.text, "utf8") : 0;
	// rows get whatever the pinned block leaves of the lane
	const [rows] = cappedRows(input.entries, USER_INDEX_MAX - pinnedBytes - (pinned.text ? 2 : 0) - 64);
	const rowText = rows.length > 0 ? `# User memory index (cross-project)\n\n${rows.join("\n")}` : null;

	let text: string | null = null;
	let dropped = pinned.dropped;
	if (rowText && pinned.text) text = `${rowText}\n\n${pinned.text}`;
	else if (rowText) text = rowText;
	else if (pinned.text) text = pinned.text;

	// pinned alone overflowing the lane → drop it whole (never truncate)
	if (text && Buffer.byteLength(text, "utf8") > USER_INDEX_MAX && pinned.text) {
		text = rowText;
		dropped = pinned.dropped + (pinned.text ? countRendered(pinned.text) : 0);
	}
	if (!text) text = "User memory index: (empty)";
	if (dropped > 0) {
		const note = `<!-- memory: ${dropped} pinned file(s) dropped (over budget) -->`;
		if (Buffer.byteLength(`${text}\n${note}`, "utf8") <= USER_INDEX_MAX) text = `${text}\n${note}`;
	}
	return { text, bytes: Buffer.byteLength(text, "utf8") };
}

/** How many rendered pinned blocks a section text carries (for the drop note). */
function countRendered(pinnedText: string): number {
	return (pinnedText.match(/^### /gm) ?? []).length;
}

/** Project-layer section: capped at whatever remains of the lane budget —
 * header included (B5 exact accounting). */
export function projectLayerSection(
	entries: Array<{ title: string; description: string; file: string }>,
	userBytesUsed: number,
): { text: string; bytes: number } {
	const header = `# Project memory index\n\n`;
	const headerBytes = Buffer.byteLength(header, "utf8");
	const remaining = Math.max(0, MEMORY_INDEX_MAX - userBytesUsed - headerBytes);
	const [rows] = cappedRows(entries, remaining);
	const text = rows.length > 0 ? `${header}${rows.join("\n")}` : "Project memory index: (empty)";
	return { text, bytes: Buffer.byteLength(text, "utf8") };
}

/** Full injection block for before_agent_start (V2 two-layer shape). */
export function buildPolicyInjection(user: LayerInput, project: Array<{ title: string; description: string; file: string }>, projectMemoryDir: string): string {
	const userLayer = userLayerSection(user);
	const projectLayer = projectLayerSection(project, userLayer.bytes);
	return `${policyCompact(projectMemoryDir)}\n\n${userLayer.text}\n\n${projectLayer.text}`;
}


