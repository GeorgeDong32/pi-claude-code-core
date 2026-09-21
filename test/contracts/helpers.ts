/**
 * Shared setup for contract tests: redirect pm's config paths to a tmp dir
 * (so the suite never reads or writes the real `~/.pi/agent` state) and
 * instantiate a target into a fresh FakeHost.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setConfigPath } from "../../extensions/modes/config.ts";
import { setModelsPath } from "../../extensions/modes/profiles.ts";
import { setAgentDirForTests } from "../../extensions/modes/permission-forwarding.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import { FakeHost } from "./fake-host.ts";
import { targets, type ContractTarget } from "./targets.ts";

export interface SetupResult {
	host: FakeHost;
	cwd: string;
	tmp: string;
}

/**
 * Instantiate the given target with pm's on-disk config redirected into a
 * fresh tmp dir. `cwd` is a fresh empty dir (safe as a project root).
 */
export function setupTarget(target: ContractTarget, redirectPmConfig = true): SetupResult {
	const tmp = mkdtempSync(join(tmpdir(), "core-ct-"));
	// fresh bus snapshot per instance (the shared singleton otherwise leaks
	// channels across contract cases)
	resetCoreBusForTests();
	if (redirectPmConfig) {
		setConfigPath(join(tmp, "permission-modes.json"));
		writeFileSync(
			join(tmp, "permission-modes.json"),
			JSON.stringify({ classifier: { enabled: false } }),
		);
		setModelsPath(join(tmp, "model-profiles.json"));
		setAgentDirForTests(tmp);
	}
	const host = new FakeHost();
	target.factory(host.asPi());
	return { host, cwd: tmp, tmp };
}

export function setupModes(): SetupResult {
	return setupTarget(targets.modes);
}
