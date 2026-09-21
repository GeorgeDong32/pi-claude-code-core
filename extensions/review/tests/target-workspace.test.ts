/**
 * Tests for src/target-workspace.ts — PR clone + FETCH_HEAD checkout +
 * expectedHeadSha reconciliation. These branches were previously only
 * exercised through fully-stubbed review-run tests whose mocks returned
 * empty rev-parse output, short-circuiting every verification.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
	prepareWorkspace,
	resetTargetWorkspaceCmd,
	setTargetWorkspaceCmd,
} from "../src/target-workspace.js";

type CmdResult = { stdout: string; stderr: string; exitCode: number };
type Cmd = (cmd: string, args: string[], opts: { cwd: string }) => Promise<CmdResult>;

let sandbox: string;

afterEach(() => {
	resetTargetWorkspaceCmd();
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
	sandbox = "";
});

function setup(): string {
	sandbox = mkdtempSync(join(tmpdir(), "pi-review-ws-test-"));
	return sandbox;
}

interface Script {
	/** Sequential responses for "gh repo clone". */
	ghClone?: CmdResult[];
	/** Sequential responses for "git clone". */
	gitClone?: CmdResult[];
	/** Sequential responses for git fetch (pull/... or base). */
	fetch?: CmdResult[];
	/** Sequential rev-parse FETCH_HEAD values (consumed in order). */
	fetchHeads?: string[];
	/** HEAD sha returned by rev-parse HEAD. */
	head?: string;
	checkout?: CmdResult;
}

/**
 * Scripted workspace cmd runner. Tracks which scratch roots were handed out
 * so tests can verify retry-cleanup behavior.
 */
