/**
 * memory/yield.ts — the InjectionGate (P3-ME-06).
 *
 * When another memory engine (hermes) is present, this module YIELDS the
 * injection lane entirely: no policy, no index, no per-turn selection. The
 * gate only governs INJECTION — tools, commands and importers always run.
 *
 * Two probes:
 *   - static (session_start): scan settings packages + the npm dir for a
 *     hermes package;
 *   - dynamic (first before_agent_start): the systemPrompt already carries
 *     a `<memory-policy` marker (covers unfavorable load order).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { POLICY_MARKER } from "./policy.ts";
import { join } from "node:path";
import { readJson } from "../../lib/settings.ts";

export interface YieldState {
	yielded: boolean;
	/** Which probe decided (static dir name / "dynamic-prompt"). */
	detectedBy?: string;
}

/** Static probe: hermes present among installed packages? */
export function staticProbe(agentDir: string): boolean {
	// 1) settings.json packages entries — quickwin-1: readJson (invariant 10);
	// missing/malformed → {} exactly like the old hand-rolled read.
	const settings = readJson<{ packages?: unknown }>(join(agentDir, "settings.json"), {});
	if (Array.isArray(settings.packages)) {
		for (const pkg of settings.packages) {
			if (typeof pkg === "string" && /hermes/i.test(pkg)) return true;
		}
	}
	// 2) npm install dir scan
	try {
		const npmDir = join(agentDir, "npm", "node_modules");
		if (existsSync(npmDir)) {
			for (const entry of readdirSync(npmDir)) {
				if (/hermes/i.test(entry)) return true;
			}
		}
	} catch {
		/* ignore */
	}
	return false;
}

export class InjectionGate {
	readonly state: YieldState = { yielded: false };

	constructor(private readonly agentDir: string) {}

	/** session_start: run the static probe. */
	probeStatic(): YieldState {
		if (staticProbe(this.agentDir)) {
			this.state.yielded = true;
			this.state.detectedBy = "static-scan";
		}
		return this.state;
	}

	/** First before_agent_start: dynamic prompt-marker probe (idempotent). */
	probePrompt(systemPrompt: string): YieldState {
		if (this.state.yielded) return this.state;
		// B2: the marker constant is owned by policy.ts (the renderer) — this
		// probe and the policy text can no longer drift apart silently.
		if (systemPrompt.includes(POLICY_MARKER)) {
			this.state.yielded = true;
			this.state.detectedBy = "dynamic-prompt";
		}
		return this.state;
	}
}
