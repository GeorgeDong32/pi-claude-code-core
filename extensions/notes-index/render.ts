import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";
import type { NoteFile } from "./notes-dir.ts";

export const DESCRIPTION_MAX = 80;
export const PINNED_MAX_FILES = 5;
export const PINNED_TOTAL_MAX = 2_000;
const PINNED_BODY_MAX = 1_200;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function pinnedSection(notes: NoteFile[]): { text: string | null; bytes: number; dropped: number; rendered: Set<string> } {
	const candidates = notes.filter((n) => n.pinned && n.body.length <= PINNED_BODY_MAX);
	const pinnedAll = notes.filter((n) => n.pinned).length;
	const rendered = new Set<string>();
	if (candidates.length === 0) return { text: null, bytes: 0, dropped: pinnedAll, rendered };
	const blocks: string[] = [];
	let size = 0;
	for (const n of candidates.slice(0, PINNED_MAX_FILES)) {
		const block = `### ${n.title}\n\n${n.body.trim()}`;
		const b = bytes(block);
		if (size + b > PINNED_TOTAL_MAX) break;
		blocks.push(block);
		rendered.add(n.file);
		size += b;
	}
	const dropped = pinnedAll - blocks.length;
	if (blocks.length === 0) return { text: null, bytes: 0, dropped, rendered };
	return { text: `## Pinned memories (always active)\n\n${blocks.join("\n\n")}`, bytes: size, dropped, rendered };
}

export function noteRow(n: NoteFile): string {
	const description = (n.description ?? "(no description)").replace(/\s+/g, " ").trim() || "(no description)";
	const mark = n.description !== undefined && n.description.length > DESCRIPTION_MAX ? " ⚠" : "";
	return `- ${n.slug} — ${description}${mark}`;
}

export function buildIndexBlock(dir: string, notes: NoteFile[], pinnedElsewhere: NoteFile[], skipped: number, maxBytes = MEMORY_INDEX_MAX): string {
	const pinned = pinnedSection([...pinnedElsewhere, ...notes]);
	const header = `# Project notes\n\nDirectory: ${dir} — read a note with rg/read when a row is relevant.\n\n`;
	const parts: string[] = [];
	if (pinned.text) parts.push(pinned.text);
	let used = bytes(header) + pinned.bytes;
	const rows: string[] = [];
	for (const n of notes.filter((n) => !pinned.rendered.has(n.file)).sort((a, b) => a.slug.localeCompare(b.slug))) {
		const row = noteRow(n);
		const rowBytes = bytes(row) + 1;
		if (used + rowBytes > maxBytes) break;
		rows.push(row);
		used += rowBytes;
	}
	const total = notes.length - pinned.rendered.size;
	if (rows.length < total) {
		const more = `… +${total - rows.length} more`;
		const moreBytes = bytes(more) + 1;
		if (used + moreBytes > maxBytes && rows.length > 0) {
			used -= bytes(rows.pop() ?? "") + 1;
		}
		rows.push(more);
		used += moreBytes;
	}
	if (rows.length > 0) parts.push(rows.join("\n"));
	if (pinned.dropped > 0) parts.push(`<!-- notes: ${pinned.dropped} pinned note(s) dropped (over budget) -->`);
	if (skipped > 0) parts.push(`<!-- notes: ${skipped} file(s) unreadable -->`);
	return header + parts.join("\n\n");
}
