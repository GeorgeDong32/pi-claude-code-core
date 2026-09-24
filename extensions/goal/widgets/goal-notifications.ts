export function buildGoalRunningNotification(args: { objective: string; sisyphus: boolean; autoContinue: boolean }): string {
	// One-line ack; the goal widget above the editor carries the live
	// status/objective block, so the notification must not duplicate it.
	const noun = args.sisyphus ? "Sisyphus goal" : "Goal";
	const drive = args.autoContinue ? "auto-continue on" : "manual mode";
	return `${noun} set · ${drive}`;
}
