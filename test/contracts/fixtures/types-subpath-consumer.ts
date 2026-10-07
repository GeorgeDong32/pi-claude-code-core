/**
 * D4-READER-REMOVE (B7) type-only consumer fixture — compiled by an EXTERNAL
 * tsconfig invocation in test/contracts/types-subpath.test.ts (and once more
 * by the repo's own check gates), proving the `./types` package subpath still
 * serves type declarations to a real TypeScript consumer after the runtime
 * reader withdrawal. Deliberately imports NOTHING else — an external
 * consumer has none of this repo's tsconfig paths.
 */
import type { CoreSnapshot, CoreCommand, CoreCommandResult } from "@georgedong32/pi-claude-code-core/types";

export type ConsumerBundle = {
	snapshot: CoreSnapshot;
	command: CoreCommand;
	result: CoreCommandResult;
};

// Exercise the imported types so the import is live, not dead weight.
export function describeSnapshot(snapshot: CoreSnapshot): string {
	const command: CoreCommand = { kind: "setMode", mode: snapshot.modes.mode };
	const result: CoreCommandResult = { ok: command.kind === "setMode" };
	return `${result.ok}:${snapshot.version}`;
}
