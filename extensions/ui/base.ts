/**
 * UI adapter base (DECOUPLE-PLAN §4.2, frozen at DC2).
 *
 * The single presentation interface both adapters satisfy: cctui (primary)
 * and core's own thin fallback. Business modules never touch ctx.ui for
 * *presentation* — they publish state and an adapter renders it.
 *
 * Interface shape (do not grow casually — every method is a fact callers
 * must learn):
 *   - startup()/shutdown(): adapter lifecycle (mount/unmount its widgets).
 *   - onSnapshot(s): push of the frozen bus snapshot. Two duties: render
 *     persistent state; diff `notifications` (bounded tail queue, §4.1)
 *     by lastSeenId. Rendering must be idempotent.
 *
 * Interaction surfaces (select/editor/onTerminalInput) are NOT here — they
 * stay behind per-module ui wrappers (e.g. effort/ui) so logic flows can
 * await them against a fake.
 */
import type { CoreSnapshot } from "../bus.js";

export interface UiAdapter {
	startup(): void;
	shutdown(): void;
	onSnapshot(snapshot: CoreSnapshot): void;
}

/** Print/RPC mode and unit tests: consume nothing, break nothing. */
export function createNoopAdapter(): UiAdapter {
	return {
		startup() {},
		shutdown() {},
		onSnapshot(_snapshot: CoreSnapshot) {},
	};
}
