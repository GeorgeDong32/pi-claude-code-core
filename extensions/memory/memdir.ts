
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MemoryEntry {
	file: string;
	title: string;
	description: string;
	type: string;
	pinned?: boolean;
	paths?: string[];
}

const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);

export function isValidMemoryType(type: string): boolean {
	return VALID_TYPES.has(type);
}

export function isMemoryFile(name: string): boolean {
	return name.endsWith(".md") && name !== "MEMORY.md" && !name.startsWith(".");
}

export function listMemoryFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter(isMemoryFile).sort();
	} catch {
		return [];
	}
}

export function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "memory";
}

export function diagnoseFrontmatter(content: string): string | null {
	if (!content.startsWith("---")) return "no frontmatter block: a memory file must start with a '---' line";
	const lines = content.split("\n");
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) return "frontmatter not closed: missing the closing '---' line";
	const fm: Record<string, string> = {};
	for (let i = 1; i < close; i++) {
		const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i].trim());
		if (!m) return `invalid frontmatter line ${i + 1}: "${lines[i].trim().slice(0, 40)}" is not a key: value pair`;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		fm[m[1]] = v;
	}
	const missing = ["name", "description"].filter((k) => !fm[k]);
	if (missing.length > 0) return `missing required field(s): ${missing.join(", ")}`;
	if (!VALID_TYPES.has(fm.type)) {
		return `invalid metadata.type: ${fm.type ?? "(absent)"} — must be one of ${[...VALID_TYPES].join(", ")}`;
	}
	return null;
}

export function readFrontmatterField(content: string, key: string): string | undefined {
	if (!content.startsWith("---")) return undefined;
	const lines = content.split("\n");
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]!.trim() === "---") break;
		const m = new RegExp(`^${key}:\\s*(\\S.*)$`).exec(lines[i]!.trim());
		if (m) return m[1]!.trim().replace(/^(["'])(.*)\1$/, "$2");
	}
	return undefined;
}

export const AGE_TOLERANCE_MS = 5_000;

export function effectiveAgeMs(content: string, mtimeMs: number, now = Date.now()): number {
	const created = readFrontmatterField(content, "created");
	const consolidatedAt = readFrontmatterField(content, "consolidated_at");
	if (created !== undefined && consolidatedAt !== undefined) {
		const createdMs = Date.parse(created);
		const stampedMs = Date.parse(consolidatedAt);
		if (Number.isFinite(createdMs) && Number.isFinite(stampedMs) && mtimeMs <= stampedMs + AGE_TOLERANCE_MS) {
			return now - createdMs;
		}
	}
	return now - mtimeMs;
}

export function splitFrontmatter(content: string): { title: string; description: string; type: string; pinned: boolean; paths?: string[]; body: string } | null {
	if (diagnoseFrontmatter(content) !== null) return null;
	const lines = content.split("\n");
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			close = i;
			break;
		}
	}
	const fm: Record<string, string> = {};
	for (let i = 1; i < close; i++) {
		const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i].trim());
		let v = m![2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		fm[m![1]] = v;
	}
	return {
		title: fm.name,
		description: fm.description,
		type: fm.type,
		pinned: fm.pinned === "true",
		paths: parsePathsValue(fm.paths),
		body: lines.slice(close + 1).join("\n").replace(/^\n+/, ""),
	};
}

export function parsePathsValue(raw: string | undefined): string[] | undefined {
	if (!raw || !raw.trim()) return undefined;
	const text = raw.trim();
	if (text.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string") && parsed.length > 0) return parsed as string[];
		} catch {
		}
	}
	const items = text.split(",").map((s) => s.trim().replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean);
	return items.length > 0 ? items : undefined;
}

export function parseMemoryFrontmatter(content: string): { title: string; description: string; type: string; pinned?: boolean; paths?: string[] } | null {
	const split = splitFrontmatter(content);
	if (!split) return null;
	return { title: split.title, description: split.description, type: split.type, pinned: split.pinned, paths: split.paths };
}

export function scanMemoryDir(memoryDir: string): { entries: MemoryEntry[]; skipped: number } {
	const entries: MemoryEntry[] = [];
	let skipped = 0;
	const files = listMemoryFiles(memoryDir);
	for (const file of files) {
		try {
			const content = readFileSync(join(memoryDir, file), "utf-8");
			const fm = parseMemoryFrontmatter(content);
			if (!fm) {
				skipped++;
				continue;
			}
			entries.push({ file, title: fm.title, description: fm.description, type: fm.type, pinned: fm.pinned, ...(fm.paths ? { paths: fm.paths } : {}) });
		} catch {
			skipped++;
		}
	}
	return { entries, skipped };
}

export interface MemoryFile {
	entry: MemoryEntry;
	body: string;
	mtimeMs: number;
}

const bodyCache = new Map<string, { fingerprint: string; files: MemoryFile[]; skipped: number; at: number }>();

export const MEMDIR_TTL_MS = 1000;

export function invalidateMemDirCache(memoryDir: string): void {
	bodyCache.delete(memoryDir);
}

function dirFingerprint(memoryDir: string, names: string[]): string {
	const parts: string[] = [];
	for (const f of names) {
		try {
			const st = statSync(join(memoryDir, f));
			parts.push(`${f}:${st.mtimeMs}:${st.size}`);
		} catch {
			parts.push(`${f}:-`);
		}
	}
	return parts.join("|");
}

export function scanMemoryDirCached(memoryDir: string): { files: MemoryFile[]; skipped: number } {
	const cached = bodyCache.get(memoryDir);
	if (cached && Date.now() - cached.at < MEMDIR_TTL_MS) {
		return { files: cached.files, skipped: cached.skipped };
	}
	const names = listMemoryFiles(memoryDir);
	const fingerprint = dirFingerprint(memoryDir, names);
	if (cached && cached.fingerprint === fingerprint) {
		cached.at = Date.now();
		return { files: cached.files, skipped: cached.skipped };
	}
	const files: MemoryFile[] = [];
	let skipped = 0;
	for (const file of names) {
		try {
			const path = join(memoryDir, file);
			const st = statSync(path);
			const content = readFileSync(path, "utf-8");
			const fm = parseMemoryFrontmatter(content);
			if (!fm) {
				skipped++;
				continue;
			}
			files.push({
				entry: { file, title: fm.title, description: fm.description, type: fm.type, pinned: fm.pinned, ...(fm.paths ? { paths: fm.paths } : {}) },
				body: content,
				mtimeMs: st.mtimeMs,
			});
		} catch {
			skipped++;
		}
	}
	bodyCache.set(memoryDir, { fingerprint, files, skipped, at: Date.now() });
	return { files, skipped };
}


export function memoryKey(layer: "user" | "project", file: string): string {
	return layer === "user" ? `user-memory/${file}` : `memory/${file}`;
}

export function eligibleMemories(projectDir: string): Array<import("./recall.ts").RecallFile> {
	const out: Array<import("./recall.ts").RecallFile> = [];
	for (const f of scanMemoryDirCached(projectDir).files) {
		out.push({
			key: memoryKey("project", f.entry.file),
			file: f.entry.file,
			title: f.entry.title,
			description: f.entry.description,
			type: f.entry.type,
			layer: "project",
			mtimeMs: f.mtimeMs,
			absPath: join(projectDir, f.entry.file),
			body: f.body,
		});
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
