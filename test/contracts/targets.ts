/**
 * Contract-suite targets registry.
 *
 * The contract tests import the system-under-test ONLY through this file.
 * P0 pointed at the four source packages; P1 switched modes and effort to
 * the core modules (P1-PM-03 / P1-EF-04) with assertion files unchanged.
 * goal/review follow at P2.
 *
 * Source packages are imported read-only from their original directories;
 * nothing in this repo may modify them.
 */
// goal 0.6.0 was authored against pi 0.74 types; two spots drift against
// 0.85.1 (goal-auditor.ts:142 ResourceLoader members, :206 modelRegistry in
// CreateAgentSessionOptions). Runtime is green under 0.85.1. Type-check of
// this directory is handled by scripts/check.mjs with an auto-expiring
// allowlist for exactly those two lines — removed when the P2 fork fixes
// them. See DEVIATIONS.md.
import goalFactory from "../../../pi-goal/extensions/goal.ts";
import reviewFactory from "../../../pi-review/index.ts";
import modesFactory from "../../extensions/modes/index.ts";
import effortFactory from "../../extensions/effort/index.ts";

export type TargetFactory = (pi: never) => unknown;

export interface ContractTarget {
	label: string;
	factory: TargetFactory;
}

export const targets: Record<"modes" | "effort" | "goal" | "review", ContractTarget> = {
	// core module since P1 (was @georgedong32/permission-modes@2.8.0)
	modes: { label: "core/modes (from permission-modes 2.8.0)", factory: modesFactory as TargetFactory },
	// core module since P1 (was @georgedong32/pi-effort@0.1.2)
	effort: { label: "core/effort (from pi-effort 0.1.2)", factory: effortFactory as TargetFactory },
	// P2: swap for core extensions/goal entry
	goal: { label: "@capyup/pi-goal@0.6.0", factory: goalFactory as TargetFactory },
	// P2: swap for core extensions/review entry
	review: { label: "@georgedong32/pi-review@0.8.6", factory: reviewFactory as TargetFactory },
};
