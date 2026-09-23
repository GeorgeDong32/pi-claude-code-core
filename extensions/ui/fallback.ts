/**
 * Fallback UI adapter (DECOUPLE-PLAN DC5, §4.3 option C).
 *
 * The thin default renderer for "core without cctui": it owns the working
 * message line and yields to a live CC-TUI by reading the presence key
 * BEFORE any write — the poll-point self-heals (a stale key is re-read on
 * every snapshot), there is no arbiter to race, and pi's single thread
 * leaves no double-render window. Core business code never reads the key;
 * this adapter is UI-layer, so "core senses UI" stays false.
 *
 * Not here (deliberately): the modes footer (modes/ui/footer.ts already
 * reads the key at its own install point — same semantics, co-located)
 * and the notification tail queue (consumed after the direct-forward
 * window closes; see spec deviation note).
 */
import type { CoreSnapshot } from "../bus.js";
import type { UiAdapter } from "./base.ts";

export interface FallbackHost {
	hasUI: boolean;
	setWorkingMessage(message?: string): void;
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
	return {
		startup() {},
		shutdown() {
			lastStats = null;
			if (host.hasUI) host.setWorkingMessage(undefined);
		},
		onSnapshot(snapshot: CoreSnapshot) {
			if (!host.hasUI) return;
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
		},
	};
}
