/** P0-SK-05 spike ① — total reader implementation shipped as plain .js. */

const DEFAULT_STATUS = Object.freeze({
	version: 1,
	modes: Object.freeze({ mode: "", workingStats: null }),
});

function isRecord(v) {
	return typeof v === "object" && v !== null;
}

export function readCoreStatus(g) {
	try {
		const holder = isRecord(g) ? g : globalThis;
		const fresh = holder.__miniCore;
		if (isRecord(fresh) && typeof fresh.version === "number" && fresh.version >= 1) {
			const modes = isRecord(fresh.modes) ? fresh.modes : {};
			return {
				version: fresh.version,
				modes: {
					mode: typeof modes.mode === "string" ? modes.mode : "",
					workingStats: typeof modes.workingStats === "string" ? modes.workingStats : null,
				},
			};
		}
		// Legacy fallback key, then defaults.
		const legacy = holder.__miniLegacy;
		if (isRecord(legacy) && typeof legacy.mode === "string") {
			return { version: 1, modes: { mode: legacy.mode, workingStats: null } };
		}
		return DEFAULT_STATUS;
	} catch {
		return DEFAULT_STATUS;
	}
}
