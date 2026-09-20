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

type ModuleFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** Ordered assembly line. Each phase appends its module factory here. */
const moduleFactories: ModuleFactory[] = [
	// P1: modesExtension,
	// P1: effortExtension,
	// P2: goalExtension,
	// P2: reviewExtension,
	// P3: createRulesExtension(),
	// P3: memoryExtension,
	// P4: mcpGovExtension,
	// P4: webGovExtension,
];

export default async function coreExtension(pi: ExtensionAPI): Promise<void> {
	for (const factory of moduleFactories) {
		await factory(pi);
	}
}
