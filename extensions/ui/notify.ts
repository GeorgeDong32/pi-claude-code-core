/**
 * Notification tail queue (DECOUPLE-PLAN §4.1, landed at DC3).
 *
 * Transient user-facing notices flow as a bounded tail queue inside the bus
 * snapshot: monotonic ids, newest last, cap 20 (old items are pushed out,
 * never consumed/deleted). Adapters diff by lastSeenId; render is naturally
 * idempotent. No ACK, no clear command — the frozen "no functions" snapshot
 * invariant is untouched.
 *
 * Until DC5 wires adapters, notify() ALSO forwards to ctx.ui.notify (dual
 * write) so on-screen behaviour is unchanged; the direct forward is removed
 * when adapters own rendering.
 */
import { coreBus, type CoreBus } from "../bus.js";

export type NotificationLevel = "info" | "warning" | "error";

export interface NotificationItem {
	id: number;
	level: NotificationLevel;
	msg: string;
}

const CAP = 20;

/** Append to the tail queue (pure data publish; single-threaded atomicity). */
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

/** Presenter-facing notify: tail queue + direct ctx.ui forward (until DC5). */
export function notify(
	ctx: { hasUI?: boolean; ui?: { notify(message: string, level: NotificationLevel): void } },
	msg: string,
	level: NotificationLevel = "info",
): void {
	publishNotification(level, msg);
	if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(msg, level);
}
