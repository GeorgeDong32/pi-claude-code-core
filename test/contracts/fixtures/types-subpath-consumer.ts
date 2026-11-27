import type { CoreSnapshot, CoreCommand, CoreCommandResult } from "@georgedong32/pi-claude-code-core/types";

export type ConsumerBundle = {
	snapshot: CoreSnapshot;
	command: CoreCommand;
	result: CoreCommandResult;
};

export function describeSnapshot(snapshot: CoreSnapshot): string {
	const command: CoreCommand = { kind: "setMode", mode: snapshot.modes.mode };
	const result: CoreCommandResult = { ok: command.kind === "setMode" };
	return `${result.ok}:${snapshot.version}`;
}
