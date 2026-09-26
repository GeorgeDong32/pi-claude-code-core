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

import type { MemoryEntry } from "./memdir.js";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.js";
import { USER_INDEX_MAX, PINNED_TOTAL_MAX, PINNED_MAX_FILES } from "./constants.js";

export const POLICY_COMPACT = `<memory-policy>
You have persistent memory in TWO layers. Before answering, scan the memory
indexes below; when a listed memory is relevant, read the file (its path is
in the index line) before relying on assumptions.

- USER memory (~/.pi/agent/memory/): who the user is, cross-project
  preferences, communication style — true in every project.
- PROJECT memory (<project>/memory/): facts about this repository — paths,
  workflows, conventions, lessons that only apply here.

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

Update MEMORY.md in the same layer with ONE line per memory:
\`- [Title](file.md) — hook\`.
Write memories proactively when the user states a durable preference, a
correction, or a project fact that is not derivable from the repo. Never
store secrets or credentials.
</memory-policy>`;

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
function pinnedSection(files: Array<{ entry: MemoryEntry; body: string }>): { text: string | null; bytes: number } {
	// a standing instruction longer than this is not a standing instruction
	const pinned = files.filter((f) => f.entry.pinned && f.body.length <= 1200).slice(0, PINNED_MAX_FILES);
	if (pinned.length === 0) return { text: null, bytes: 0 };
	const blocks: string[] = [];
	let size = 0;
	for (const f of pinned) {
		const block = `### ${f.entry.title}\n\n${f.body}`;
		const blockBytes = Buffer.byteLength(block, "utf8");
		if (size + blockBytes > PINNED_TOTAL_MAX) break;
		blocks.push(block);
		size += blockBytes;
	}
	if (blocks.length === 0) return { text: null, bytes: 0 };
	return { text: `## Pinned memories (always active)\n\n${blocks.join("\n\n")}`, bytes: size };
}

export interface LayerInput {
	entries: Array<{ title: string; description: string; file: string }>;
	/** Full files (frontmatter+body) — only pinned ones are rendered. */
	files?: Array<{ entry: MemoryEntry; body: string }>;
}

/** User-layer section: index rows + pinned bodies, capped at USER_INDEX_MAX. */
export function userLayerSection(input: LayerInput): { text: string; bytes: number } {
	const parts: string[] = [];
	let total = 0;
	const [rows, rowsBytes] = cappedRows(input.entries, USER_INDEX_MAX);
	if (rows.length > 0) {
		parts.push(`# User memory index (cross-project)\n\n${rows.join("\n")}`);
		total += rowsBytes + 40;
	}
	const pinned = pinnedSection(input.files ?? []);
	if (pinned.text && total + pinned.bytes <= USER_INDEX_MAX) {
		parts.push(pinned.text);
		total += pinned.bytes;
	}
	if (parts.length === 0) return { text: "User memory index: (empty)", bytes: 32 };
	return { text: parts.join("\n\n"), bytes: total };
}

/** Project-layer section: capped at whatever remains of the lane budget. */
export function projectLayerSection(
	entries: Array<{ title: string; description: string; file: string }>,
	userBytesUsed: number,
): { text: string; bytes: number } {
	const remaining = Math.max(0, MEMORY_INDEX_MAX - userBytesUsed);
	const [rows, bytes] = cappedRows(entries, remaining);
	if (rows.length === 0) return { text: "Project memory index: (empty)", bytes: 32 };
	return { text: `# Project memory index\n\n${rows.join("\n")}`, bytes };
}

/** Full injection block for before_agent_start (V2 two-layer shape). */
export function buildPolicyInjection(user: LayerInput, project: Array<{ title: string; description: string; file: string }>): string {
	const userLayer = userLayerSection(user);
	const projectLayer = projectLayerSection(project, userLayer.bytes);
	return `${POLICY_COMPACT}\n\n${userLayer.text}\n\n${projectLayer.text}`;
}

/** @deprecated V1 single-layer shape — kept for the policy-only degradation
 * path where only the policy block (no indexes) is injected. */
export function indexEntrypoint(entries: Array<{ title: string; description: string; file: string }>): string {
	const [rows] = cappedRows(entries, MEMORY_INDEX_MAX);
	if (rows.length === 0) return "Memory index: (empty)";
	return `# Memory index\n\n${rows.join("\n")}`;
}
