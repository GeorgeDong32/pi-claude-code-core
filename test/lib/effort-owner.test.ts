import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { newEffortOwner, getSharedEffortOwner, type OwnerEffortLevel } from "../../lib/effort-owner.ts";

function fakePi(initial: OwnerEffortLevel = "medium") {
	const calls: OwnerEffortLevel[] = [];
	let level = initial;
	return {
		calls,
		getThinkingLevel: (): OwnerEffortLevel => level,
		setThinkingLevel: (l: OwnerEffortLevel) => {
			calls.push(l);
			level = l;
		},
	};
}

describe("P1-EF-05 EffortOwner interface", () => {
	it("exposes the spec interface surface", () => {
		const pi = fakePi();
		const owner = newEffortOwner(pi as never);
		for (const method of [
			"setFromEnv",
			"setExplicit",
			"setFromProfile",
			"resetExplicit",
			"envPin",
			"effective",
			"currentSource",
			"changed",
		]) {
			expect(typeof (owner as unknown as Record<string, unknown>)[method]).toBe("function");
		}
	});

	it("shares one owner per pi instance (modes + effort arbitrate together)", () => {
		const pi = fakePi();
		expect(getSharedEffortOwner(pi as never)).toBe(getSharedEffortOwner(pi as never));
		const other = fakePi();
		expect(getSharedEffortOwner(other as never)).not.toBe(getSharedEffortOwner(pi as never));
	});
});

describe("P1-EF-06 ownership chain behavior", () => {
	it("a) explicit /effort high survives a mode switch to a profile with :low", () => {
		const pi = fakePi("medium");
		const owner = newEffortOwner(pi as never);
		owner.setExplicit("high", "command");
		expect(pi.calls).toEqual(["high"]);

		owner.setFromProfile("low", "profile-a");
		expect(pi.calls).toEqual(["high"]);
		expect(owner.effective()).toBe("high");
		expect(owner.currentSource()).toBe("session");
	});

	it("b) /effort reset clears ②, so the same profile switch lands on low", () => {
		const pi = fakePi("medium");
		const owner = newEffortOwner(pi as never);
		owner.setExplicit("high", "command");
		owner.setFromProfile("low", "profile-a");
		owner.resetExplicit();
		expect(pi.calls).toEqual(["high", "low"]);
		expect(owner.effective()).toBe("low");
		expect(owner.currentSource()).toBe("profile");
	});

	it("c) PI_CORE_EFFORT=low pins: /effort high is refused and never applies", () => {
		const pi = fakePi("medium");
		const owner = newEffortOwner(pi as never);
		owner.setFromEnv("low");
		expect(pi.calls).toEqual(["low"]);
		expect(owner.envPin()).toBe("low");

		const result = owner.setExplicit("high", "command");
		expect(result).toBe("pinned-by-env");
		expect(pi.calls).toEqual(["low"]);
		expect(owner.effective()).toBe("low");
		expect(owner.currentSource()).toBe("env");

		expect(owner.setExplicit("low", "command")).toBe("pinned-by-env");

		owner.setFromProfile("high", "p");
		expect(pi.calls).toEqual(["low"]);
		expect(owner.currentSource()).toBe("env");

		const pi2 = fakePi("medium");
		const owner2 = newEffortOwner(pi2 as never);
		owner2.setFromEnv("banana");
		expect(owner2.envPin()).toBeNull();
		expect(pi2.calls).toEqual([]);
	});

	it("d) profile without :effort never touches thinking level", () => {
		const pi = fakePi("medium");
		const owner = newEffortOwner(pi as never);
		expect(pi.calls).toEqual([]);
		expect(owner.effective()).toBe("medium");
		expect(owner.currentSource()).toBe("model-default");
		owner.setFromProfile("low", "with-effort");
		expect(pi.calls).toEqual(["low"]);
	});

	it("e) fresh session with no ②/③ leaves the model default untouched", () => {
		const pi = fakePi("xhigh");
		const owner = newEffortOwner(pi as never);
		owner.setFromEnv("");
		expect(pi.calls).toEqual([]);
		expect(owner.effective()).toBe("xhigh");
		expect(owner.currentSource()).toBe("model-default");
	});

	it("f) alt+t cycled level survives a profile switch (shortcut path pins like a)", () => {
		const pi = fakePi("off");
		const owner = newEffortOwner(pi as never);
		const result = owner.setExplicit("low", "shortcut");
		expect(result).toBe("applied");
		expect(pi.calls).toEqual(["low"]);

		owner.setFromProfile("high", "profile-b");
		expect(pi.calls).toEqual(["low"]);
		expect(owner.effective()).toBe("low");
	});

	it("changed() fires after every state change with the effective value", () => {
		const pi = fakePi("medium");
		const owner = newEffortOwner(pi as never);
		const seen: OwnerEffortLevel[] = [];
		owner.changed((v) => seen.push(v));
		owner.setExplicit("high", "command");
		owner.setFromProfile("low", "p");
		owner.resetExplicit();
		expect(seen).toEqual(["high", "high", "low"]);
	});

	it("resetExplicit with no ② is a no-op (no listener churn, no writes)", () => {
		const pi = fakePi("medium");
		const owner = newEffortOwner(pi as never);
		const seen: OwnerEffortLevel[] = [];
		owner.changed((v) => seen.push(v));
		owner.resetExplicit();
		expect(seen).toEqual([]);
		expect(pi.calls).toEqual([]);
	});

	it("effective value already applied is not re-written (idempotent apply)", () => {
		const pi = fakePi("medium");
		const owner = newEffortOwner(pi as never);
		owner.setFromProfile("medium", "p");
		expect(pi.calls).toEqual([]);
	});
});

describe("P1-EF-07 single-writer source scan", () => {
	it("no module in extensions/{modes,effort} calls setThinkingLevel directly", () => {
		const extensionsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions");
		const offenders: string[] = [];
		for (const moduleDir of ["modes", "effort"]) {
			const files = readdirSync(join(extensionsDir, moduleDir));
			for (const file of files) {
				if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
				const src = readFileSync(join(extensionsDir, moduleDir, file), "utf-8");
				const stripped = src
					.split("\n")
					.map((line) => line.replace(/\/\/.*$/, ""))
					.join("\n");
				if (/setThinkingLevel/.test(stripped)) {
					offenders.push(`${moduleDir}/${file}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
