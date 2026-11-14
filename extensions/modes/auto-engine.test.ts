/**
 * auto-engine.test.ts — E3 (spec 2026-11-15-cleanup-hardening): the
 * classifier-unavailable fail-closed block must carry the plain
 * unavailable message, not the YOLO rejection framing (no
 * "Permission … denied" prefix, no "add a permission rule" hint — that
 * hint makes no sense when the classifier itself is down).
 */
import { describe, expect, it, vi } from "vitest"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

vi.mock("./classifier-client.ts", () => ({
	classifyToolCall: vi.fn(async () => {
		throw new Error("classifier down")
	}),
	readAgentsMdForClassifier: vi.fn(() => null),
}))

import { createAutoEngine } from "./auto-engine.ts"

function makeEngine() {
	return createAutoEngine({
		getClassifierConfig: () => ({
			enabled: true,
			model: "test/model",
			timeoutMs: 10,
			includeAgentsMd: false,
		}),
		getAutoModeConfig: () => undefined,
		getMode: () => "auto",
		getFusionSchemaHint: () => "",
		promptWithPermissionOptions: vi.fn(async () => undefined),
		uiNotify: vi.fn(),
		trackOutsideWrite: vi.fn(),
	})
}

const ctx = {
	cwd: "/w",
	hasUI: false,
} as unknown as ExtensionContext

describe("auto-engine classifier-unavailable block (E3)", () => {
	it("returns the plain unavailable message without the denial framing", async () => {
		const engine = makeEngine()
		const block = await engine.approveTier3(
			ctx,
			"bash",
			{ command: "curl https://example.com" },
			{ tool: "bash", command: "curl https://example.com" },
		)
		expect(block?.block).toBe(true)
		const reason = block?.reason ?? ""
		expect(reason).toContain("temporarily unavailable")
		expect(reason).not.toContain("Permission for this action has been denied")
		expect(reason).not.toContain("add a permission rule")
	})
})
