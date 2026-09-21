/**
 * memory/importers — one-shot imports into the canonical memory dir
 * (P3-ME-08). Both are idempotent: re-running produces zero duplicates.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseMemoryFrontmatter, scanMemoryDir, reconcileMemoryIndex } from "./memdir.js";

export interface ImportReport {
	copied: number;
	skipped: number;
	notes: string[];
}

function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "memory";
}

/** /memory-import-claude: copy ~/.claude/projects/<root>/memory/*.md. */
export function importFromClaude(projectMemoryDir: string, targetDir: string): ImportReport {
	const report: ImportReport = { copied: 0, skipped: 0, notes: [] };
	if (!existsSync(projectMemoryDir)) {
		report.notes.push(`no Claude memory dir at ${projectMemoryDir}`);
		return report;
	}
	const files = readdirSync(projectMemoryDir).filter((f) => f.endsWith(".md"));
	// Do NOT trust the source MEMORY.md — rebuild from files.
	for (const file of files) {
		if (file === "MEMORY.md") continue;
		let content: string;
		try {
			content = readFileSync(join(projectMemoryDir, file), "utf-8");
		} catch {
			report.skipped++;
			continue;
		}
		const valid = parseMemoryFrontmatter(content) !== null;
		const targetName = valid ? file : file; // name preserved; validity marked in index rebuild
		const target = join(targetDir, targetName);
		if (existsSync(target)) {
			// idempotent: same file present → skip
			if (readFileSync(target, "utf-8") === content) {
				report.skipped++;
				continue;
			}
		}
		writeFileSync(target, content, "utf-8");
		report.copied++;
	}
	reconcileMemoryIndex(targetDir); // rebuild index from files, never from source MEMORY.md
	return report;
}

/**
 * /memory-import-hermes: split a hermes §-delimited store into per-fact
 * frontmatter files. Section shape: lines starting with `§ ` begin a fact;
 * the first line after the marker is the fact title.
 */
export function importFromHermes(hermesFile: string, targetDir: string): ImportReport {
	const report: ImportReport = { copied: 0, skipped: 0, notes: [] };
	if (!existsSync(hermesFile)) {
		report.notes.push(`no hermes store at ${hermesFile}`);
		return report;
	}
	const raw = readFileSync(hermesFile, "utf-8");
	const sections = raw.split(/^§ /m).map((s) => s.trim()).filter(Boolean);
	const existing = new Set(scanMemoryDir(targetDir).entries.map((e: { file: string }) => e.file));

	for (const section of sections) {
		const lines = section.split("\n");
		const title = slugify(lines[0].replace(/^#+\s*/, "").trim() || "fact");
		const body = lines.slice(1).join("\n").trim();
		if (!body) {
			report.skipped++;
			continue;
		}
		// type heuristics from content
		const type = /prefer|style|always|never|instead/i.test(body)
			? "feedback"
			: /repo|project|branch|build|release/i.test(body)
				? "project"
				: "reference";
		const fileName = `hermes-${title}.md`;
		const frontmatter = `---\nname: ${title}\ndescription: ${lines[0].replace(/^#+\s*/, "").trim().slice(0, 80)}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
		if (existing.has(fileName)) {
			const current = readFileSync(join(targetDir, fileName), "utf-8");
			if (current === frontmatter) {
				report.skipped++;
				continue;
			}
		}
		writeFileSync(join(targetDir, fileName), frontmatter, "utf-8");
		report.copied++;
	}
	reconcileMemoryIndex(targetDir);
	return report;
}
