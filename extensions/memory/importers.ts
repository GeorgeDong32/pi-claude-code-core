/**
 * memory/importers — one-shot imports into the canonical memory dir
 * (P3-ME-08). Both are idempotent: re-running produces zero duplicates.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reconcileMemoryIndex, slugify } from "./memdir.ts";

export interface ImportReport {
	copied: number;
	skipped: number;
	notes: string[];
}

/** /memory-import-claude: copy ~/.claude/projects/<root>/memory/*.md. */
export function importFromClaude(projectMemoryDir: string, targetDir: string): ImportReport {
	const report: ImportReport = { copied: 0, skipped: 0, notes: [] };
	if (!existsSync(projectMemoryDir)) {
		report.notes.push(`no Claude memory dir at ${projectMemoryDir}`);
		return report;
	}
	const files = readdirSync(projectMemoryDir).filter((f) => f.endsWith(".md"));
	// The target project may never have been opened in pi — create the layer
	// dir before the first write (found live: migrating a CC project that has
	// no pi-side dir yet failed with ENOENT on the first file).
	mkdirSync(targetDir, { recursive: true });
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
		// validity is re-derived by the reconciler at index rebuild — the
		// file is copied as-is either way
		const target = join(targetDir, file);
		if (existsSync(target)) {
			// idempotent for identical content; local edits win — a re-import
			// must never silently clobber what the user changed since
			if (readFileSync(target, "utf-8") !== content) {
				report.notes.push(`${file}: kept local (differs from source; delete to re-import)`);
			}
			report.skipped++;
			continue;
		}
		writeFileSync(target, content, "utf-8");
		report.copied++;
	}
	reconcileMemoryIndex(targetDir); // rebuild index from files, never from source MEMORY.md
	return report;
}

/**
 * /memory-import-hermes: split a hermes §-delimited store into per-fact
 * frontmatter files. Section shape: a line containing only `§` separates
 * facts; the first line of a fact is its de-facto title; trailing HTML
 * comments carry created/last/project64 metadata.
 */
export function importFromHermes(hermesFile: string, targetDir: string): ImportReport {
	const report: ImportReport = { copied: 0, skipped: 0, notes: [] };
	if (!existsSync(hermesFile)) {
		report.notes.push(`no hermes store at ${hermesFile}`);
		return report;
	}
	const raw = readFileSync(hermesFile, "utf-8");
	const sections = splitHermesSections(raw);

	for (const rawSection of sections) {
		const section = parseHermesSection(rawSection);
		if (!section.body) {
			report.skipped++;
			continue;
		}
		const outcome = importSection(section, targetDir, typeHeuristic(section.body));
		if (outcome === "copied") report.copied++;
		else {
			if (outcome === "collision") report.notes.push(`slug collision on "${section.firstLine.slice(0, 40)}" — two distinct facts share it; rename one manually`);
			report.skipped++;
		}
	}
	reconcileMemoryIndex(targetDir);
	return report;
}


/** B6 (OPT-3): read a still-live hermes source safely — if its mtime moves
 * across the read (hermes flushing on message_end), the content may be a
 * torn section; the migration is idempotent so a flagged re-run heals it.
 * The read function is injectable for tests. */
export function readSourceStable(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf-8")): { raw: string; torn: boolean } {
	const mtime = (p: string): number => {
		try {
			return statSync(p).mtimeMs;
		} catch {
			return -1;
		}
	};
	const before = mtime(path);
	const raw = read(path);
	return { raw, torn: mtime(path) !== before };
}

// ─── V2-M: full hermes migration (DESIGN-MEMORY-V2 §7) ───

export interface HermesMigrationReport extends ImportReport {
	/** sections routed to each core layer */
	routed: { user: number; project: number };
	/** hermes projects-memory projects that do NOT match the current cwd */
	otherProjects: string[];
}

/** Split a hermes store on §-prefixed separator lines. Both on-disk shapes
 * are supported: a line containing ONLY `§` (real hermes data) and the
 * `§ Title` prefix form (v1 fixture shape); the v1 `/^§ /m`-only split
 * never matched actual hermes data. */
export function splitHermesSections(raw: string): string[] {
	return raw
		.split(/^§(?:[ \t]+|[ \t]*$)/m)
		.map((s) => s.trim())
		.filter(Boolean);
}

export interface HermesSection {
	firstLine: string;
	body: string;
	created?: string;
	project64?: string;
}

/** Parse one section: first line = title, body = rest. Trailing hermes
 * metadata comments (`<!-- created=…, project64=… -->`, sometimes stacked)
 * are stripped from the body and merged into the metadata. */
