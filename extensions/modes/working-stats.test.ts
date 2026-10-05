/**
 * AR1005-ST working-stats module behavior (spec 2026-10-05 §9):
 *  - ST-T05: hosts without (or with throwing) getLeafId take the uncached
 *    path and still get correct totals; read failures are never cached as
 *    successful snapshots (later events retry).
 *  - ST-T03: parity with a REAL SessionManager vs brute-force four-channel
 *    sums, and a key-hit second read on the real manager.
 * The wiring-level operation counts (ST-T01/T02/T07 through the real modes
 * hooks) live in index.test.ts next to the FakePi harness.
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"

import { createWorkingStats } from "./working-stats.ts"
import type { BranchEntry } from "./session-branch.ts"

function messageEntry(id: string, usage?: Record<string, unknown>): BranchEntry {
	return {
		type: "message",
		id,
		message: { role: "assistant", content: [{ type: "text", text: "x" }], usage },
	} as BranchEntry
}

describe("AR1005-ST module behavior", () => {
	it("ST-T05: a host without getLeafId takes the uncached path and still gets correct totals", () => {
		const cache = createWorkingStats()
		const entries = [messageEntry("e1", { input: 3, output: 4 })]
		const host = { sessionManager: { getBranch: () => entries } }
		const a = cache.snapshot(host)
		const b = cache.snapshot(host)
		expect(a.stats).toEqual({ input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0 })
		expect(b.stats).toEqual(a.stats) // correct, just uncached (old-host fallback)
	})

	it("ST-T05: a throwing getLeafId is uncacheable — never treated as a legal empty leaf", () => {
		const cache = createWorkingStats()
		const entries = [messageEntry("e1", { input: 7 })]
		const host = {
			sessionManager: {
				getBranch: () => entries,
				getLeafId: () => {
					throw new Error("boom")
				},
			},
		}
		expect(cache.snapshot(host).stats.input).toBe(7)
		expect(cache.snapshot(host).stats.input).toBe(7)
	})

	it("ST-T05: a failing getBranch read is never cached as a successful empty snapshot — later events retry", () => {
		const cache = createWorkingStats()
		let fail = true
		const entries = [messageEntry("e1", { input: 9 })]
		const host = {
			sessionManager: {
				getLeafId: () => "e1",
				getBranch: () => {
					if (fail) throw new Error("transient")
					return entries
				},
			},
		}
		expect(cache.snapshot(host).stats.input).toBe(0) // falls back to last totals
		fail = false
		expect(cache.snapshot(host).stats.input).toBe(9) // retried and recovered
	})

	it("ST-T02 (module): the legal empty branch (leaf null) is cacheable and distinct from uncacheable", () => {
		const cache = createWorkingStats()
		const host = {
			sessionManager: {
				getLeafId: () => null,
				getBranch: () => [] as BranchEntry[],
			},
		}
		const a = cache.snapshot(host)
		const b = cache.snapshot(host)
		expect(a.stats).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
		expect(b.stats).toEqual(a.stats) // null-leaf snapshot is reusable (identity is not the contract; zero host reads is)
	})
})

describe("AR1005-ST real-SessionManager parity (ST-T03)", () => {
	it("snapshot totals equal the brute-force four-channel sum over the real branch", () => {
		const tmp = mkdtempSync(join(tmpdir(), "st-real-"))
		try {
			type FileEntryLike = { id: string; parentId: string | null; type: string; message?: unknown; timestamp: number }
			const root: FileEntryLike = { id: "root", parentId: null, type: "session", timestamp: Date.now() }
			const fileEntries: FileEntryLike[] = [root]
			let parent = "root"
			for (let i = 0; i < 50; i++) {
				const id = `m${i}`
				fileEntries.push({
					id,
					parentId: parent,
					type: "message",
					message: {
						role: i % 2 === 0 ? "user" : "assistant",
						content: [{ type: "text", text: "x" }],
						usage: i % 2 === 1 ? { input: i, output: i * 2, cacheRead: i, cacheWrite: 0, cost: { total: i / 1000 } } : undefined,
					},
					timestamp: Date.now(),
				})
				parent = id
			}
			const sm = SessionManager.inMemory(tmp, undefined, fileEntries as never)
			const cache = createWorkingStats()
			const snap = cache.snapshot({ sessionManager: sm })
			let input = 0
			let output = 0
			let cacheRead = 0
			let cost = 0
			for (const e of fileEntries) {
				const u = (e.message as { usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } } | undefined)?.usage
				if (u) {
					input += u.input || 0
					output += u.output || 0
					cacheRead += u.cacheRead || 0
					cost += u.cost?.total || 0
				}
			}
			expect(snap.stats.input).toBe(input)
			expect(snap.stats.output).toBe(output)
			expect(snap.stats.cacheRead).toBe(cacheRead)
			expect(Math.abs(snap.stats.cost - cost)).toBeLessThan(1e-9)
			const again = cache.snapshot({ sessionManager: sm })
			expect(again.stats).toEqual(snap.stats)
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})
})

describe("AR1005-ST capability-consistency regression (adversarial R1)", () => {
	it("a forced read with the usage capability keeps usage alive on later key hits (ctx% never disappears mid-stream)", () => {
		const cache = createWorkingStats()
		let usageCalls = 0
		const host = {
			sessionManager: { getLeafId: () => "e1", getBranch: () => [] },
			getContextUsage: () => {
				usageCalls++
				return { tokens: 5, contextWindow: 100, percent: 5 }
			},
		}
		// turn_start-style forced read WITH the capability
		const forced = cache.snapshot(host, { force: true })
		expect(forced.usage?.percent).toBe(5)
		// message_update-style key hit must still carry the usage
		const hit = cache.snapshot(host)
		expect(hit.usage?.percent).toBe(5)
		expect(hit).toBe(forced)
		// and a capability-less forced snapshot never poisons freshness for
		// capability-bearing later reads
		const bareForced = cache.snapshot({ sessionManager: host.sessionManager }, { force: true })
		expect(bareForced.usage).toBeUndefined()
		const recovered = cache.snapshot(host)
		expect(recovered.usage?.percent).toBe(5)
		expect(usageCalls).toBe(2) // forced + recovered; the capability-less read makes NO host call
	})
})
