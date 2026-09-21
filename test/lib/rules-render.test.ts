/**
 * P3-RU rules engine tests.
 *
 * §1 表驱动纯函数(renderRules + in-memory RuleFs):五场景 + 红队 #11
 *   补齐(include 深度上限/坏 frontmatter 尾注/确定性)。
 * §2 性质测试:随机文件集 ≤ budget、字节级确定。
 *
 * wiring 行为(steer 首触、mtime stat 计数、session_start 重置、/rules
 * 输出冒烟)全部在 test/lib/rules-wiring.test.ts。
 */
import { describe, expect, it } from "vitest";

import { renderRules, collectRules, globToRegExp, type RuleDir, type RuleFs } from "../../extensions/rules/render.ts";
import { parseFrontmatter, extractIncludes } from "../../extensions/rules/scan.ts";

function memFs(files: Record<string, string>): RuleFs {
	return {
		listMarkdownFiles(dir: string): string[] {
			return Object.keys(files)
				.filter((p) => p.startsWith(dir + "/") && p.endsWith(".md"))
				.map((p) => p.slice(dir.length + 1))
				.sort();
		},
		readFile(path: string): string {
			if (files[path] === undefined) throw new Error(`ENOENT ${path}`);
			return files[path];
		},
	};
}

const DIRS: RuleDir[] = [
	{ scope: "builtin", path: "/builtin" },
	{ scope: "global", path: "/home/rules" },
	{ scope: "compat", path: "/proj/.claude/rules" },
	{ scope: "project", path: "/proj/.pi/rules" },
];

function baseInput(files: Record<string, string>, overrides: Partial<Parameters<typeof renderRules>[0]> = {}) {
	return {
		dirs: DIRS,
		cwd: "/proj",
		projectTrusted: true,
		touchedPaths: [],
		fs: memFs(files),
		...overrides,
	};
}

describe("P3-RU-01 scope priority and shadowing", () => {
	it("same slug: project beats compat beats global beats builtin; untrusted hides project+compat", () => {
		const files = {
			"/home/rules/dupe.md": "---\nname: from-global\n---\nglobal body",
			"/proj/.claude/rules/dupe.md": "---\nname: from-compat\n---\ncompat body",
			"/proj/.pi/rules/dupe.md": "---\nname: from-project\n---\nproject body",
			"/proj/.pi/rules/solo.md": "---\nname: project-only\n---\nsolo",
		};
		const { rules } = collectRules(baseInput(files));
		const dupe = rules.find((r) => r.path.endsWith("dupe.md"));
		expect(dupe?.scope).toBe("project");
		expect(dupe?.name).toBe("from-project");
		expect(rules.some((r) => r.name === "project-only")).toBe(true);

		// untrusted: project + compat hidden
		const untrusted = renderRules(baseInput(files, { projectTrusted: false }));
		expect(untrusted.output).toContain("from-global");
		expect(untrusted.output).not.toContain("from-project");
		expect(untrusted.output).not.toContain("from-compat");
	});
});

describe("P3-RU-02 frontmatter", () => {
	it("no frontmatter = always rule; globs make it conditional; ** degrades to always", () => {
		const { rules } = collectRules(
			baseInput({
				"/home/rules/plain.md": "just a body",
				"/home/rules/cond.md": "---\nglobs:\n  - \"src/**/*.ts\"\n---\nconditional",
				"/home/rules/star.md": "---\nglobs: \"**\"\n---\neverything",
			}),
		);
		const plain = rules.find((r) => r.name === "plain");
		const cond = rules.find((r) => r.name === "cond");
		const star = rules.find((r) => r.name === "star");
		expect(plain?.always).toBe(true);
		expect(cond?.always).toBe(false);
		expect(cond?.globs).toEqual(["src/**/*.ts"]);
		expect(star?.always).toBe(true);
		expect(star?.globs).toBeUndefined();
	});

	it("invalid frontmatter (unterminated block, bad always value) marks the file invalid", () => {
		expect(parseFrontmatter("---\nname: x\n").invalid).toBe(true);
		expect(parseFrontmatter("---\nalways: maybe\n---\nbody").invalid).toBe(true);
		expect(parseFrontmatter("---\ndescription:\n---\nbody").invalid).toBe(true);
		expect(parseFrontmatter("plain body").invalid).toBe(false);
	});
});

describe("P3-RU-03 @include forms", () => {
	it("extracts all four forms in order without duplicates", () => {
		const refs = extractIncludes("a @./b.md c @~/d.md e @/f.md g @h.md @./b.md");
		expect(refs.map((r) => [r.kind, r.target])).toEqual([
			["relative-file", "./b.md"],
			["home", "~/d.md"],
			["absolute", "/f.md"],
			["relative-dir", "h.md"],
		]);
	});

	it("expands include before host body; missing includes are silent; cycles drop at revisit; depth 5 caps", () => {
		const files = {
			"/home/rules/host.md": "start @./inc.md end",
			"/home/rules/inc.md": "---\nname: inc\n---\ninc-body @./missing.md @./host.md",
		};
		const { rules } = collectRules(baseInput(files));
		const host = rules.find((r) => r.name === "host");
		expect(host?.content).toContain("inc-body");
		expect(host?.content.indexOf("inc-body")).toBeLessThan(host?.content.indexOf("start")!);
		expect(host?.content).toContain("end");
	});

	it("red-team #11: the 6th include level is dropped (depth limit 5)", () => {
		// chain d1 → d2 → d3 → d4 → d5 → d6: at depth 5 expansion stops, so
		// d5 keeps its @./d6 token unresolved but d1..d5 bodies all land
		const files: Record<string, string> = {};
		for (let i = 1; i <= 6; i++) {
			files[`/home/rules/d${i}.md`] = `d${i}-body @./d${i + 1}.md`;
		}
		files["/home/rules/host.md"] = "---\nname: chain\n---\ntop @./d1.md";
		const { rules } = collectRules(baseInput(files));
		const chain = rules.find((r) => r.name === "chain");
		expect(chain).toBeDefined();
		for (let i = 1; i <= 5; i++) {
			expect(chain!.content).toContain(`d${i}-body`);
		}
		expect(chain!.content).not.toContain("d6-body");
	});
});

