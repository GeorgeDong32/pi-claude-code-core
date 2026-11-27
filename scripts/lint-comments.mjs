#!/usr/bin/env node
// Comment-hygiene lint (no-comments policy): banners, dates, sermon markers,
// suppressions, commented-out code and long file headers. Zero dependencies;
// part of `pnpm run check`. ALLOW entries exempt REVIEW-kept comments only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCANDIRS = ["extensions", "lib", "types", "scripts", "test"];
const SKIP_PATH = [/\/node_modules\//, /\/archive\//, /test\/spikes\//];

const ALLOW = [
{ file: "extensions/action-fusion/then-run.ts", includes: "2026-11-14" },
	{ file: "test/contracts/pi-host-semantics.test.ts", includes: "@ts-expect-error" },
];

const RULES = [
	{ name: "suppression", re: /@ts-ignore|@ts-expect-error|eslint-disable|biome-ignore/ },
	{ name: "banner", re: /^[─\s-]*\/\/\s*[─-]+\s*$|^\/\/\s*[─-]{3,}.*[─-]{3,}\s*$/ },
	{ name: "date-archaeology", re: /\b(19|20)\d{2}-\d{2}-\d{2}\b/ },
	{ name: "sermon-marker", re: /\b(IMPORTANT|do not remove|do NOT remove|DO NOT REMOVE)\b/ },
	{ name: "commented-out-code", re: /^\s*(const |let |var |return |import |export |function |class |await |console\.)/ },
];

// A file header is the first comment block, before any code line. Short ones
// survive (a license or provenance line, a single external gotcha); long ones
// are the narration headers the no-comments sweep removed.
const HEADER_MAX_LINES = 8;
function headerLineCount(src) {
	let count = 0;
	for (const line of src.split("\n")) {
		if (line.trim() === "") { if (count > 0) break; continue; }
		if (/^\s*(\/\/|\/\*|\*)/.test(line)) { count++; continue; }
		break;
	}
	return count;
}

function* commentLines(src) {
	let i = 0;
	let line = 1;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		if (c === "\n") { line++; i++; continue; }
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			i++;
			while (i < n) {
				if (src[i] === "\\") { i += 2; continue; }
				if (src[i] === "\n") { line++; if (quote !== "`") { i++; break; } }
				if (src[i] === quote) { i++; break; }
				i++;
			}
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			let text = "";
			while (i < n && src[i] !== "\n") { text += src[i]; i++; }
			yield { line, text: text.trim() };
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			i += 2;
			let text = "";
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
				if (src[i] === "\n") { line++; text += " "; } else text += src[i];
				i++;
			}
			i += 2;
			yield { line, text: `/*${text.trim()}`.trim() };
			continue;
		}
		i++;
	}
}

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		const st = statSync(abs);
		if (st.isDirectory()) yield* walk(abs);
		else if (/\.(ts|mjs)$/.test(entry)) yield abs;
	}
}

const violations = [];
const files = [];
for (const dir of SCANDIRS) {
	const abs = join(ROOT, dir);
	if (!statSync(abs, { throwIfNoEntry: false })) continue;
	files.push(...walk(abs));
}
if (statSync(join(ROOT, "vitest.config.ts"), { throwIfNoEntry: false })) files.push(join(ROOT, "vitest.config.ts"));

for (const abs of files) {
	const rel = relative(ROOT, abs);
	if (SKIP_PATH.some((re) => re.test(rel))) continue;
	const src = readFileSync(abs, "utf8");
	const headerLen = headerLineCount(src);
	if (headerLen > HEADER_MAX_LINES) {
		violations.push(`${rel}:1 [file-header] ${headerLen} comment lines before the first code line`);
	}
	for (const c of commentLines(src)) {
		const norm = c.text.replace(/\s+/g, " ");
		const exempted = ALLOW.some((a) => a.file === rel && norm.includes(a.includes));
		if (exempted) continue;
		for (const rule of RULES) {
			if (rule.re.test(c.text) || rule.re.test(norm)) {
				violations.push(`${rel}:${c.line} [${rule.name}] ${norm.slice(0, 100)}`);
				break;
			}
		}
	}
}

if (violations.length > 0) {
	console.error(`lint-comments: ${violations.length} violation(s)`);
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}
console.log(`lint-comments: OK (${files.length} files scanned)`);
