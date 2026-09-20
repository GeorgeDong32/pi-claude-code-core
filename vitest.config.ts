import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// Unit tests + migrated modes suite. Contracts live in test/contracts
		// and run via `bun run contracts` (P0-CT-11) — same vitest, separate
		// entry so the two suites can be run independently.
		include: ["test/lib/**/*.test.ts", "extensions/modes/**/*.test.ts"],
	},
});
