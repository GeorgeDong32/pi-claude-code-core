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
 *  6. mode auto         → embedded-command scan (sensitive path / tier check
 *                         prompts) then the tier ladder: tool_search / read
 *                         (sensitive path) / edit-write (sensitive path,
 *                         inside cwd) / bash tier1 → 1.5 allow → 1.5b
 *                         soft_deny → tier2; anything else defers to the
 *                         classifier seam (classify decision — the retry
 *                         loop itself is extracted in Step 3)
 *  7. embedded commands → ask mode: an unsafe embedded command prompts
 *  8. mode plan         → allow (allowlist: read tools, tool_search, default)
 *  9. mode ask          → read outside cwd prompts; edit/write memory carve-out
 *                         allows, otherwise the 5-choice dialog; unsafe bash
 *                         prompts; everything else passes
 * 10. unknown           → allow (passthrough)
 *
 * Migration: Step 1 (bypass / rules / plan / ask) + Step 2 (auto tier
 * ladder) landed. Step 3 extracts the classifier retry with injected
 * clock/signal behind the classify decision.
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
	// ---- auto ladder probes (adapter computes; decide only branches) ----
	/** Embedded commands with their auto-ladder probes, in scan order. */
	embeddedAuto: Array<{ command: string; sensitive: boolean; safe: boolean; autoApprovable: boolean }>;
	/** classifyBashTiers(command) — undefined when no command. */
	bashTiers?: { safe: boolean; autoApprovable: boolean };
	/** commandReferencesSensitivePath(command). */
	commandSensitive: boolean;
	/** autoMode.allow pattern matched the command (guarded by tiers in decide). */
	autoAllowMatched: boolean;
	/** autoMode.soft_deny pattern matched the command. */
	autoSoftDenyMatched: boolean;
	/** describeTier3Review(tool, input, cwd) — the tier-3 prompt label. */
	tier3ReviewLabel: string;
}

export interface AllowEffects {
	/** Track the write for /undo-outside-writes (bypass + verdict allow). */
	trackOutsideWrite?: boolean;
	/** Record the allow on the family adjudication cache (P4-MC-03). */
	familyAdjudication?: "rule-allow" | "session-grant";
	/**
	 * Reset the classifier denial state (the old allowToolCall side effect —
	 * every auto-ladder allow and the verdict-allow path did this in auto
	 * mode; bypass / plan / ask allows never did).
	 */
	resetAutoDenialState?: boolean;
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
	/** Auto tier-3: the classifier seam (approveAutoTier3 until Step 3). */
	| { kind: "classify"; tier3: { command?: string; path?: string } };

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

	// 4. verdict allow: outside-write tracking + family adjudication note
	// (allowToolCall's auto denial-state reset applies here too — the old
	// gate ran every verdict allow through allowToolCall()).
	if (f.verdict.behavior === "allow") {
		const effects: AllowEffects = {};
		if (f.tool === "edit" || f.tool === "write") effects.trackOutsideWrite = true;
		if (f.family) effects.familyAdjudication = f.familySessionGrant ? "session-grant" : "rule-allow";
		if (f.mode === "auto") effects.resetAutoDenialState = true;
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

	// 6. auto: embedded-command scan, then the tier ladder. Everything the
	// ladder cannot decide locally defers to the classifier seam.
	if (f.mode === "auto") {
		for (const e of f.embeddedAuto) {
			if (e.sensitive) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: `sensitive path in command: ${e.command}${f.embeddedHint}`,
					category: "sensitive-path",
				};
			}
			if (!e.safe && !e.autoApprovable) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: f.tier3ReviewLabel,
					category: "fusion-command",
				};
			}
		}

		// META-03: retrieval-only meta tool passes like the read tier.
		if (f.tool === "tool_search") {
			return { kind: "allow", effects: { resetAutoDenialState: true } };
		}
		if (f.tool === "read" || f.tool === "grep" || f.tool === "find" || f.tool === "ls") {
			if (f.pathSensitive) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: `sensitive path "${f.path}"`,
					category: "sensitive-path",
				};
			}
			return { kind: "allow", effects: { resetAutoDenialState: true } };
		}
		if (f.tool === "edit" || f.tool === "write") {
			if (f.pathSensitive) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: `sensitive path "${f.path}"`,
					category: "sensitive-path",
				};
			}
			if (!f.path || !f.pathOutsideCwd) {
				return { kind: "allow", effects: { resetAutoDenialState: true } };
			}
			// outside cwd — falls to the classifier seam with the path context
		}
		if (f.tool === "bash" || f.tool === "powershell") {
			if (f.command && f.commandSensitive) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: `sensitive path in command: ${f.command}`,
					category: "sensitive-path",
				};
			}
			// Tier 1: read-only bash auto-approves.
			if (f.bashTiers?.safe) {
				return { kind: "allow", effects: { resetAutoDenialState: true } };
			}
			// Tier 1.5: autoMode.allow user rules short-circuit before the
			// classifier — compound commands must still be fully auto-
			// approvable ("npm install && rm -rf /" must not slip through a
			// bare "npm" pattern).
			if (f.command && f.autoAllowMatched && f.bashTiers?.autoApprovable) {
				return { kind: "allow", effects: { resetAutoDenialState: true } };
			}
			// Tier 1.5b: autoMode.soft_deny forces a prompt.
			if (f.command && f.autoSoftDenyMatched) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: "matched autoMode.soft_deny",
					category: "auto-deny",
				};
			}
			// Tier 2: common dev workflow commands auto-approve.
			if (f.bashTiers?.autoApprovable) {
				return { kind: "allow", effects: { resetAutoDenialState: true } };
			}
		}

		return {
			kind: "classify",
			tier3: {
				command: f.tool === "bash" || f.tool === "powershell" ? f.command : undefined,
				path: f.tool === "edit" || f.tool === "write" ? f.path : undefined,
			},
		};
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
