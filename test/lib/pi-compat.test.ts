import { describe, expect, it } from "vitest";
import { MIN_PI_VERSION, probePiCompat, versionAtLeast } from "../../lib/pi-compat.ts";

describe("pi-compat probes (SPEC CMP)", () => {
	it("versionAtLeast handles equals, greater, lesser and malformed", () => {
		expect(versionAtLeast("0.87.0", "0.87.0")).toBe(true);
		expect(versionAtLeast("0.87.1", "0.87.0")).toBe(true);
		expect(versionAtLeast("1.0.0", "0.87.0")).toBe(true);
		expect(versionAtLeast("0.86.9", "0.87.0")).toBe(false);
		expect(versionAtLeast("not-a-version", "0.87.0")).toBe(false);
		expect(versionAtLeast("0.87.1-beta.2", "0.87.0")).toBe(true);
	});

	it("probePiCompat reports all-good on the verified host shape", () => {
		const compat = probePiCompat({
			version: "0.87.1",
			toolFactories: {
				write: () => {},
				edit: () => {},
				bash: () => {},
			},
			mutationQueue: () => {},
		});
		expect(compat.versionOk).toBe(true);
		expect(compat.toolFactories).toBe(true);
		expect(compat.mutationQueue).toBe(true);
		expect(compat.problems).toEqual([]);
	});

	it("probePiCompat flags an old version and missing exports independently", () => {
		const old = probePiCompat({ version: "0.85.1" });
		expect(old.versionOk).toBe(false);
		expect(old.problems.some((p) => p.includes("<"))).toBe(true);

		const noQueue = probePiCompat({
			version: "0.87.1",
			toolFactories: { write: () => {} },
			mutationQueue: undefined,
		});
		expect(noQueue.mutationQueue).toBe(false);
		expect(noQueue.problems.includes("withFileMutationQueue unavailable")).toBe(true);

		const brokenFactory = probePiCompat({
			version: "0.87.1",
			toolFactories: { write: "not a function" },
			mutationQueue: () => {},
		});
		expect(brokenFactory.toolFactories).toBe(false);
	});

	it("MIN_PI_VERSION pins the semantics the spec verified", () => {
		expect(MIN_PI_VERSION).toBe("0.87.0");
	});
});
