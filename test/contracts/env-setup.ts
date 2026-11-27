/**
 * Contract assertions model PARENT-session semantics. Running the suite from
 * inside a subagent inherits PI_SUBAGENT_CHILD / PI_SUBAGENT_PARENT_SESSION /
 * PERMISSION_MODES_INHERITED_MODE from the environment and false-reds
 * P0-CT-03/04; strip them before any test file loads. Tests that need child
 * semantics set them explicitly.
 */
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_PARENT_SESSION;
delete process.env.PERMISSION_MODES_INHERITED_MODE;
