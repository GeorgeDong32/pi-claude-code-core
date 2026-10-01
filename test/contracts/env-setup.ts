/**
 * Contract-suite env setup (adversarial review F1, 2026-10-01): contract
 * assertions model PARENT-session semantics. Running `bun run contracts` from
 * inside a subagent (ambient PI_SUBAGENT_CHILD / PI_SUBAGENT_PARENT_SESSION /
 * PERMISSION_MODES_INHERITED_MODE injected by pi-subagents) false-reds
 * P0-CT-03/04. Strip the session-coupling vars before any test file loads;
 * tests that need child semantics set them explicitly.
 */
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_PARENT_SESSION;
delete process.env.PERMISSION_MODES_INHERITED_MODE;
