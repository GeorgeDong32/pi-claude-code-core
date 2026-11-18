
import type { MemoryEntry } from "./memdir.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";

export const USER_INDEX_MAX = 8_000;

export const PINNED_TOTAL_MAX = 2_000;
export const PINNED_MAX_FILES = 5;

export const POLICY_MARKER = "<memory-policy";

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
Scope tie-breakers (when a fact could land in either layer):
- Repo-specific facts — paths, workflows, conventions, toolchain choices,
  module internals, commit/PR state, lessons from this codebase — belong
  to PROJECT. Facts shared by several sibling repos of one workspace may
  stay in USER with a paths: ["~/Coding/Workspace/**"] frontmatter line
  (inline list; ~ expands at read time).
  A single-repo fact never justifies a USER entry.
- USER memory is only for what holds in EVERY project: identity,
  communication style, machine-level facts (hardware/OS/network/globals)
  and cross-project tool behavior (e.g. pi itself). The USER index is a
  machine-global budget — every line in it taxes recall in all sessions.
- When unsure, choose PROJECT: a project fact in USER pollutes every
  other session's recall; a user fact in PROJECT is merely duplicated.
Write memories proactively when the user states a durable preference, a
correction, or a project fact that is not derivable from the repo. Never
store secrets or credentials.
</memory-policy>`;
}

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

export interface LayerInput {
	entries: Array<{ title: string; description: string; file: string }>;
	files?: Array<{ entry: MemoryEntry; body: string }>;
}

export function userLayerSection(input: LayerInput): { text: string; bytes: number } {
	const pinned = pinnedSection(input.files ?? []);
	const pinnedBytes = pinned.text ? Buffer.byteLength(pinned.text, "utf8") : 0;
	const [rows] = cappedRows(input.entries, USER_INDEX_MAX - pinnedBytes - (pinned.text ? 2 : 0) - 64);
	const rowText = rows.length > 0 ? `# User memory index (cross-project)\n\n${rows.join("\n")}` : null;

	let text: string | null = null;
	let dropped = pinned.dropped;
	if (rowText && pinned.text) text = `${rowText}\n\n${pinned.text}`;
	else if (rowText) text = rowText;
	else if (pinned.text) text = pinned.text;

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

function countRendered(pinnedText: string): number {
	return (pinnedText.match(/^### /gm) ?? []).length;
}

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

export function buildPolicyInjection(user: LayerInput, project: Array<{ title: string; description: string; file: string }>, projectMemoryDir: string): string {
	const userLayer = userLayerSection(user);
	const projectLayer = projectLayerSection(project, userLayer.bytes);
	return `${policyCompact(projectMemoryDir)}\n\n${userLayer.text}\n\n${projectLayer.text}`;
}


