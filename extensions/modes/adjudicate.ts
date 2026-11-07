/**
 * adjudicate.ts — the permission adjudication DECIDE half (SPEC 2026-10-07
 * P2-1, A1=B / A2=B). PURE: no pi, no ctx, no disk, no closures. The adapter
 * (index.ts) collects cheap in-memory facts and calls decide(); the decision
 * is then executed by interpret.ts through injected ports.
 *
 * Adjudication order (the whole point of this module — keep this table in
 * lockstep with decide() and the parity golden):
 *
 *  1. rule deny         → deny (terminal; CC 1a/1d — an explicit deny rule
 *                          is bypass-immune; reordered ahead of bypass
 *                          2026-11-02, BREAKING: bypass used to win)
 *     + W4 bash deny ext→ deny (Read/Edit deny rules cover bash path
 *                          targets — redirections + write-command args,
 *                          every mode, 2026-11-07)
 *  2. mode bypass       → CC alignment (1f/1g → 2a): an explicit ask rule
 *                          prompts (1f; W1 2026-11-07: family default-ask
 *                          auto-approves), a CC-parity sensitive path on
 *                          edit/write prompts (1g — W2: isCcSafetyPath
 *                          superset; bash has NO sensitive scan in CC
 *                          bypass, W3 adds a write-target check), else
 *                          allows (side effect: outside-cwd write tracking)
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
	/** W2 (2026-11-07): isCcSafetyPath(path) — CC DANGEROUS set ∪ pi extras;
	 * the bypass edit/write gate (1g) uses this wider CC-parity set. */
	pathCcSafety: boolean;
	/** W3 (2026-11-07): bash write-target check result (bypass gate) — null
	 * when the PI_CORE_BASH_PATH_CHECKS switch is off or no target matched. */
	bashPathCheck: { path: string; kind: "redirect" | "argument" } | null;
	/** W4 (2026-11-07): full deny reason when a Read/Edit deny rule matches a
	 * bash path target (all modes); null otherwise. Switch-gated like W3. */
	bashDenyRule: string | null;
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
	/** Auto tier-3: the classifier seam (auto-engine.ts approveTier3). */
	| { kind: "classify"; tier3: { command?: string; path?: string } };

/** The decide function — pure, total, order fixed by the table above. */
export function decide(f: AdjudicationFacts): Decision {
	// 1. rule deny (terminal) — CC 1a/1d alignment: an explicit deny rule is
	// bypass-immune. Reordered ahead of bypass 2026-11-02 (BREAKING: bypass
	// used to approve even deny-ruled calls); for the other three modes this
	// step was already the first reachable branch, so their order is unchanged.
	if (f.verdict.behavior === "deny") {
		return {
			kind: "deny",
			reason: `Denied by permission rule [${f.verdict.source}]: ${f.verdict.rule}`,
		};
	}

	// 1b. bash path-target deny extension (W4, 2026-11-07): a Read/Edit deny
	// rule covers bash path-taking commands too — when the command's
	// redirection / write-command argument targets a denied path, the whole
	// command denies, in every mode (bypass-immune like step 1, CC parity for
	// `cat .env` against Read(./.env) deny rules). The adapter pre-computed
	// the full deny reason (rule text + source); null when disabled
	// (PI_CORE_BASH_PATH_CHECKS) or nothing matched.
	if (f.bashDenyRule) {
		return { kind: "deny", reason: f.bashDenyRule };
	}

	// 2. bypass — CC alignment (permissions.ts 1f/1g → 2a): explicit ask
	// rules and sensitive-path checks are bypass-immune and still prompt;
	// everything else auto-approves. Outside-write tracking stays an allow
	// effect.
	if (f.mode === "bypass") {
		// 1f: a user-configured ask rule is respected even in bypass mode.
		// W1 (2026-11-07): a rule family's synthesized default-ask verdict
		// (first-seen MCP tool, web-gov non-preapproved domain) is NOT a
		// user-configured ask rule — bypass auto-approves it, matching CC
		// bypassPermissions which only prompts for explicit ask rules. A
		// family ask still prompts when an explicit ask rule governs the
		// canonical id (hasExplicitAskRule); non-family ask verdicts always
		// come from the real rule loop (unknown tools only get non-passthrough
		// verdicts through families or that loop).
		if (f.verdict.behavior === "ask" && (f.family === null || f.family.hasExplicitAskRule)) {
			return {
				kind: "prompt",
				flavor: "permission-options",
				label: `permission rule requires approval: ${f.verdict.rule}`,
				category: "permission-ask",
			};
		}
		// 1g: safety checks on edit/write paths (.git/, shell configs, ...) are
		// bypass-immune, exactly like CC's checkPathSafetyForAutoEdit (edit tools
		// only). W2 (2026-11-07): the bypass path set is the CC-parity
		// isCcSafetyPath superset (DANGEROUS_FILES/DIRECTORIES ∪ pi extras),
		// wider than the narrow pathSensitive used by the other modes' gates.
		// NOTE: CC has NO bash sensitive-path scan in bypass — its bash danger
		// checks live in the auto/yolo classifier, which bypass skips — so a
		// bash command referencing sensitive paths auto-approves here too
		// (2026-11-03 fix: the previous bash commandSensitive branch was an
		// over-reach that broke `ssh -F ~/.ssh/config`-style workflows). The
		// bash write-target check (W3) covers redirection/argument targets
		// separately below.
		if ((f.tool === "edit" || f.tool === "write") && f.pathCcSafety) {
			return {
				kind: "prompt",
				flavor: "permission-options",
				label: `sensitive path "${f.path}"`,
				category: "sensitive-path",
			};
		}
		// W3 (2026-11-07): bash write-target safety check (bypass-only, CC
		// BashTool pathValidation parity): a redirection or write-command
		// argument targeting a CC-sensitive path prompts. Gated upstream by
		// PI_CORE_BASH_PATH_CHECKS (facts carry null when disabled); fails
		// open — an unparseable command carries no targets and allows.
		if (f.bashPathCheck) {
			return {
				kind: "prompt",
				flavor: "permission-options",
				label: `bash writes sensitive path "${f.bashPathCheck.path}"`,
				category: "sensitive-path",
			};
		}
		const effects: AllowEffects = {};
		if (f.tool === "edit" || f.tool === "write") effects.trackOutsideWrite = true;
		return { kind: "allow", effects };
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

		// META-03: retrieval-only meta tool passes like the read tier. The
		// old gate returned undefined DIRECTLY here (not via allowToolCall)
		// — no denial-state reset, review fix P2-1.
		if (f.tool === "tool_search") {
			return { kind: "allow", effects: {} };
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