export function parseHermesSection(section: string): HermesSection {
	const attrRe = /<!--\s*(created=[^>]*?)\s*-->/g;
	let created = "";
	let project64: string | undefined;
	for (const m of section.matchAll(attrRe)) {
		const inner = m[1]!;
		created = created ? `${created}; ${inner}` : inner;
		const p64 = /project64=([A-Za-z0-9+/=]+)/.exec(inner);
		if (p64 && !project64) project64 = p64[1]!;
	}
	const body = section.replace(attrRe, "").trim();
	const lines = body.split("\n");
	return { firstLine: lines[0] ?? "", body, created: created || undefined, project64 };
}

function typeHeuristic(body: string): string {
	return /prefer|style|always|never|instead|偏好|总是|不要|别/i.test(body)
		? "feedback"
		: /repo|project|branch|build|release|仓库|分支|构建/i.test(body)
			? "project"
			: "reference";
}

/** Import one section into a layer dir. Returns "copied" | "skipped" | "dup". */
function importSection(
	section: HermesSection,
	targetDir: string,
	type: string,
	descriptionPrefix = "",
	seen?: Set<string>,
	fileNamePrefix = "hermes-",
): "copied" | "skipped" | "dup" | "collision" {
	// cross-source dedupe: same leading 120 chars = same fact (MEMORY.md and
	// failures.md overlap by design in hermes)
	const fp = section.body.replace(/\s+/g, " ").slice(0, 120).toLowerCase();
	if (seen) {
		if (seen.has(fp)) return "dup";
		seen.add(fp);
	}
	const title = section.firstLine.replace(/^#+\s*/, "").trim().slice(0, 60) || "fact";
	const base = slugify(`${descriptionPrefix}${title}`) || "memory";
	const description = `${descriptionPrefix}${section.firstLine.replace(/^#+\s*/, "").trim().slice(0, 90)}`;
	const created = section.created ? `\n\n<!-- hermes: ${section.created} -->` : "";
	// D1: distinct facts whose titles collapse to the same slug (pure-CJK
	// titles all strip to "memory") must not silently drop the second one —
	// disambiguate with a body-fingerprint suffix; content match on either
	// slot keeps re-runs idempotent
	for (const candidate of [base, `${base}-${Buffer.from(fp).toString("hex").slice(0, 6)}`]) {
		const fileName = `${fileNamePrefix}${candidate}.md`;
		const target = join(targetDir, fileName);
		if (!existsSync(target)) {
			mkdirSync(targetDir, { recursive: true });
			const frontmatter = `---\nname: ${candidate}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${section.body}${created}\n`;
			writeFileSync(target, frontmatter, "utf-8");
			return "copied";
		}
		if (readFileSync(target, "utf-8").includes(section.body)) return "skipped"; // same fact — idempotent
	}
	return "collision"; // both slots held by different facts — caller surfaces a note
}

/** Decode a hermes project64 tag ("Q2hlcnJ5UJI" → "CherryPR"); null on failure. */
export function decodeProject64(b64: string): string | null {
	try {
		const decoded = Buffer.from(b64, "base64").toString("utf-8");
		return decoded.trim() || null;
	} catch {
		return null;
	}
}

/** The core project key for a memory dir (.../projects/<key>/memory). */
export function projectKeyOf(memoryDir: string): string {
	const parts = memoryDir.replace(/\\/g, "/").split("/");
	return parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
}

/** Does a hermes project name refer to the current project? Rule: the core
 * sanitized project key equals the name or ends with "-<name>". */
export function projectMatchesCurrent(hermesName: string, memoryDir: string): boolean {
	const key = projectKeyOf(memoryDir);
	return key === hermesName || key.endsWith(`-${hermesName}`);
}

/**
 * /memory-import-hermes (no args) — full migration:
 *   USER.md                    → user layer (type user)
 *   MEMORY.md untagged         → user layer
 *   MEMORY.md project64=this   → project layer; other tags → user layer + [tag]
 *   failures.md                → type feedback, same routing, category prefix
 *   projects-memory/<n>/MEMORY.md matching this cwd → project layer
 * Copy-not-move; idempotent; cross-source dedupe; other projects listed.
 */
export function importHermesFull(args: {
	agentDir: string;
	/** the CURRENT project's memory dir (routing target for matching sections) */
	projectMemoryDir: string;
	userMemoryDir: string;
}): HermesMigrationReport {
	const report: HermesMigrationReport = { copied: 0, skipped: 0, notes: [], routed: { user: 0, project: 0 }, otherProjects: [] };
	const hermesDir = join(args.agentDir, "pi-hermes-memory");
	const seen = new Set<string>();
	if (!existsSync(hermesDir)) {
		report.notes.push(`no hermes data at ${hermesDir}`);
		return report;
	}

	let collisions = 0;
	const count = (outcome: string, layer: "user" | "project"): void => {
		if (outcome === "copied") {
			report.copied++;
			report.routed[layer]++;
		} else if (outcome === "collision") {
			collisions++;
			report.skipped++;
		} else if (outcome === "skipped") report.skipped++;
	};

	// route a tagged/untagged section from a global store
	// RV-15 (spec 2026-10-02-memory-recall-v2): sections tagged with ANOTHER
	// project go to THAT project's layer under ~/.pi/agent/projects/*-<name>/
	// memory — never the user layer (the old [name]-prefix routing was the
	// measured cross-project leakage source, RC-4). No matching project dir →
	// skipped and noted (re-run import after opening that project once).
	const foreignProjectDir = (name: string): string | null => {
		const projectsRoot = join(args.agentDir, "projects");
		if (!existsSync(projectsRoot)) return null;
		const sanitized = name.replace(/[\\/]/g, "-");
		const dirs = readdirSync(projectsRoot).filter((d) => d === sanitized || d.endsWith(`-${sanitized}`)).sort((a, b) => b.length - a.length);
		return dirs.length > 0 ? join(projectsRoot, dirs[0]!, "memory") : null;
	};
	const foreignDirs = new Set<string>();
	const routeGlobal = (section: HermesSection, type: string, categoryPrefix: string): void => {
		if (section.project64) {
			const name = decodeProject64(section.project64);
			if (name && projectMatchesCurrent(name, args.projectMemoryDir)) {
				count(importSection(section, args.projectMemoryDir, type, categoryPrefix, seen), "project");
			} else if (name) {
				const foreign = foreignProjectDir(name);
				if (foreign) {
					count(importSection(section, foreign, type === "user" ? "user" : type === "project" ? "reference" : type, "", seen), "project");
					foreignDirs.add(foreign);
				} else {
					report.skipped++;
					report.notes.push(`[${name}] section skipped — no project layer under ~/.pi/agent/projects matches (open that project once, then re-run; idempotent)`);
				}
			} else {
				count(importSection(section, args.userMemoryDir, type, categoryPrefix, seen), "user");
			}
		} else {
			count(importSection(section, args.userMemoryDir, type, categoryPrefix, seen), "user");
		}
	};

	for (const [file, type, prefix] of [
		["USER.md", "user", ""],
		["MEMORY.md", "reference", ""],
		["failures.md", "feedback", ""],
	] as const) {
		const path = join(hermesDir, file);
		if (!existsSync(path)) continue;
		const source = readSourceStable(path);
		if (source.torn) report.notes.push(`${file} changed during migration (hermes still writing?) — re-run /memory-import-hermes to be safe (idempotent)`);
		for (const raw of splitHermesSections(source.raw)) {
			const section = parseHermesSection(raw);
			if (!section.body) {
				report.skipped++;
				continue;
			}
			const category = /^\[(failure|correction|insight|convention|tool-quirk|preference)\]/i.exec(section.firstLine)?.[1]?.toLowerCase();
			routeGlobal(section, file === "USER.md" ? "user" : file === "failures.md" ? "feedback" : typeHeuristic(section.body), category ? `[${category}] ` : prefix);
		}
	}

	// per-project stores: only the current project's; others are listed
	const projectsMemoryDir = join(args.agentDir, "projects-memory");
	if (existsSync(projectsMemoryDir)) {
		for (const name of readdirSync(projectsMemoryDir).sort()) {
			const storeFile = join(projectsMemoryDir, name, "MEMORY.md");
			if (!existsSync(storeFile)) continue;
			if (!projectMatchesCurrent(name, args.projectMemoryDir)) {
				report.otherProjects.push(name);
				continue;
			}
			const source = readSourceStable(storeFile);
			if (source.torn) report.notes.push(`projects-memory/${name}/MEMORY.md changed during migration — re-run /memory-import-hermes to be safe (idempotent)`);
			for (const raw of splitHermesSections(source.raw)) {
				const section = parseHermesSection(raw);
				if (!section.body) {
					report.skipped++;
					continue;
				}
				count(importSection(section, args.projectMemoryDir, typeHeuristic(section.body), "", seen), "project");
			}
		}
	}

	reconcileMemoryIndex(args.projectMemoryDir);
	reconcileMemoryIndex(args.userMemoryDir);
	if (collisions > 0) {
		report.notes.push(`${collisions} slug collision(s): distinct facts sharing a title were disambiguated with a fingerprint suffix or skipped; review the hermes-* files`);
	}
	if (report.otherProjects.length > 0) {
		report.notes.push(`other hermes projects not migrated (run the command inside them): ${report.otherProjects.join(", ")}`);
	}
	for (const d of foreignDirs) {
		try {
			reconcileMemoryIndex(d);
		} catch {
			/* foreign index converges when that project next opens */
		}
	}
	return report;
}
