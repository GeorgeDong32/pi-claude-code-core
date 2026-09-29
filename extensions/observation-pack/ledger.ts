/*
 * Append-only JSONL record of what the mechanism did on each provider request.
 * Ported from NVlabs/SoL-Pi (MIT) @ src/sol-pi/extensions/observation-pack/ledger.ts.
 * Doubles as the request-level sentinel's data source (SPEC CMP-04).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type Ledger = (entry: Record<string, unknown>) => Promise<void>;

export function createLedger(path: string): Ledger {
	return async (entry) => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
	};
}
