import type { MemoryEntry } from "./memdir.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";

export const PINNED_TOTAL_MAX = 2_000;
export const PINNED_MAX_FILES = 5;

/** Descriptions are the index rows and the recall match surface: a noun
 * phrase with the topic keywords, never a sentence. Enforced on every write
 * path (store.ts ops, policy guidance); the index marks violators. */
export const DESCRIPTION_MAX = 80;
export function descriptionTooLong(description: string): boolean {
	return description.length > DESCRIPTION_MAX;
}

export const POLICY_MARKER = "<memory-policy";

/**
 * Single-layer policy (the user layer is retired). One project store, one
 * index, slim writing guidance that keeps proactive writing. The retired
 * cross-project layer is named only to keep the model from reinventing it;
 * pinned files remaining in the old user dir are still injected until their
 * migration completes.
 */
export function policyCompact(projectMemoryDir: string): string {
	return `${POLICY_MARKER}>
You have persistent PROJECT memory at ${projectMemoryDir} — facts about this
repository: paths, workflows, conventions, lessons that only apply here.
Scan the index below before relying on an assumption; when a listed memory
is relevant, read its file first: <this dir>/<slug>.md, or call
memory_lookup(name). Write project memories HERE, exactly at this path —
NOT in a memory/ directory inside the repository (that location is never
read).

Where to look for what: this repository's facts → the index below /
memory_lookup; earlier sessions of this project →
knowledge_search(scope: "sessions"); other knowledge roots your settings
list (notes vaults) → knowledge_search(scope: "roots").

Writing memories: create plain markdown files with a frontmatter block:

\`\`\`
---
name: short-kebab-slug
description: noun phrase, at most 80 characters, with the topic keywords (used for recall)
metadata:
  type: project | feedback | reference
  pinned: true          # optional — always-active instruction (use sparingly)
---

Conclusion first, then "Why:" / "How to apply:" lines for guidance-type
memories; under 10 lines, no task log. Link related memories with
[[their-slug]].
\`\`\`

Save only what cannot be read from the repo, environment or git history and
will still matter later. Do not save task progress, current state, secrets,
or the user's current requirements, open questions and pending
confirmations — those live in the conversation, not in memory. Never write
memory outside ${projectMemoryDir}: the cross-project user layer is retired,
and cross-project knowledge belongs in the user's own notes. A row marked
⚠ has an over-long description: rewrite it as a noun phrase when you touch
that memory.

Both the directory and the MEMORY.md index already exist — write files
directly, and never edit MEMORY.md by hand (it is derived). Merging,
deduplication and pruning run via /memory-consolidate on request; do not
reorganize memory mid-task.
</memory-policy>`;
}

function cappedRows(
	entries: Array<{ title: string; description: string; file: string }>,
	maxBytes: number,
): [string[], number] {
	const rows: string[] = [];
	let size = 0;
	for (const e of entries) {
		// One slug per row, never a repeated markdown link: the row names the
		// file stem (so <dir>/<slug>.md resolves). Imported files whose name
		// differs from the stem (fingerprint suffixes) show the file in
		// parentheses so both stay greppable.
		const stem = e.file.replace(/\.md$/, "");
		const slug = e.title && e.title !== stem ? `${e.title} (${e.file})` : stem;
		const description = e.description.replace(/\s+/g, " ").trim();
		const row = `- ${slug} — ${description}${descriptionTooLong(e.description) ? " ⚠" : ""}`;
		const rowBytes = Buffer.byteLength(row, "utf8");
		if (size + rowBytes > maxBytes) break;
		rows.push(row);
		size += rowBytes + 1;
	}
	return [rows, size];
}

function pinnedSection(files: Array<{ entry: MemoryEntry; body: string }>): { text: string | null; bytes: number; dropped: number } {
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

function countRendered(pinnedText: string): number {
	return (pinnedText.match(/^### /gm) ?? []).length;
}

export interface PinnedInput {
	entries: Array<{ title: string; description: string; file: string }>;
	files?: Array<{ entry: MemoryEntry; body: string }>;
}

export function buildPolicyInjection(pinned: PinnedInput, project: Array<{ title: string; description: string; file: string }>, projectMemoryDir: string): string {
	const pinnedBlock = pinnedSection(pinned.files ?? []);
	const header = `# Project memory index\n\n`;
	const headerBytes = Buffer.byteLength(header, "utf8");
	const remaining = Math.max(0, MEMORY_INDEX_MAX - pinnedBlock.bytes - headerBytes);
	const [rows] = cappedRows(project, remaining);
	const rowText = rows.length > 0 ? `${header}${rows.join("\n")}` : "Project memory index: (empty)";

	const parts: string[] = [policyCompact(projectMemoryDir)];
	if (pinnedBlock.text) parts.push(pinnedBlock.text);
	parts.push(rowText);
	let text = parts.join("\n\n");
	if (pinnedBlock.dropped > 0) {
		const note = `<!-- memory: ${pinnedBlock.dropped} pinned file(s) dropped (over budget) -->`;
		if (Buffer.byteLength(`${text}\n${note}`, "utf8") <= MEMORY_INDEX_MAX) text = `${text}\n${note}`;
	}
	return text;
}
