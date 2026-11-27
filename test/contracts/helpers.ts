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

export function setupTarget(target: ContractTarget, redirectPmConfig = true): SetupResult {
	const tmp = mkdtempSync(join(tmpdir(), "core-ct-"));
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
