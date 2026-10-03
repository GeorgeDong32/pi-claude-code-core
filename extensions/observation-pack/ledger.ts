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
	// C1 (arch review 2026-10-03): mkdir once per path instead of on every
	// append — the audit trail stays per-event (upstream shape, accepted);
	// only the redundant directory syscall is dropped. ENOENT (dir removed
	// mid-session) re-arms the flag and retries once.
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
