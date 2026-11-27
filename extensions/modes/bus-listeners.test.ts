import { describe, expect, it } from "vitest"
import { createCoreBus } from "../bus.ts"

describe("BH-R7d: bus listener isolation", () => {
	it("one throwing listener does not stop the others from receiving the current snapshot", () => {
		const bus = createCoreBus()
		bus.publish({ modes: { mode: "", workingStats: null } })
		const onChange = bus.snapshot().onChange
		if (!onChange) throw new Error("expected v2 snapshot with onChange after first publish")
		const seen: Array<{ revision: number; mode: string }> = []
		const off1 = onChange(() => {
			throw new Error("listener exploded")
		})
		const off2 = onChange(() => {
			const snap = bus.snapshot()
			seen.push({ revision: snap.revision, mode: snap.modes.mode })
		})
		const snap = bus.publish({ modes: { mode: "auto", workingStats: null } })
		expect(seen).toEqual([{ revision: snap.revision, mode: "auto" }])
		expect(snap.modes.mode).toBe("auto")
		off1()
		off2()
		bus.dispose()
	})
})
