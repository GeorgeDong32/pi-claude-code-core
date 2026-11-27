// Ported from NVlabs/SoL-Pi (MIT) @ src/sol-pi/extensions/observation-pack/ledger.ts.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type Ledger = (entry: Record<string, unknown>) => Promise<void>;

export function createLedger(path: string): Ledger {
	let dirEnsured = false;
	return async (entry) => {
		const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
		if (!dirEnsured) {
			await mkdir(dirname(path), { recursive: true });
			dirEnsured = true;
		}
		try {
			await appendFile(path, line, "utf8");
		} catch (error) {
			if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, line, "utf8");
		}
	};
}
