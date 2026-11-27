import { coreBus, type CoreBus } from "../bus.js";

export type NotificationLevel = "info" | "warning" | "error";

export interface NotificationItem {
	id: number;
	level: NotificationLevel;
	msg: string;
}

const CAP = 20;

function ccTuiLive(): boolean {
	const g = globalThis as Record<string, unknown>;
	return (g.__piCcTui as { active?: boolean } | undefined)?.active === true || g.__ccTuiActive === true;
}

function ccTuiNotificationsConsumer(): boolean {
	const g = globalThis as Record<string, unknown>;
	return (
		(g.__piCcTui as { notificationsConsumer?: boolean } | undefined)?.notificationsConsumer === true
	);
}

export function publishNotification(
	level: NotificationLevel,
	msg: string,
	bus: CoreBus = coreBus(),
): void {
	const current = bus.snapshot().notifications ?? [];
	const id = current.length > 0 ? current[current.length - 1]!.id + 1 : 1;
	const next = [...current, { id, level, msg }];
	bus.publish({ notifications: next.slice(-CAP) });
}

export function notify(
	ctx: { hasUI?: boolean; ui?: { notify(message: string, level: NotificationLevel): void } },
	msg: string,
	level: NotificationLevel = "info",
): void {
	publishNotification(level, msg);
	if (ccTuiLive() && !ccTuiNotificationsConsumer() && ctx?.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(msg, level);
	}
}
