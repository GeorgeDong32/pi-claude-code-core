import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initCoreBus } from "./bus.ts";
import permissionModesExtension from "./modes/index.ts";
import effortExtension from "./effort/index.ts";
import goalExtension from "./goal/goal.ts";
import reviewExtension from "./review/index.ts";
import { createRulesExtension } from "./rules/index.ts";
import protectedWritesExtension from "./modes/protected-writes.ts";
import notesIndexExtension from "./notes-index/index.ts";
import sessionRecallExtension from "./session-recall/index.ts";
import compactionController from "./compaction/index.ts";
import mcpGovExtension from "./mcp-gov/index.ts";
import bgShell from "./bg-shell/index.ts";
import { createWebRuleFamily } from "./web-gov/index.ts";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { loadCoreEconomy } from "../lib/core-economy.ts";
import createActionFusion from "./action-fusion/index.ts";
import observationPack from "./observation-pack/index.ts";
import { registerCcPanels } from "./ui/cc-panels.ts";

type ModuleFactory = (pi: ExtensionAPI) => void | Promise<void>;

const moduleFactories: ModuleFactory[] = [
	function busExtension() {
		initCoreBus();
	},
	permissionModesExtension,
	effortExtension,
	goalExtension,
	reviewExtension,
	createRulesExtension(),
	protectedWritesExtension,
	notesIndexExtension,
	sessionRecallExtension,
	function webGov() {
		createWebRuleFamily();
	},
	mcpGovExtension,
	bgShell,
	compactionController,
	function ccPanels(pi: ExtensionAPI) {
		registerCcPanels(pi);
	},
	function economy(pi: ExtensionAPI) {
		const config = loadCoreEconomy();
		if (config.actionFusion) createActionFusion({ version: PI_VERSION })(pi);
		if (config.observationPack) observationPack({ version: PI_VERSION })(pi);
	},
];

export default async function coreExtension(pi: ExtensionAPI): Promise<void> {
	for (const factory of moduleFactories) {
		await factory(pi);
	}
}
