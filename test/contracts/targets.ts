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
import modesFactory from "../../extensions/modes/index.ts";
import effortFactory from "../../extensions/effort/index.ts";
import goalFactory from "../../extensions/goal/goal.ts";
import reviewFactory from "../../extensions/review/index.ts";
import fusionFactory from "../../extensions/action-fusion/index.ts";
import observationFactory from "../../extensions/observation-pack/index.ts";

export type TargetFactory = (pi: never) => unknown;

export interface ContractTarget {
	label: string;
	factory: TargetFactory;
}

export const targets: Record<"modes" | "effort" | "goal" | "review" | "action-fusion" | "observation-pack", ContractTarget> = {
	// core module since P1 (was @georgedong32/permission-modes@2.8.0)
	modes: { label: "core/modes (from permission-modes 2.8.0)", factory: modesFactory as TargetFactory },
	// core module since P1 (was @georgedong32/pi-effort@0.1.2)
	effort: { label: "core/effort (from pi-effort 0.1.2)", factory: effortFactory as TargetFactory },
	// core module since P2 (fork of capyup/pi-goal @ ec2bcbe, was 0.6.0)
	goal: { label: "core/goal (fork of capyup/pi-goal 0.6.0)", factory: goalFactory as TargetFactory },
	// core module since P2 (was @georgedong32/pi-review@0.8.6)
	review: { label: "core/review (from pi-review 0.8.6)", factory: reviewFactory as TargetFactory },
	// core modules since the 2026-09-29 SoL-Pi absorption (MIT, SPEC 2026-09-29-solpi-absorption-spec)
	// Both default-export a factory-FACTORY (options -> factory); invoke once
	// with defaults here so `factory` is directly registrable like the others.
	"action-fusion": { label: "core/action-fusion (from NVlabs/SoL-Pi, MIT)", factory: fusionFactory() as TargetFactory },
	"observation-pack": { label: "core/observation-pack (from NVlabs/SoL-Pi, MIT)", factory: observationFactory() as TargetFactory },
};
