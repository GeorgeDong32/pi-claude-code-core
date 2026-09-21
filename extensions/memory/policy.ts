/**
 * memory/policy.ts — the persistent policy + index entrypoint appended to
 * the system prompt on before_agent_start (P3-ME-03).
 *
 * POLICY_COMPACT is our own compact rewrite of the CC memory mechanism
 * (check the index, read files on demand, write plain files with
 * frontmatter) — mechanism-aligned wording, no proprietary text.
 */

import type { MemoryEntry } from "./memdir.js";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.js";

export const POLICY_COMPACT = `<memory-policy>
You have a persistent memory directory. Before answering, scan the MEMORY.md
index below; when a listed memory is relevant, read the file (its path is in
the index line) before relying on assumptions.

Writing memories: create plain markdown files in the memory directory with a
frontmatter block:

\`\`\`
---
name: short-kebab-slug
description: one-line summary used for recall
metadata:
  type: user | feedback | project | reference
---

Facts, then "Why:" / "How to apply:" lines for guidance-type memories. Link
related memories with [[their-slug]].
\`\`\`

Update MEMORY.md with ONE line per memory: \`- [Title](file.md) — hook\`.
Write memories proactively when the user states a durable preference, a
correction, or a project fact that is not derivable from the repo. Never
store secrets or credentials.
</memory-policy>`;

/** The capped index entrypoint (≤ MEMORY_INDEX_MAX bytes). */
export function indexEntrypoint(entries: Array<{ title: string; description: string; file: string }>): string {
	const rows: string[] = [];
	let size = 0;
	for (const e of entries) {
		const row = `- [${e.title}](${e.file}) — ${e.description}`;
		if (size + row.length > MEMORY_INDEX_MAX) break;
		rows.push(row);
		size += row.length + 1;
	}
	if (rows.length === 0) return "Memory index: (empty)";
	return `# Memory index\n\n${rows.join("\n")}`;
}

/** Full injection block for before_agent_start. */
export function buildPolicyInjection(entries: Array<{ title: string; description: string; file: string }>): string {
	return `${POLICY_COMPACT}\n\n${indexEntrypoint(entries)}`;
}
