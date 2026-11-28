import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { matchProtectedPath, protectedPathBlockReason, type ProtectedPathsInput } from "./protected-paths.ts";

const home = "/home/tester";
const cwd = "/Users/gd32/Coding/Pi-Extension/pi-claude-code-core";
const opts: ProtectedPathsInput = { home, cwd };

describe("[C4] protected paths", () => {
	it("blocks permission-modes.json, both rules dirs, the compat rules dir and settings.json with their kinds", () => {
		const agent = join(home, ".pi", "agent");
		expect(matchProtectedPath(join(agent, "permission-modes.json"), opts)?.kind).toBe("modes-permissions-file");
		expect(matchProtectedPath(join(agent, "rules", "coding.md"), opts)?.kind).toBe("global-rules-dir");
		expect(matchProtectedPath(join(cwd, ".pi", "rules", "style.md"), opts)?.kind).toBe("project-rules-dir");
		expect(matchProtectedPath(join(cwd, ".claude", "rules", "legacy.md"), opts)?.kind).toBe("compat-rules-dir");
		expect(matchProtectedPath(join(agent, "settings.json"), opts)?.kind).toBe("host-settings-file");
	});

	it("dir boundaries include the dir itself and deeply nested files", () => {
		expect(matchProtectedPath(join(cwd, ".pi", "rules"), opts)).not.toBeNull();
		expect(matchProtectedPath(join(home, ".pi", "agent", "rules", "sub", "deep", "note.md"), opts)).not.toBeNull();
	});

	it("sibling prefixes do not hit: rules-evil dirs and .bak files pass", () => {
		expect(matchProtectedPath(join(cwd, ".pi", "rules-evil", "x.md"), opts)).toBeNull();
		expect(matchProtectedPath(join(home, ".pi", "agent", "rules-evil", "x.md"), opts)).toBeNull();
		expect(matchProtectedPath(join(cwd, ".claude", "rules-evil", "x.md"), opts)).toBeNull();
		expect(matchProtectedPath(join(home, ".pi", "agent", "permission-modes.json.bak"), opts)).toBeNull();
		expect(matchProtectedPath(join(home, ".pi", "agent", "settings.json.bak"), opts)).toBeNull();
	});

	it("plugin source repo paths pass even when the repo is the open cwd", () => {
		expect(matchProtectedPath(join(cwd, "extensions", "modes", "index.ts"), opts)).toBeNull();
		expect(matchProtectedPath(join(cwd, "lib", "rule-text.ts"), opts)).toBeNull();
	});

	it("ordinary project files pass", () => {
		expect(matchProtectedPath(join(cwd, "src", "main.ts"), opts)).toBeNull();
		expect(matchProtectedPath(join(cwd, "README.md"), opts)).toBeNull();
	});

	it("relative path inputs return null (callers resolve first)", () => {
		expect(matchProtectedPath("extensions/modes/index.ts", opts)).toBeNull();
		expect(matchProtectedPath(".pi/rules/note.md", opts)).toBeNull();
		expect(matchProtectedPath(".pi/agent/permission-modes.json", opts)).toBeNull();
	});

	it("block reason names the kind, points to manual editing, and denies bypass exemption", () => {
		const reason = protectedPathBlockReason({ kind: "global-rules-dir", path: join(home, ".pi", "agent", "rules") });
		expect(reason).toMatch(/global-rules-dir/);
		expect(reason).toMatch(/self-modification boundary file/);
		expect(reason).toMatch(/editor/);
		expect(reason).toMatch(/bypassPermissions mode does not exempt/);
	});
});
