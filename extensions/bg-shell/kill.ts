// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT). Copyright (c) 2026 Gage Vander Clay.
import { processPort } from "./port.ts";

export const GRACE_MS = 3000;
const AFTER_KILL_MS = 1000;
const STEP_MS = 100;

function graceMs(): number {
	const set = Number(process.env.CC_CORE_BG_GRACE_MS);
	return Number.isFinite(set) && set > 0 ? set : GRACE_MS;
}

export type GroupKill = "gone" | "stopped" | "stuck";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitGone(pid: number, ms: number): Promise<boolean> {
	for (let waited = 0; waited < ms; waited += STEP_MS) {
		await sleep(STEP_MS);
		if (!processPort().groupAlive(pid)) return true;
	}
	return false;
}

export async function killGroup(pid: number): Promise<GroupKill> {
	if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to signal process group ${pid}`);
	const port = processPort();
	if (!port.signalGroup(pid, "SIGTERM")) return "gone";
	if (await waitGone(pid, graceMs())) return "stopped";
	port.signalGroup(pid, "SIGKILL");
	return (await waitGone(pid, AFTER_KILL_MS)) ? "stopped" : "stuck";
}

export async function killGroupNow(pid: number): Promise<GroupKill> {
	if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to signal process group ${pid}`);
	if (!processPort().signalGroup(pid, "SIGKILL")) return "gone";
	return (await waitGone(pid, AFTER_KILL_MS)) ? "stopped" : "stuck";
}
