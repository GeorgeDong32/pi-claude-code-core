/**
 * auto-mode risk heuristic tests — carved from utils.test.ts (arch review C3).
 */
import { describe, expect, it } from "vitest";
import { checkAutoRisk } from "./auto-risk.ts";

describe("checkAutoRisk", () => {
	const cwd = "/home/user/project"

	it("flags risky bash and outside writes", () => {
		expect(checkAutoRisk({ tool: "bash", command: "rm -rf /" }, cwd).match).toBe(
			true,
		)
		expect(
			checkAutoRisk({ tool: "write", path: "/etc/hosts" }, cwd).match,
		).toBe(true)
	})

	it("allows file-descriptor duplication in bash commands", () => {
		expect(
			checkAutoRisk({ tool: "bash", command: "npm test 2>&1" }, cwd).match,
		).toBe(false)
	})

	it("blocks bash file redirects through >&", () => {
		expect(
			checkAutoRisk(
				{ tool: "bash", command: "npm test >& /tmp/out.log" },
				cwd,
			).match,
		).toBe(true)
	})
})
