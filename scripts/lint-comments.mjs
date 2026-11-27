#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCANDIRS = ["extensions", "lib", "types", "scripts"];
const SKIP_PATH = [/\.test\.ts$/, /\/tests?\//, /\/test\//, /\/node_modules\//, /\/archive\//];

const ALLOW = [
{ file: "extensions/action-fusion/then-run.ts", includes: "2026-11-14" },
	{ file: "extensions/bg-shell/index.ts", includes: "2026-11-14" },
	{ file: "extensions/bus.ts", includes: "2026-10-07" },
	{ file: "extensions/bus.ts", includes: "2026-11-14" },
	{ file: "extensions/compaction/policy.ts", includes: "2026-11-10" },
	{ file: "extensions/compaction/state.ts", includes: "2026-11-10" },
	{ file: "extensions/effort/index.ts", includes: "2026-10-13" },
	{ file: "extensions/goal/goal-auditor.ts", includes: "2026-10-04" },
	{ file: "extensions/goal/goal-auditor.ts", includes: "2026-10-05" },
	{ file: "extensions/goal/goal-auditor.ts", includes: "2026-11-14" },
	{ file: "extensions/goal/goal-lifecycle.ts", includes: "2026-10-07" },
	{ file: "extensions/goal/goal-lifecycle.ts", includes: "2026-10-09" },
	{ file: "extensions/goal/prompts/goal-prompts.ts", includes: "2026-10-03" },
	{ file: "extensions/memory/automation.ts", includes: "2026-10-03" },
	{ file: "extensions/memory/consolidate.ts", includes: "2026-10-18" },
	{ file: "extensions/memory/guard.ts", includes: "2026-11-14" },
	{ file: "extensions/memory/llm.ts", includes: "2026-10-03" },
	{ file: "extensions/memory/llm.ts", includes: "2026-11-15" },
	{ file: "extensions/memory/paths.ts", includes: "2026-10-03" },
	{ file: "extensions/memory/queue-drain.ts", includes: "2026-10-07" },
	{ file: "extensions/memory/queue-drain.ts", includes: "2026-11-14" },
	{ file: "extensions/memory/queue.ts", includes: "2026-10-03" },
	{ file: "extensions/memory/queue.ts", includes: "2026-10-07" },
	{ file: "extensions/memory/writer.ts", includes: "2026-10-07" },
	{ file: "extensions/modes/auto-engine.ts", includes: "2026-10-18" },
	{ file: "extensions/modes/auto-engine.ts", includes: "2026-11-15" },
	{ file: "extensions/modes/bash-path-check.ts", includes: "2026-11-07" },
	{ file: "extensions/modes/bash-path-check.ts", includes: "2026-11-08" },
	{ file: "extensions/modes/bash-path-check.ts", includes: "2026-11-14" },
	{ file: "extensions/modes/bash-path-check.ts", includes: "2026-11-15" },
	{ file: "extensions/modes/bash-permission-match.ts", includes: "2026-11-08" },
	{ file: "extensions/modes/cc-import.ts", includes: "2026-11-02" },
	{ file: "extensions/modes/config.ts", includes: "2026-11-14" },
	{ file: "extensions/modes/fusion-tools.ts", includes: "2026-10-07" },
	{ file: "extensions/modes/interpret.ts", includes: "2026-10-07" },
	{ file: "extensions/modes/loop-guard.ts", includes: "2026-10-20" },
	{ file: "extensions/modes/loop-guard.ts", includes: "2026-11-02" },
	{ file: "extensions/modes/plan-gate.ts", includes: "2026-10-07" },
	{ file: "extensions/modes/profile-apply.ts", includes: "2026-10-03" },
	{ file: "extensions/modes/working-stats.ts", includes: "2026-10-05" },
	{ file: "extensions/observation-pack/index.ts", includes: "2026-11-14" },
	{ file: "extensions/observation-pack/projection.ts", includes: "2026-10-03" },
	{ file: "extensions/observation-pack/projection.ts", includes: "2026-11-14" },
	{ file: "extensions/observation-pack/renderers.ts", includes: "2026-10-02" },
	{ file: "extensions/review/index.ts", includes: "2026-11-15" },
	{ file: "extensions/review/src/directive.ts", includes: "2026-08-26" },
	{ file: "extensions/review/src/directive.ts", includes: "2026-08-27" },
	{ file: "extensions/review/src/directive.ts", includes: "2026-11-15" },
	{ file: "extensions/review/src/report-tool.ts", includes: "2026-09-03" },
	{ file: "extensions/rules/activation.ts", includes: "2026-10-05" },
	{ file: "extensions/ui/cc-panels.ts", includes: "2026-10-20" },
	{ file: "extensions/ui/cc-rows.ts", includes: "2026-10-20" },
	{ file: "extensions/ui/footer-lines.ts", includes: "2026-10-07" },
	{ file: "extensions/web-gov/index.ts", includes: "2026-11-14" },
	{ file: "lib/json-lift.ts", includes: "2026-10-03" },
	{ file: "lib/json-lift.ts", includes: "2026-10-05" },
	{ file: "lib/pi-compat.ts", includes: "2026-10-07" },
	{ file: "lib/rule-text.ts", includes: "2026-09-22" },
	{ file: "lib/settings.ts", includes: "2026-11-15" },
	{ file: "lib/tool-render.ts", includes: "2026-10-02" },
];

const RULES = [
	{ name: "suppression", re: /@ts-ignore|@ts-expect-error|eslint-disable|biome-ignore/ },
	{ name: "banner", re: /^[─\s-]*\/\/\s*[─-]+\s*$|^\/\/\s*[─-]{3,}.*[─-]{3,}\s*$/ },
	{ name: "date-archaeology", re: /\b(19|20)\d{2}-\d{2}-\d{2}\b/ },
	{ name: "sermon-marker", re: /\b(IMPORTANT|do not remove|do NOT remove|DO NOT REMOVE)\b/ },
	{ name: "commented-out-code", re: /^\s*(const |let |var |return |import |export |function |class |await |console\.)/ },
];

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
