/**
 * Contract-suite targets registry (P0).
 *
 * The contract tests import the system-under-test ONLY through this file.
 * P0 points at the four source packages; P1 onward the entries are switched
 * to core modules one by one — the assertions in the *.test.ts files stay
 * byte-identical across that switch (P1-PM-03, P2 equivalents).
 *
 * Source packages are imported read-only from their original directories;
 * nothing in this repo may modify them.
 */
import pmFactory from "../../../pi-permission-modes/index.ts";
import effortFactory from "../../../pi-effort/index.ts";
// goal 0.6.0 was authored against pi 0.74 types; two spots drift against
// 0.85.1 (goal-auditor.ts:142 ResourceLoader members, :206 modelRegistry in
// CreateAgentSessionOptions). Runtime is green under 0.85.1. Type-check of
// this directory is handled by scripts/check.mjs with an auto-expiring
// allowlist for exactly those two lines — removed when the P2 fork fixes
// them. See DEVIATIONS.md.
import goalFactory from "../../../pi-goal/extensions/goal.ts";
import reviewFactory from "../../../pi-review/index.ts";

export type TargetFactory = (pi: never) => unknown;

export interface ContractTarget {
	label: string;
	factory: TargetFactory;
}

export const targets: Record<"modes" | "effort" | "goal" | "review", ContractTarget> = {
	// P1: swap for `../..` core extensions/modes entry
	modes: { label: "@georgedong32/permission-modes@2.8.0", factory: pmFactory as TargetFactory },
	// P1: swap for core extensions/effort entry
	effort: { label: "@georgedong32/pi-effort@0.1.2", factory: effortFactory as TargetFactory },
	// P2: swap for core extensions/goal entry
	goal: { label: "@capyup/pi-goal@0.6.0", factory: goalFactory as TargetFactory },
	// P2: swap for core extensions/review entry
	review: { label: "@georgedong32/pi-review@0.8.6", factory: reviewFactory as TargetFactory },
};
