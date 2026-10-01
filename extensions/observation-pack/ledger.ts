/*
 * Append-only JSONL record of what the mechanism did on each provider request.
 * Ported from NVlabs/SoL-Pi (MIT) @ src/sol-pi/extensions/observation-pack/ledger.ts.
 * Write-only audit trail — nothing reads it back at runtime (B2 note: it is
 * NOT the sentinel's data source; the sentinel reads the in-memory send
 * counts. The ledger exists for post-hoc diagnosis of silent failures).
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
