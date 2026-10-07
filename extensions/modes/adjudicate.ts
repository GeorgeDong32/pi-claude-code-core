/**
 * adjudicate.ts — the permission adjudication DECIDE half (SPEC 2026-10-07
 * P2-1, A1=B / A2=B). PURE: no pi, no ctx, no disk, no closures. The adapter
 * (index.ts) collects cheap in-memory facts and calls decide(); the decision
 * is then executed by interpret.ts through injected ports.
 *
 * Adjudication order (the whole point of this module — keep this table in
 * lockstep with decide() and the parity golden):
 *
 *  1. bypass            → allow (only side effect: outside-cwd write tracking)
 *  2. rule deny         → deny (terminal)
 *  3. plan hard limits  → deny (plan-gate.ts; allow/ask rules can never unlock)
 *  4. verdict allow     → allow (+ outside-write track + family note)
 *  5. verdict ask       → family first-seen dialog | permission prompt
 *  6. mode auto         → Step-1 transitional: the embedded-command auto scan
 *                         and the tier ladder still run the legacy path
 *                         (legacyAuto decision; becomes real decisions in
 *                         Step 2 — classifier stays behind that path)
 *  7. embedded commands → ask mode: an unsafe embedded command prompts
 *  8. mode plan         → allow (allowlist: read tools, tool_search, default)
 *  9. mode ask          → read outside cwd prompts; edit/write memory carve-out
 *                         allows, otherwise the 5-choice dialog; unsafe bash
 *                         prompts; everything else passes
 * 10. unknown           → allow (passthrough)
 *
 * Migration: Step 1 (bypass / rules / plan / ask) — this file. Step 2 folds
 * the auto tier ladder in. Step 3 extracts classifier retry with injected
 * clock/signal.
 */
import type { PermissionVerdict } from "./permissions.ts";

export type Mode = "ask" | "plan" | "auto" | "bypass";

/** Structural Block shape (host-free on purpose — this module stays pure). */
export interface BlockShape {
	block: true;
	reason: string;
}

export interface FamilyFacts {
	canonicalId: string;
	suggestedRule: string;
	/** An explicit ask rule exists for this canonical id — not first-seen. */
	hasExplicitAskRule: boolean;
}

/** Everything decide() needs, pre-collected by the adapter (all in-memory). */
export interface AdjudicationFacts {
	mode: Mode;
	tool: string;
	input: Record<string, unknown>;
	hasUI: boolean;
	cwd: string;
	/** evaluateToolPermission against the merged rule set (pure, in-memory). */
	verdict: PermissionVerdict;
	/** plan-gate hard block — adapter probes ONLY in plan mode. */
	planHardBlock?: BlockShape;
	/** family registry match (web walks before mcp inside the registry). */
	family: FamilyFacts | null;
	/** session grant present for the family match. */
	familySessionGrant: boolean;
	/** embedded (fusion-style) command strings found in non-primary fields. */
	embeddedCommands: string[];
	/** parallel to embeddedCommands: isSafeCommand per entry (ask semantics). */
	embeddedUnsafe: boolean[];
	/** fusionSchemaHint(tool) — label-only suffix for embedded prompts. */
	embeddedHint: string;
	/** String(input.path ?? "") */
	path: string;
	pathSensitive: boolean;
	pathOutsideCwd: boolean;
	/** memory-dir write carve-out (P3-PM-01). */
	pathIsMemoryDir: boolean;
	/** String(input.command ?? "") */
	command: string;
	/** isSafeCommand(command) — ask bash semantics. */
	commandSafe: boolean;
}

export interface AllowEffects {
	/** Track the write for /undo-outside-writes (bypass + verdict allow). */
	trackOutsideWrite?: boolean;
	/** Record the allow on the family adjudication cache (P4-MC-03). */
	familyAdjudication?: "rule-allow" | "session-grant";
}

export type PromptFlavor =
	| "permission-options" // promptWithPermissionOptions (forwarding/headless aware)
	| "approval" // plain promptApproval
	| "edit-write-choice"; // ask-mode 5-choice dialog on edit/write

export type Decision =
	| { kind: "allow"; effects: AllowEffects }
	| { kind: "deny"; reason: string }
	| { kind: "prompt"; flavor: PromptFlavor; label: string; category?: string; path?: string }
	| { kind: "firstSeen"; canonicalId: string; suggestedRule: string }
	| { kind: "legacyAuto" };

