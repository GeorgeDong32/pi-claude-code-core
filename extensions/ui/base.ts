import type { CoreSnapshot } from "../bus.js";

export interface UiAdapter {
	startup(): void;
	shutdown(): void;
	onSnapshot(snapshot: CoreSnapshot): void;
}

export function createNoopAdapter(): UiAdapter {
	return {
		startup() {},
		shutdown() {},
		onSnapshot(_snapshot: CoreSnapshot) {},
	};
}