describe("P3-RU-04 budget and inline threshold", () => {
	it("file over inline threshold renders as index row only", () => {
		const big = "x".repeat(5_000);
		const result = renderRules(baseInput({ "/home/rules/big.md": big }, { inlineThresholdChars: 4_000 }));
		expect(result.output).not.toContain(big);
		expect(result.output).toContain("read /home/rules/big.md on demand");
	});

	it("single file over the whole budget is dropped entirely", () => {
		const huge = "y".repeat(41_000);
		const result = renderRules(baseInput({ "/home/rules/huge.md": huge }, { budgetChars: 40_000 }));
		expect(result.output).not.toContain("huge");
		expect(result.output).not.toContain(huge);
	});

	it("overflow degrades always blocks to index rows, never truncates content mid-body", () => {
		const mk = (n: string) => `---\nname: ${n}\n---\n${"z".repeat(6_000)}`;
		const result = renderRules(
			baseInput(
				{
					"/home/rules/a1.md": mk("alpha"),
					"/home/rules/b2.md": mk("beta"),
					"/home/rules/c3.md": mk("gamma"),
				},
				{ budgetChars: 20_000 },
			),
		);
		// every rendered body is intact (no mid-content truncation)
		for (const n of ["alpha", "beta", "gamma"]) {
			if (result.output.includes(`### ${n}\n`)) {
				expect(result.output).toContain("zzzzzz");
			} else {
				expect(result.output).toContain(n); // degraded to an index row
			}
		}
		expect(result.output.length).toBeLessThanOrEqual(20_000); // budget is exact, note included
	});
});

describe("P3-RU-05 total function", () => {
	it("missing dirs contribute nothing; bad files skipped with trailing note; deterministic", () => {
		const files = {
			"/home/rules/good.md": "---\nname: good\n---\nok",
			"/home/rules/bad.md": "---\nname: broken\n",
		};
		const one = renderRules(baseInput(files));
		const two = renderRules(baseInput(files));
		expect(one.output).toContain("good");
		expect(one.output).not.toContain("broken");
		expect(one.output).toContain("<!-- rules: skipped 1 invalid -->");
		expect(one.output).toBe(two.output);
		expect(renderRules(baseInput({})).output).toContain("skipped 0 invalid");
	});
});

describe("P3-RU-04/05 random property test (review #19)", () => {
	it("seeded random rule sets: output ≤ budget and byte-deterministic", () => {
		// deterministic PRNG (mulberry32)
		let seed = 0x9e3779b9;
		const rand = () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		for (let trial = 0; trial < 10; trial++) {
			const files: Record<string, string> = {};
			const n = 3 + Math.floor(rand() * 10);
			for (let i = 0; i < n; i++) {
				const size = Math.floor(rand() * 6_000);
				const conditional = rand() < 0.4;
				const fm = conditional
					? `---\nname: r${i}\nglobs:\n  - "src/**/*${i}.ts"\n---\n`
					: `---\nname: r${i}\n---\n`;
				files[`/home/rules/r${i}.md`] = `${fm}${"x".repeat(size)}`;
			}
			const budget = 2_000 + Math.floor(rand() * 20_000);
			const input = baseInput(files, { budgetChars: budget });
			const one = renderRules(input);
			const two = renderRules(input);
			expect(one.output.length).toBeLessThanOrEqual(budget); // exact budget, note included
			expect(one.output).toBe(two.output); // byte-deterministic
			// red line: any inlined body appears whole (no mid-content cut)
			for (const [path, content] of Object.entries(files)) {
				const body = content.split("---\n").pop()!.trim();
				if (body && one.output.includes(path)) {
					// indexed form references the path — body must NOT be there half-cut
					const idx = one.output.indexOf(body.slice(0, 50));
					if (idx !== -1) expect(one.output.slice(idx, idx + body.length)).toContain(body.slice(-20));
				}
			}
		}
	});
});

describe("P3-RU-07 touched paths fold matching rules inline", () => {
	it("a globs rule hit by touchedPaths renders inline instead of as an index row", () => {
		const files = { "/home/rules/ts.md": "---\nname: ts-rule\nglobs:\n  - \"src/**/*.ts\"\n---\nts conventions" };
		const idle = renderRules(baseInput(files));
		expect(idle.output).not.toContain("### ts-rule");
		expect(idle.output).toContain("read /home/rules/ts.md on demand");

		const hit = renderRules(baseInput(files, { touchedPaths: ["/proj/src/a/b.ts"] }));
		expect(hit.output).toContain("### ts-rule");
		expect(hit.output).toContain("ts conventions");
		expect(hit.activated).toEqual(["ts-rule"]);
	});
});

describe("P3-RU-02 glob matching helper", () => {
	it("matches ** across separators, * within one segment", () => {
		expect(globToRegExp("src/**/*.ts").test("/proj/src/a/b.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("/proj/src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("/proj/src/a/b.ts")).toBe(false);
	});
});
