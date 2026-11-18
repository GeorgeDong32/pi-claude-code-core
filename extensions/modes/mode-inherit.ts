
import {
	isSubagentChildProcess,
	SUBAGENT_CHILD_ENV,
} from "./permission-forwarding.ts";

export const PERMISSION_MODES_INHERITED_MODE_ENV =
	"PERMISSION_MODES_INHERITED_MODE";

export const INHERITABLE_MODES = [
	"ask",
	"plan",
	"auto",
	"bypass",
] as const;

export type InheritableMode = (typeof INHERITABLE_MODES)[number];

export function isInheritableMode(value: string): value is InheritableMode {
	return (INHERITABLE_MODES as readonly string[]).includes(value);
}

export function publishInheritedPermissionMode(mode: string): void {
	if (isSubagentChildProcess()) return;
	if (!isInheritableMode(mode)) return;
	process.env[PERMISSION_MODES_INHERITED_MODE_ENV] = mode;
}

export function resolveInheritedPermissionMode(): InheritableMode | undefined {
	const raw = process.env[PERMISSION_MODES_INHERITED_MODE_ENV]?.trim();
	if (!raw || !isInheritableMode(raw)) return undefined;
	return raw;
}

export function applyInheritedModeForChild(): InheritableMode | undefined {
	if (!isSubagentChildProcess()) return undefined;
	return resolveInheritedPermissionMode();
}

export { SUBAGENT_CHILD_ENV };
