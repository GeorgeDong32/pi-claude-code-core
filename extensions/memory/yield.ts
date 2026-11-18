
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { POLICY_MARKER } from "./policy.ts";
import { join } from "node:path";
import { readJson } from "../../lib/settings.ts";

export interface YieldState {
	yielded: boolean;
	detectedBy?: string;
}

export function staticProbe(agentDir: string): boolean {
	const settings = readJson<{ packages?: unknown }>(join(agentDir, "settings.json"), {});
	if (Array.isArray(settings.packages)) {
		for (const pkg of settings.packages) {
			if (typeof pkg === "string" && /hermes/i.test(pkg)) return true;
		}
	}
	try {
		const npmDir = join(agentDir, "npm", "node_modules");
		if (existsSync(npmDir)) {
			for (const entry of readdirSync(npmDir)) {
				if (/hermes/i.test(entry)) return true;
			}
		}
	} catch {
	}
	return false;
}

export class InjectionGate {
	readonly state: YieldState = { yielded: false };

	constructor(private readonly agentDir: string) {}

	probeStatic(): YieldState {
		if (staticProbe(this.agentDir)) {
			this.state.yielded = true;
			this.state.detectedBy = "static-scan";
		}
		return this.state;
	}

	probePrompt(systemPrompt: string): YieldState {
		if (this.state.yielded) return this.state;
		if (systemPrompt.includes(POLICY_MARKER)) {
			this.state.yielded = true;
			this.state.detectedBy = "dynamic-prompt";
		}
		return this.state;
	}
}
