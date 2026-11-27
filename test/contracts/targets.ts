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
	modes: { label: "core/modes (from permission-modes 2.8.0)", factory: modesFactory as TargetFactory },
	effort: { label: "core/effort (from pi-effort 0.1.2)", factory: effortFactory as TargetFactory },
	goal: { label: "core/goal (fork of capyup/pi-goal 0.6.0)", factory: goalFactory as TargetFactory },
	review: { label: "core/review (from pi-review 0.8.6)", factory: reviewFactory as TargetFactory },
	"action-fusion": { label: "core/action-fusion (from NVlabs/SoL-Pi, MIT)", factory: fusionFactory() as TargetFactory },
	"observation-pack": { label: "core/observation-pack (from NVlabs/SoL-Pi, MIT)", factory: observationFactory() as TargetFactory },
};
