/**
 * pi-claude-code-core — extension assembly entry.
 *
 * pi loads ONE factory per manifest entry (loader requires a callable default
 * export), so this module default-exports a single assembly function that
 * invokes each module factory with the same ExtensionAPI instance.
 *
 * Module slots (filled by later phases; P0 ships an empty shell):
 *   - modes    (P1, from @georgedong32/permission-modes 2.8.0)
 *   - effort   (P1, from @georgedong32/pi-effort 0.1.2)
 *   - goal     (P2, forked from capyup/pi-goal 0.6.0)
 *   - review   (P2, from @georgedong32/pi-review 0.8.6)
 *   - rules    (P3, new)
 *   - memory   (P3, new)
 *   - mcp-gov  (P4, new)
 *   - web-gov  (P4, new)
 *
 * The capability bus (`globalThis.__piClaudeCodeCore`) is published from this
 * assembly point starting in P1 (P1-BUS-01).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initCoreBus } from "./bus.ts";
// P1: migrated from @georgedong32/permission-modes 2.8.0 / pi-effort 0.1.2
import permissionModesExtension from "./modes/index.ts";
import effortExtension from "./effort/index.ts";
// P2: forked from capyup/pi-goal (@ ec2bcbe) / merged from pi-review 0.8.6
import goalExtension from "./goal/goal.ts";
import reviewExtension from "./review/index.ts";
// P3: new modules
import { createRulesExtension } from "./rules/index.ts";
import memoryExtension from "./memory/index.ts";
// P4: governance modules (rule families + broker mirror + /core panel)
import mcpGovExtension from "./mcp-gov/index.ts";
import { createWebRuleFamily } from "./web-gov/index.ts";
// Economy modules (SPEC 2026-09-29-solpi-absorption): ported from NVlabs/SoL-Pi
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { loadCoreEconomy } from "../lib/core-economy.ts";
import createActionFusion from "./action-fusion/index.ts";
import observationPack from "./observation-pack/index.ts";

type ModuleFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** Ordered assembly line. Each phase appends its module factory here. */
const moduleFactories: ModuleFactory[] = [
	// capability bus first (P1-BUS): modules publish through it
	function busExtension() {
		initCoreBus();
	},
	permissionModesExtension,
	effortExtension,
	goalExtension,
	reviewExtension,
	createRulesExtension(),
	memoryExtension,
	function webGov() {
		// P4-WB: registered BEFORE mcp so domain rules (webfetch(domain:…))
		// take precedence over mcp-prefix rules for URL-carrying calls
		// (P4-WB-01); non-URL mcp tools fall through to the mcp family
		createWebRuleFamily();
	},
	mcpGovExtension,
	// SPEC ASM-01: economy modules last — observation-pack must own the FINAL
	// context projection slot (after modes/memory handlers), action-fusion's
	// registration order is position-independent but fixed here too.
	function economy(pi: ExtensionAPI) {
		const config = loadCoreEconomy();
		// B4: the host version is threaded through factory options — the
		// economy factories no longer reach for the pi import themselves on
		// the probe path (self-disable is now pinnable end-to-end in tests).
		if (config.actionFusion) createActionFusion({ version: PI_VERSION })(pi);
		if (config.observationPack) observationPack({ version: PI_VERSION })(pi);
	},
];

export default async function coreExtension(pi: ExtensionAPI): Promise<void> {
	for (const factory of moduleFactories) {
		await factory(pi);
	}
}
