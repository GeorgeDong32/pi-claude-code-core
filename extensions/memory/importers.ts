
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { slugify } from "./memdir.ts";
import { reindex, writeDocument } from "./writer.ts";
import { fullProjectKey } from "./paths.ts";

export interface ImportReport {
	copied: number;
	skipped: number;
	notes: string[];
}

export function importFromClaude(projectMemoryDir: string, targetDir: string): ImportReport {
	const report: ImportReport = { copied: 0, skipped: 0, notes: [] };
	if (!existsSync(projectMemoryDir)) {
		report.notes.push(`no Claude memory dir at ${projectMemoryDir}`);
		return report;
	}
	const files = readdirSync(projectMemoryDir).filter((f) => f.endsWith(".md"));
	mkdirSync(targetDir, { recursive: true });
	for (const file of files) {
		if (file === "MEMORY.md") continue;
		let content: string;
		try {
			content = readFileSync(join(projectMemoryDir, file), "utf-8");
		} catch {
			report.skipped++;
			continue;
		}
		const target = join(targetDir, file);
		if (existsSync(target)) {
			if (readFileSync(target, "utf-8") !== content) {
				report.notes.push(`${file}: kept local (differs from source; delete to re-import)`);
			}
			report.skipped++;
			continue;
		}
		writeDocument(targetDir, file, { kind: "raw", text: content });
		report.copied++;
	}
	reindex(targetDir);
	return report;
}

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
	reindex(targetDir);
	return report;
}


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


export interface HermesMigrationReport extends ImportReport {
	routed: { user: number; project: number };
	otherProjects: string[];
}

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

function importSection(
	section: HermesSection,
	targetDir: string,
	type: string,
	descriptionPrefix = "",
	seen?: Set<string>,
	fileNamePrefix = "hermes-",
): "copied" | "skipped" | "dup" | "collision" {
	const fp = section.body.replace(/\s+/g, " ").slice(0, 120).toLowerCase();
	if (seen) {
		if (seen.has(fp)) return "dup";
		seen.add(fp);
	}
	const title = section.firstLine.replace(/^#+\s*/, "").trim().slice(0, 60) || "fact";
	const base = slugify(`${descriptionPrefix}${title}`) || "memory";
	const description = `${descriptionPrefix}${section.firstLine.replace(/^#+\s*/, "").trim().slice(0, 90)}`;
	const created = section.created ? `\n\n<!-- hermes: ${section.created} -->` : "";
	for (const candidate of [base, `${base}-${Buffer.from(fp).toString("hex").slice(0, 6)}`]) {
		const fileName = `${fileNamePrefix}${candidate}.md`;
		const target = join(targetDir, fileName);
		if (!existsSync(target)) {
			writeDocument(targetDir, fileName, {
				kind: "memory",
				body: `${section.body}${created ?? ""}`,
				meta: { name: candidate, description, type },
			});
			return "copied";
		}
		if (readFileSync(target, "utf-8").includes(section.body)) return "skipped";
	}
	return "collision";
}

export function decodeProject64(b64: string): string | null {
	try {
		const decoded = Buffer.from(b64, "base64").toString("utf-8");
		return decoded.trim() || null;
	} catch {
		return null;
	}
}

export function projectKeyOf(memoryDir: string): string {
	return fullProjectKey(memoryDir);
}

export function projectMatchesCurrent(hermesName: string, memoryDir: string): boolean {
	const key = projectKeyOf(memoryDir);
	return key === hermesName || key.endsWith(`-${hermesName}`);
}

export function importHermesFull(args: {
	agentDir: string;
	projectMemoryDir: string;
	userMemoryDir?: string;
}): HermesMigrationReport {
	const report: HermesMigrationReport = { copied: 0, skipped: 0, notes: [], routed: { user: 0, project: 0 }, otherProjects: [] };
	const hermesDir = join(args.agentDir, "pi-hermes-memory");
	const seen = new Set<string>();
	if (!existsSync(hermesDir)) {
		report.notes.push(`no hermes data at ${hermesDir}`);
		return report;
	}

	let collisions = 0;
	const count = (outcome: string): void => {
		if (outcome === "copied") {
			report.copied++;
			report.routed.project++;
		} else if (outcome === "collision") {
			collisions++;
			report.skipped++;
		} else if (outcome === "skipped") report.skipped++;
	};

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
				count(importSection(section, args.projectMemoryDir, type, categoryPrefix, seen));
			} else if (name) {
				const foreign = foreignProjectDir(name);
				if (foreign) {
					count(importSection(section, foreign, type === "user" ? "reference" : type, categoryPrefix, seen));
					foreignDirs.add(foreign);
				} else {
					report.skipped++;
					report.notes.push(`[${name}] section skipped — no project layer under ~/.pi/agent/projects matches (open that project once, then re-run; idempotent)`);
				}
			} else {
				count(importSection(section, args.projectMemoryDir, type === "user" ? "reference" : type, categoryPrefix, seen));
			}
		} else {
			count(importSection(section, args.projectMemoryDir, type === "user" ? "reference" : type, categoryPrefix, seen));
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
				count(importSection(section, args.projectMemoryDir, typeHeuristic(section.body), "", seen));
			}
		}
	}

	reindex(args.projectMemoryDir);
	if (collisions > 0) {
		report.notes.push(`${collisions} slug collision(s): distinct facts sharing a title were disambiguated with a fingerprint suffix or skipped; review the hermes-* files`);
	}
	if (report.otherProjects.length > 0) {
		report.notes.push(`other hermes projects not migrated (run the command inside them): ${report.otherProjects.join(", ")}`);
	}
	for (const d of foreignDirs) {
		try {
			reindex(d);
		} catch {
		}
	}
	return report;
}
