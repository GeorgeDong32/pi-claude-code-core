/**
 * EffortOwner red-green suite (P1-EF-05/06) + source-scan (P1-EF-07).
 *
 * The a)–f) cases map 1:1 to the spec's behavior table. A fake pi records
 * setThinkingLevel calls; "model default" is simulated by the fake starting
 * at some level the owner never wrote.
 */
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
		// ② manual beats ③ profile: nothing written, still high.
		expect(pi.calls).toEqual(["high"]);
		expect(owner.effective()).toBe("high");
		expect(owner.currentSource()).toBe("session");
	});

	it("b) /effort reset clears ②, so the same profile switch lands on low", () => {
		const pi = fakePi("medium");
		const owner = newEffortOwner(pi as never);
		owner.setExplicit("high", "command");
		owner.setFromProfile("low", "profile-a"); // held off by ②
		owner.resetExplicit();
		// ③ now effective → pushed down.
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

		// Same-value explicit request is still the pinned value — refused too.
		expect(owner.setExplicit("low", "command")).toBe("pinned-by-env");

		// Profile writes are stored but env wins.
		owner.setFromProfile("high", "p");
		expect(pi.calls).toEqual(["low"]);
		expect(owner.currentSource()).toBe("env");

		// Unknown env tokens are ignored (no pin, no write).
		const pi2 = fakePi("medium");
		const owner2 = newEffortOwner(pi2 as never);
		owner2.setFromEnv("banana");
		expect(owner2.envPin()).toBeNull();
		expect(pi2.calls).toEqual([]);
	});

	it("d) profile without :effort never touches thinking level", () => {
		const pi = fakePi("medium");
		const owner = newEffortOwner(pi as never);
		// modes' guard skips setFromProfile entirely when the profile has no
		// `:effort` — the owner-side contract being that a profile switch
		// WITHOUT a profile write leaves the level and its source untouched.
		expect(pi.calls).toEqual([]);
		expect(owner.effective()).toBe("medium");
		expect(owner.currentSource()).toBe("model-default");
		// contrast: WITH a profile write the level moves — this is the switch
		// the guard suppresses when the profile lacks `:effort`
		owner.setFromProfile("low", "with-effort");
		expect(pi.calls).toEqual(["low"]);
	});

	it("e) fresh session with no ②/③ leaves the model default untouched", () => {
		const pi = fakePi("xhigh");
		const owner = newEffortOwner(pi as never);
		owner.setFromEnv(""); // empty env = unset
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
		owner.setFromProfile("low", "p"); // stored under ③, effective stays ② high
		owner.resetExplicit(); // drops to profile low
		// Fires on every state mutation (refresh is idempotent): the profile
		// write re-fires "high", the reset then lands on "low".
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
		owner.setFromProfile("medium", "p"); // equals current → no write
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
				// Strip line comments so design notes can mention the API name.
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
