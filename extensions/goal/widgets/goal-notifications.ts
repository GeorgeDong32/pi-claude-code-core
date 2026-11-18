export function buildGoalRunningNotification(args: { objective: string; sisyphus: boolean; autoContinue: boolean }): string {
	const noun = args.sisyphus ? "Sisyphus goal" : "Goal";
	const drive = args.autoContinue ? "auto-continue on" : "manual mode";
	return `${noun} set · ${drive}`;
}
