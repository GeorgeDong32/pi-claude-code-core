/**
 * formatCount tests — carved from utils.test.ts (arch review C3).
 */
import { describe, expect, it } from "vitest";
import { formatCount } from "../ui/format.ts";

describe("formatCount", () => {
	it("returns 0 for 0", () => {
		expect(formatCount(0)).toBe("0");
	});

	it("returns the number for small values", () => {
		expect(formatCount(1)).toBe("1");
		expect(formatCount(999)).toBe("999");
	});

	it("formats thousands as k", () => {
		expect(formatCount(1234)).toBe("1.2k");
		expect(formatCount(9999)).toBe("10.0k");
		expect(formatCount(12000)).toBe("12k");
	});

	it("handles invalid numbers", () => {
		expect(formatCount(NaN)).toBe("0");
		expect(formatCount(Infinity)).toBe("0");
		expect(formatCount(-100)).toBe("0");
	});
});
