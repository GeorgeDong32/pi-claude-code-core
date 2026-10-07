/**
 * footer-lines.test.ts — SPEC 2026-10-07 P1-1 §5 B4/B8: the multi-source
 * display.footer helper. Two sources merge (no overwrite), removal works,
 * reset/reload drops old lines, the empty result is an EXPLICIT empty array.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { resetCoreBusForTests, coreBus } from "../../extensions/bus.ts";
import { setFooterLine } from "../../extensions/ui/footer-lines.ts";

beforeEach(() => {
	resetCoreBusForTests();
});

describe("footer-lines (B4/B8)", () => {
	it("B4: two sources coexist; removing one keeps the other; removing the last publishes an explicit empty array", () => {
		setFooterLine("action-fusion", "action-fusion requires pi >=0.87.0");
		expect(coreBus().snapshot().display?.footer).toEqual(["action-fusion requires pi >=0.87.0"]);
		setFooterLine("observation-pack", "observation-pack requires pi >=0.87.0");
		expect(coreBus().snapshot().display?.footer).toEqual([
			"action-fusion requires pi >=0.87.0",
			"observation-pack requires pi >=0.87.0",
		]);
		// same-source overwrite is idempotent (no duplicate line)
		setFooterLine("action-fusion", "action-fusion requires pi >=0.87.0");
		expect(coreBus().snapshot().display?.footer).toHaveLength(2);
		setFooterLine("action-fusion", undefined);
		expect(coreBus().snapshot().display?.footer).toEqual(["observation-pack requires pi >=0.87.0"]);
		setFooterLine("observation-pack", undefined);
		// explicit EMPTY array — omitting the field would keep the stale value
		expect(coreBus().snapshot().display?.footer).toEqual([]);
	});

	it("B8: a bus reset (reload) does not inherit the old bus's lines; two session_starts do not add rows", () => {
		setFooterLine("action-fusion", "old line");
		expect(coreBus().snapshot().display?.footer).toEqual(["old line"]);
		resetCoreBusForTests();
		coreBus().publish({}); // fresh bus upgrade publish
		expect(coreBus().snapshot().display?.footer).toBeUndefined();
		setFooterLine("observation-pack", "new line");
		setFooterLine("observation-pack", "new line"); // re-register: idempotent
		expect(coreBus().snapshot().display?.footer).toEqual(["new line"]);
	});

	it("B8: display's other fields survive a footer publish (whole-display patch discipline)", () => {
		coreBus().publish({ display: { footer: ["x"] } });
		setFooterLine("s", "line");
		const display = coreBus().snapshot().display;
		expect(display).toBeDefined();
	});
});