/** The decide function — pure, total, order fixed by the table above. */
export function decide(f: AdjudicationFacts): Decision {
	// 1. bypass: approve everything; outside-write tracking is an effect.
	if (f.mode === "bypass") {
		const effects: AllowEffects = {};
		if (f.tool === "edit" || f.tool === "write") effects.trackOutsideWrite = true;
		return { kind: "allow", effects };
	}

	// 2. rule deny (terminal, ahead of everything mode-specific).
	if (f.verdict.behavior === "deny") {
		return {
			kind: "deny",
			reason: `Denied by permission rule [${f.verdict.source}]: ${f.verdict.rule}`,
		};
	}

	// 3. plan hard limits — never prompt, never unlockable by allow/ask.
	if (f.planHardBlock) {
		return { kind: "deny", reason: f.planHardBlock.reason };
	}

	// 4. verdict allow: outside-write tracking + family adjudication note.
	if (f.verdict.behavior === "allow") {
		const effects: AllowEffects = {};
		if (f.tool === "edit" || f.tool === "write") effects.trackOutsideWrite = true;
		if (f.family) effects.familyAdjudication = f.familySessionGrant ? "session-grant" : "rule-allow";
		return { kind: "allow", effects };
	}

	// 5. verdict ask: family first-seen dialog beats the plain permission
	// prompt (P4-FAM-02: a family claiming the tool with no explicit ask
	// rule gets its allow once / session / always dialog).
	if (f.verdict.behavior === "ask") {
		if (f.family && !f.family.hasExplicitAskRule) {
			return { kind: "firstSeen", canonicalId: f.family.canonicalId, suggestedRule: f.family.suggestedRule };
		}
		return {
			kind: "prompt",
			flavor: "permission-options",
			label: `permission rule requires approval: ${f.verdict.rule}`,
			category: "permission-ask",
		};
	}

	// 6. auto: legacy path owns the embedded auto scan + tier ladder +
	// classifier until Step 2/3 land.
	if (f.mode === "auto") {
		return { kind: "legacyAuto" };
	}

	// 7. embedded commands (ask semantics ONLY — plan's copy lives in
	// plan-gate, auto's copy runs inside the legacy path until Step 2):
	// one unsafe embedded command prompts with the full command list.
	if (f.mode === "ask" && f.embeddedUnsafe.some((u) => u)) {
		return {
			kind: "prompt",
			flavor: "approval",
			label: `${f.embeddedCommands.map((c) => `"${c}"`).join(", ")}${f.embeddedHint}`,
		};
	}

	// 8. plan allowlist: read tools, tool_search and the default are all
	// plan-legal once the hard limits passed.
	if (f.mode === "plan") {
		return { kind: "allow", effects: {} };
	}

	// 9. ask dispatch.
	if (f.mode === "ask") {
		if (f.tool === "read" || f.tool === "grep" || f.tool === "find" || f.tool === "ls") {
			if (f.path && f.pathOutsideCwd) {
				return { kind: "prompt", flavor: "approval", label: `outside cwd on "${f.path}"` };
			}
			return { kind: "allow", effects: {} };
		}
		if (f.tool === "edit" || f.tool === "write") {
			if (f.pathIsMemoryDir) return { kind: "allow", effects: {} };
			// Headless edit/write takes the plain approval prompt (fail-closed
			// via its no-UI branch); the 5-choice dialog is UI-only.
			if (!f.hasUI) {
				return { kind: "prompt", flavor: "approval", label: `on ${f.path || "(unknown)"}` };
			}
			return {
				kind: "prompt",
				flavor: "edit-write-choice",
				label: `Allow ${f.tool} on ${f.path || "(unknown)"}?`,
				path: f.path || "(unknown)",
			};
		}
		if (f.tool === "bash" || f.tool === "powershell") {
			if (f.commandSafe) return { kind: "allow", effects: {} };
			return { kind: "prompt", flavor: "approval", label: `"${f.command}"` };
		}
		return { kind: "allow", effects: {} };
	}

	// 10. unreachable for the four known modes — passthrough like the old
	// fall-through return.
	return { kind: "allow", effects: {} };
}

/** The public adjudicator seam (spec §4.1): collect → decide → interpret. */
export interface ToolCallRequest {
	ctx: unknown;
	tool: string;
	input: Record<string, unknown>;
}

export interface AdjudicatorDeps {
	collectFacts(call: ToolCallRequest): AdjudicationFacts;
	interpret(call: ToolCallRequest, decision: Decision): Promise<BlockShape | undefined>;
}

export interface PermissionAdjudicator {
	check(call: ToolCallRequest): Promise<BlockShape | undefined>;
}

export function createPermissionAdjudicator(deps: AdjudicatorDeps): PermissionAdjudicator {
	return {
		async check(call) {
			const decision = decide(deps.collectFacts(call));
			return deps.interpret(call, decision);
		},
	};
}
