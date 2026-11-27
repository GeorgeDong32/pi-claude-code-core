import { canonicalizeMcpTool, directKnownServersFromEnv } from "./family.ts";

export interface McpApprovalEvent {
	callId?: string;
	server?: string;
	tool?: string;
}

export type MirrorDecision = "allow_once" | "deny";

export interface McpEventPort {
	present: boolean;
	onApprovalRequest?(handler: (event: McpApprovalEvent) => MirrorDecision): () => void;
	snapshot?(): { connected: boolean; version: number; servers?: string[] };
}

export interface MirrorDeps {
	getAdjudication(canonicalId: string): { outcome: string } | undefined;
	bypassActive(): boolean;
	hasAllowRule(canonicalId: string): boolean;
	hasSessionGrant(canonicalId: string): boolean;
	onDeny?: (canonicalId: string) => void;
}

export interface BrokerMirror {
	start(): void;
	stop(): void;
	decide(canonicalId: string): MirrorDecision;
	denyCount(): number;
}

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
		if (adjudication && adjudication.outcome !== "deny") return "allow_once";
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
		return "deny";
	}

	return {
		start() {
			if (!port.present || !port.onApprovalRequest) return;
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

export async function probeMcpAdapterPort(): Promise<McpEventPort> {
	try {
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
		return { present: false };
	}
}
