import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface NoteFile {
	file: string;
	slug: string;
	title: string;
	description: string | undefined;
	pinned: boolean;
	body: string;
}

export interface NoteScan {
	files: NoteFile[];
	skipped: number;
}

// Index files are navigation, not notes.
const INDEX_FILES = new Set(["MEMORY.md", "index.md"]);

function isNoteFile(name: string): boolean {
	return name.endsWith(".md") && !name.startsWith(".") && !INDEX_FILES.has(name);
}

function listNoteFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter(isNoteFile).sort();
	} catch {
		return [];
	}
}

function readFrontmatter(content: string): { fields: Record<string, string>; close: number } {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return { fields: {}, close: -1 };
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) return { fields: {}, close: -1 };
	const fields: Record<string, string> = {};
	for (let i = 1; i < close; i++) {
		const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i].trim());
		if (!m) continue;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		fields[m[1]] = v;
	}
	return { fields, close };
}

function firstHeading(body: string): string | undefined {
	for (const line of body.split("\n")) {
		const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
		if (m) return m[1];
	}
	return undefined;
}

function loadNote(dir: string, file: string): NoteFile | null {
	try {
		const path = join(dir, file);
		const content = readFileSync(path, "utf-8");
		const { fields, close } = readFrontmatter(content);
		const slug = fields.name || file.replace(/\.md$/, "");
		const body = (close >= 0 ? content.split("\n").slice(close + 1).join("\n") : content).replace(/^\n+/, "");
		const description = fields.description?.trim() || undefined;
		return {
			file,
			slug,
			title: fields.name || firstHeading(body) || slug,
			description: description ?? firstHeading(body),
			pinned: fields.pinned === "true",
			body,
		};
	} catch {
		return null;
	}
}

export function scanNotesDir(dir: string): NoteScan {
	const files: NoteFile[] = [];
	let skipped = 0;
	for (const file of listNoteFiles(dir)) {
		const note = loadNote(dir, file);
		if (note) files.push(note);
		else skipped++;
	}
	return { files, skipped };
}

function dirFingerprint(dir: string, names: string[]): string {
	return names
		.map((f) => {
			try {
				const st = statSync(join(dir, f));
				return `${f}:${st.mtimeMs}:${st.size}`;
			} catch {
				return `${f}:-`;
			}
		})
		.join("|");
}

const cache = new Map<string, { fingerprint: string; scan: NoteScan }>();

// Mid-session note writes must not flip the system prompt and kill the KV
// cache: a scan is reused while the directory's name/mtime/size fingerprint
// is unchanged.
export function scanNotesDirCached(dir: string): NoteScan {
	const names = listNoteFiles(dir);
	const fingerprint = dirFingerprint(dir, names);
	const cached = cache.get(dir);
	if (cached && cached.fingerprint === fingerprint) return cached.scan;
	const scan = scanNotesDir(dir);
	cache.set(dir, { fingerprint, scan });
	return scan;
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