function scripted(s: Script): { cmd: Cmd; roots: string[] } {
	const roots: string[] = [];
	const ghClone = [...(s.ghClone ?? [])];
	const gitClone = [...(s.gitClone ?? [])];
	const fetches = [...(s.fetch ?? [])];
	const fetchHeads = [...(s.fetchHeads ?? [])];
	return {
		roots,
		cmd: async (cmd, args, opts) => {
			if (cmd === "gh" && args[0] === "repo") {
				roots.push(opts.cwd);
				return ghClone.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args[0] === "clone") {
				roots.push(opts.cwd);
				return gitClone.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args[0] === "fetch") {
				return fetches.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args[0] === "rev-parse") {
				if (args.includes("FETCH_HEAD")) {
					const v = fetchHeads.shift() ?? "";
					return { stdout: `${v}\n`, stderr: "", exitCode: v ? 0 : 1 };
				}
				if (args.includes("HEAD")) {
					const v = s.head ?? "";
					return { stdout: `${v}\n`, stderr: "", exitCode: v ? 0 : 1 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args[0] === "checkout") {
				return s.checkout ?? { stdout: "", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "unexpected", exitCode: 1 };
		},
	};
}

const PR = "https://github.com/some-owner/some-repo/pull/9";

describe("prepareWorkspace — PR path", () => {
	test("happy path: gh clone + FETCH_HEAD verified + detached checkout", async () => {
		const cwd = setup();
		const { cmd } = scripted({ fetchHeads: ["H1"], head: "H1" });
		setTargetWorkspaceCmd(cmd);
		const r = await prepareWorkspace({ cwd, target: { kind: "pr", prRef: PR, expectedHeadSha: "H1" } });
		assert.equal(r.cloned, true);
		assert.equal(r.historyAvailable, true);
		assert.equal(r.workspaceHeadSha, "H1");
		assert.match(r.workspacePath, /some-repo-9$/);
	});

	test("falls back to git clone when gh fails (public repos)", async () => {
		const cwd = setup();
		const { cmd } = scripted({
			ghClone: [{ stdout: "", stderr: "gh missing", exitCode: 1 }],
			gitClone: [{ stdout: "", stderr: "", exitCode: 0 }],
			fetchHeads: ["H2"],
			head: "H2",
		});
		setTargetWorkspaceCmd(cmd);
		const r = await prepareWorkspace({ cwd, target: { kind: "pr", prRef: PR, expectedHeadSha: "H2" } });
		assert.equal(r.cloned, true);
		assert.equal(r.workspaceHeadSha, "H2");
	});

	test("both clone paths fail → hard error, no silent cwd fallback", async () => {
		const cwd = setup();
		const { cmd } = scripted({
			ghClone: [{ stdout: "", stderr: "no gh", exitCode: 1 }],
			gitClone: [{ stdout: "", stderr: "no network", exitCode: 128 }],
		});
		setTargetWorkspaceCmd(cmd);
		await assert.rejects(
			() => prepareWorkspace({ cwd, target: { kind: "pr", prRef: PR } }),
			/could not clone some-owner\/some-repo/,
		);
	});

	test("head fetch fails → hard error", async () => {
		const cwd = setup();
		const { cmd } = scripted({
			fetch: [{ stdout: "", stderr: "fetch denied", exitCode: 1 }],
		});
		setTargetWorkspaceCmd(cmd);
		await assert.rejects(
			() => prepareWorkspace({ cwd, target: { kind: "pr", prRef: PR } }),
			/git fetch pull\/9\/head failed/,
		);
	});

	test("FETCH_HEAD mismatch + refetch still wrong → throws (PR moving)", async () => {
		const cwd = setup();
		const { cmd } = scripted({ fetchHeads: ["AAA", "BBB"] });
		setTargetWorkspaceCmd(cmd);
		await assert.rejects(
			() => prepareWorkspace({ cwd, target: { kind: "pr", prRef: PR, expectedHeadSha: "H1" } }),
			/head moved to BBB .* diff was captured at H1/,
		);
	});

	test("FETCH_HEAD mismatch + refetch converges → proceeds", async () => {
		const cwd = setup();
		const { cmd } = scripted({ fetchHeads: ["AAA", "H1"], head: "H1" });
		setTargetWorkspaceCmd(cmd);
		const r = await prepareWorkspace({ cwd, target: { kind: "pr", prRef: PR, expectedHeadSha: "H1" } });
		assert.equal(r.workspaceHeadSha, "H1");
	});

	test("empty FETCH_HEAD (undeterminable) → skips verification, no throw", async () => {
		const cwd = setup();
		const { cmd } = scripted({ fetchHeads: [""], head: "" });
		setTargetWorkspaceCmd(cmd);
		const r = await prepareWorkspace({ cwd, target: { kind: "pr", prRef: PR, expectedHeadSha: "H1" } });
		assert.equal(r.workspaceHeadSha, undefined);
	});

	test("checkout failure → hard error", async () => {
		const cwd = setup();
		const { cmd } = scripted({
			checkout: { stdout: "", stderr: "dirty", exitCode: 1 },
			fetchHeads: ["H1"],
		});
		setTargetWorkspaceCmd(cmd);
		await assert.rejects(
			() => prepareWorkspace({ cwd, target: { kind: "pr", prRef: PR } }),
			/checkout of PR 9 head failed/,
		);
	});

	test("no expectedHeadSha → no verification performed", async () => {
		const cwd = setup();
		const { cmd } = scripted({ fetchHeads: ["ZZZ"], head: "ZZZ" });
		setTargetWorkspaceCmd(cmd);
		const r = await prepareWorkspace({ cwd, target: { kind: "pr", prRef: PR } });
		assert.equal(r.workspaceHeadSha, "ZZZ");
	});
});

describe("prepareWorkspace — local paths", () => {
	test("local-git reuses cwd", async () => {
		const cwd = setup();
		const { cmd } = scripted({});
		setTargetWorkspaceCmd(cmd);
		const r = await prepareWorkspace({ cwd, target: { kind: "local-git" } });
		assert.equal(r.workspacePath, cwd);
		assert.equal(r.cloned, false);
	});

	test("diff-file reuses cwd with warning", async () => {
		const cwd = setup();
		const { cmd } = scripted({});
		setTargetWorkspaceCmd(cmd);
		const r = await prepareWorkspace({ cwd, target: { kind: "diff-file" } });
		assert.equal(r.workspacePath, cwd);
		assert.match(r.warning ?? "", /only the diff/);
	});
});
