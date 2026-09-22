/**
 * mcp-gov/broker.ts — the broker MIRROR (P4-MC-03, DESIGN-MCP-GOV ②/③).
 *
 * The pm tool_call gate owns every decision; the mirror only mirrors them
 * to the pi-mcp-adapter approval broker so the adapter's own prompts are
 * suppressed in lockstep. Synchronous pure function, never prompts.
 *
 * Allow chain (order matters — P4-MC-03):
 *   adjudicated cache → bypass → rule allow → session grant → allow_once;
 *   anything else → fail-closed deny (counted for the /core panel).
 *
 * McpEventPort (P4-MC-05): the production adapter is probed with a dynamic
 * import (absent → zero subscriptions, zero side effects — the local
 * machine state); tests inject a MockMcpBus.
 */

import { canonicalizeMcpTool, directKnownServersFromEnv } from "./family.ts";

export interface McpApprovalEvent {
	/** adapter-side id (best effort — see P4-MC-07) */
	callId?: string;
	server?: string;
	tool?: string;
}

export type MirrorDecision = "allow_once" | "deny";

export interface McpEventPort {
	present: boolean;
	/** Subscribe to adapter approval requests; returns unsubscribe. */
	onApprovalRequest?(handler: (event: McpApprovalEvent) => MirrorDecision): () => void;
	/** Live snapshot for the panel (absent → panel falls back to inventory). */
	snapshot?(): { connected: boolean; version: number; servers?: string[] };
}

export interface MirrorDeps {
	/** canonicalId → outcome recorded by the gate (rule-families). */
	getAdjudication(canonicalId: string): { outcome: string } | undefined;
	bypassActive(): boolean;
	/** Rule lookup over the current merged pm rules. */
	hasAllowRule(canonicalId: string): boolean;
	hasSessionGrant(canonicalId: string): boolean;
	/** deny counter for the /core panel */
	onDeny?: (canonicalId: string) => void;
}

export interface BrokerMirror {
	start(): void;
	stop(): void;
	/** The sync pure decision — exported for the consistency matrix tests. */
	decide(canonicalId: string): MirrorDecision;
	denyCount(): number;
}

/**
 * Canonical id for an adapter approval event. Reuses canonicalizeMcpTool so
 * a tool name that already carries the native `mcp__server__tool` prefix is
 * canonicalized instead of naively re-prefixed (`mcp_mcp__exa__search`
 * would miss every adjudication and rule → fail-closed against a call the
 * gate already allowed).
 */
export function canonicalIdForEvent(event: McpApprovalEvent): string {
	const known = new Set(directKnownServersFromEnv().map((s) => s.toLowerCase()));
	if (event.tool) {
		const selfCanonical = canonicalizeMcpTool(event.tool, {}, known);
		if (selfCanonical) return selfCanonical;
		if (event.server) return `mcp_${event.server}_${event.tool}`;
		return `mcp_${event.tool}`;
	}
	return "mcp_unknown";
}

export function createBrokerMirror(port: McpEventPort, deps: MirrorDeps): BrokerMirror {
	let denies = 0;
	let unsubscribe: (() => void) | undefined;

	function decide(canonicalId: string): MirrorDecision {
		const adjudication = deps.getAdjudication(canonicalId);
		if (adjudication && adjudication.outcome !== "deny") return "allow_once"; // cache hit
		if (adjudication?.outcome === "deny") {
			denies++;
			deps.onDeny?.(canonicalId);
			return "deny";
		}
		if (deps.bypassActive()) return "allow_once";
		if (deps.hasAllowRule(canonicalId)) return "allow_once";
		if (deps.hasSessionGrant(canonicalId)) return "allow_once";
		denies++;
		deps.onDeny?.(canonicalId);
		return "deny"; // fail-closed
	}

	return {
		start() {
			if (!port.present || !port.onApprovalRequest) return; // absent adapter → idle
			// defensive: a second start never stacks subscriptions
			unsubscribe?.();
			unsubscribe = port.onApprovalRequest((event) => decide(canonicalIdForEvent(event)));
		},
		stop() {
			unsubscribe?.();
			unsubscribe = undefined;
		},
		decide,
		denyCount: () => denies,
	};
}

/** Production port: dynamic import probe of pi-mcp-adapter (P4-MC-05). */
export async function probeMcpAdapterPort(): Promise<McpEventPort> {
	try {
		// variable specifier keeps tsc from resolving the optional peer
		const specifier = "pi-mcp-adapter";
		const adapter = (await import(/* @vite-ignore */ specifier)) as {
			onApprovalRequest?: unknown;
			getSnapshot?: unknown;
		};
		if (typeof adapter.onApprovalRequest !== "function") return { present: false };
		return {
			present: true,
			onApprovalRequest: adapter.onApprovalRequest as McpEventPort["onApprovalRequest"],
			snapshot:
				typeof adapter.getSnapshot === "function"
					? () => (adapter.getSnapshot as McpEventPort["snapshot"])!()
					: undefined,
		};
	} catch {
		return { present: false }; // not installed → zero side effects
	}
}
