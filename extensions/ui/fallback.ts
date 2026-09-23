/**
 * Fallback UI adapter (DECOUPLE-PLAN DC5, §4.3 option C; DC5b consumer).
 *
 * The thin default renderer for "core without cctui". It owns the working
 * message line AND the notification tail-queue display, yielding to a live
 * CC-TUI by reading the presence key BEFORE any write — the poll-point
 * self-heals (a stale key is re-read on every snapshot), there is no
 * arbiter to race, and pi's single thread leaves no double-render window.
 * Core business code never reads the key; this adapter is UI-layer, so
 * "core senses UI" stays false.
 *
 * startup() subscribes through the v2 snapshot's data-carried onChange —
 * this adapter is that field's first real consumer. While a cctui is
 * live it yields everything (cctui renders); notifications then flow to
 * cctui via ui/notify's direct forward until cctui ships its own
 * tail-queue consumer (DC5b second half, version-gated).
 *
 * Not here (deliberately): the modes footer (modes/ui/footer.ts already
 * reads the key at its own install point — same semantics, co-located).
 */
import { coreBus, type CoreSnapshot } from "../bus.js";
import type { UiAdapter } from "./base.ts";
import type { NotificationLevel } from "./notify.ts";

export interface FallbackHost {
	hasUI: boolean;
	setWorkingMessage(message?: string): void;
	/** Optional: hosts without a notify surface skip queue display safely. */
	notify?(message: string, level: NotificationLevel): void;
	theme: { fg(role: string, s: string): string };
}

interface PresenceKey {
	active?: boolean;
}

function ccTuiLive(): boolean {
	const g = globalThis as Record<string, unknown>;
	return (g.__piCcTui as PresenceKey | undefined)?.active === true || g.__ccTuiActive === true;
}

export function createFallbackAdapter(host: FallbackHost): UiAdapter {
	let lastStats: string | null = null;
	let lastSeenNotificationId = 0;
	let unsubscribe: (() => void) | null = null;

	function apply(snapshot: CoreSnapshot): void {
		if (!host.hasUI) return;
		// Notification tail queue (§4.1): diff by lastSeenId — idempotent.
		const queue = snapshot.notifications;
		if (queue && queue.length > 0 && !ccTuiLive()) {
			for (const item of queue) {
				if (item.id <= lastSeenNotificationId) continue;
				lastSeenNotificationId = item.id;
				host.notify?.(item.msg, item.level);
			}
		} else if (queue && queue.length > 0) {
			// A live cctui owns notifications (via notify's direct forward);
			// just advance the cursor so a later yield does not replay history.
			lastSeenNotificationId = queue[queue.length - 1]!.id;
		}
		const stats = snapshot.modes.workingStats;
		if (stats === lastStats) return; // idempotent render
		lastStats = stats;
		if (stats === null) {
			host.setWorkingMessage(undefined);
			return;
		}
		// Yield check at the write point: a live cctui owns the line.
		if (ccTuiLive()) return;
		host.setWorkingMessage(host.theme.fg("dim", `Working… (${stats})`));
	}

	return {
		startup() {
			// v2 data-carried subscription point: publish now pushes snapshots.
			// A fresh bus still holds the v1 initial snapshot (no onChange
			// field) — an empty patch publish upgrades it harmlessly.
			let register = coreBus().snapshot().onChange;
			if (!register) {
				coreBus().publish({});
				register = coreBus().snapshot().onChange;
			}
			if (register) unsubscribe = register(() => apply(coreBus().snapshot()));
		},
		shutdown() {
			unsubscribe?.();
			unsubscribe = null;
			lastStats = null;
			lastSeenNotificationId = 0;
			if (host.hasUI) host.setWorkingMessage(undefined);
		},
		onSnapshot: apply,
	};
}
