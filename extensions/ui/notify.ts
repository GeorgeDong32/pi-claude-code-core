/**
 * Notification tail queue (DECOUPLE-PLAN §4.1, landed at DC3; DC5b: the
 * no-cctui path now flows through the fallback adapter's onChange
 * consumer — the direct forward below is the LAST cctui-facing leg and
 * stays until cctui ships its own tail-queue consumer (version-gated).
 *
 * Transient user-facing notices flow as a bounded tail queue inside the
 * bus snapshot: monotonic ids, newest last, cap 20 (old items are pushed
 * out, never consumed/deleted). Adapters diff by lastSeenId; render is
 * naturally idempotent. No ACK, no clear command — the frozen "no
 * functions" snapshot invariant is untouched.
 */
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
