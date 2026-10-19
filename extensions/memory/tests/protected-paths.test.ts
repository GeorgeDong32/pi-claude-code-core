/**
 * [C4] self-modification protection — pure matcher pin
 * (docs/zh/entropy-control-spec.md, Goal 1 [C4]). Covers: each of the five
 * protected boundaries blocks; dir entries catch nested files but not
 * sibling prefixes; the plugin source repo and ordinary project files pass;
 * relative inputs return null (absPath assumption, see protected-paths.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { matchProtectedPath, protectedPathBlockReason, type ProtectedPathsInput } from "../protected-paths.ts";

const home = "/home/tester";
const cwd = "/Users/gd32/Coding/Pi-Extension/pi-claude-code-core";
const opts: ProtectedPathsInput = { home, cwd };

test("[C4] permission-modes.json (home) is blocked with kind modes-permissions-file", () => {
	const match = matchProtectedPath(join(home, ".pi", "agent", "permission-modes.json"), opts);
	assert.notEqual(match, null);
	assert.equal(match?.kind, "modes-permissions-file");
});

test("[C4] global rules dir (home) is blocked with kind global-rules-dir", () => {
	const match = matchProtectedPath(join(home, ".pi", "agent", "rules", "coding.md"), opts);
	assert.notEqual(match, null);
	assert.equal(match?.kind, "global-rules-dir");
});

test("[C4] project rules dir (cwd .pi/rules) is blocked with kind project-rules-dir", () => {
	const match = matchProtectedPath(join(cwd, ".pi", "rules", "style.md"), opts);
	assert.notEqual(match, null);
	assert.equal(match?.kind, "project-rules-dir");
});

test("[C4] compat rules dir (cwd .claude/rules) is blocked with kind compat-rules-dir", () => {
	const match = matchProtectedPath(join(cwd, ".claude", "rules", "legacy.md"), opts);
	assert.notEqual(match, null);
	assert.equal(match?.kind, "compat-rules-dir");
});

test("[C4] host settings.json (home) is blocked with kind host-settings-file", () => {
	const match = matchProtectedPath(join(home, ".pi", "agent", "settings.json"), opts);
	assert.notEqual(match, null);
	assert.equal(match?.kind, "host-settings-file");
});

test("[C4] dir boundaries include the dir itself and deeply nested files", () => {
	assert.notEqual(matchProtectedPath(join(cwd, ".pi", "rules"), opts), null);
	assert.notEqual(matchProtectedPath(join(home, ".pi", "agent", "rules", "sub", "deep", "note.md"), opts), null);
});

test("[C4] sibling prefixes do not hit: rules-evil dirs and permission-modes.json.bak pass", () => {
	assert.equal(matchProtectedPath(join(cwd, ".pi", "rules-evil", "x.md"), opts), null);
	assert.equal(matchProtectedPath(join(home, ".pi", "agent", "rules-evil", "x.md"), opts), null);
	assert.equal(matchProtectedPath(join(cwd, ".claude", "rules-evil", "x.md"), opts), null);
	assert.equal(matchProtectedPath(join(home, ".pi", "agent", "permission-modes.json.bak"), opts), null);
	assert.equal(matchProtectedPath(join(home, ".pi", "agent", "settings.json.bak"), opts), null);
});

test("[C4] plugin source repo paths pass even when the repo is the open cwd", () => {
	assert.equal(matchProtectedPath(join(cwd, "extensions", "memory", "guard.ts"), opts), null);
	assert.equal(matchProtectedPath(join(cwd, "lib", "rule-text.ts"), opts), null);
});

test("[C4] ordinary project files pass", () => {
	assert.equal(matchProtectedPath(join(cwd, "src", "main.ts"), opts), null);
	assert.equal(matchProtectedPath(join(cwd, "README.md"), opts), null);
});

test("[C4] relative path inputs return null (absPath assumption, callers resolve first)", () => {
	assert.equal(matchProtectedPath("extensions/memory/guard.ts", opts), null);
	assert.equal(matchProtectedPath(".pi/rules/note.md", opts), null);
	assert.equal(matchProtectedPath(".pi/agent/permission-modes.json", opts), null);
});

test("[C4] block reason names the kind, points to manual editing, and denies bypass exemption", () => {
	const reason = protectedPathBlockReason({ kind: "global-rules-dir", path: join(home, ".pi", "agent", "rules") });
	assert.match(reason, /global-rules-dir/);
	assert.match(reason, /self-modification boundary file/);
	assert.match(reason, /editor/);
	assert.match(reason, /bypassPermissions mode does not exempt/);
});
