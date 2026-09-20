import { defineConfig } from "vitest/config";

// Contract suite entry (P0-CT-11): `bun run contracts` only.
// Kept separate from vitest.config.ts so unit tests and contracts run
// independently; assertions import targets through test/contracts/targets.ts.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/contracts/**/*.test.ts"],
	},
});
