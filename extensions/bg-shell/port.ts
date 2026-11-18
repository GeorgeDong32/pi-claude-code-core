// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT). Copyright (c) 2026 Gage Vander Clay.
import { type LaunchOptions, launch } from "./launch.ts";

export type ProcessPort = {
	launch(options: LaunchOptions): Promise<number>;
	signalGroup(pid: number, signal: NodeJS.Signals): boolean;
	groupAlive(pid: number): boolean;
	pidAlive(pid: number): boolean;
};

function reached(send: () => void): boolean {
	try {
		send();
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH" || code === "EPERM") return false;
		throw error;
	}
}

export const realPort: ProcessPort = {
	launch,
	signalGroup: (pid, signal) => reached(() => process.kill(-pid, signal)),
	groupAlive: (pid) => reached(() => process.kill(-pid, 0)),
	pidAlive: (pid) => reached(() => process.kill(pid, 0)),
};

let current: ProcessPort = realPort;

export function processPort(): ProcessPort {
	return current;
}

export function setProcessPort(port: ProcessPort): void {
	current = port;
}
