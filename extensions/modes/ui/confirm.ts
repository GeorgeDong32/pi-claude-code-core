/**
 * Ask/permission confirmation prompts (DECOUPLE-PLAN DC3).
 *
 * The one interaction surface modes owns: awaiting a user choice. Kept as
 * a thin wrapper so logic flows can be faked at a single point instead of
 * scattering ctx.ui.select across permission checks.
 */
export interface ConfirmCtx {
	ui: {
		select(title: string, options: readonly string[]): Promise<string | undefined>;
	};
}

/** Await an explicit choice; undefined = dismissed. */
export function confirmChoice(ctx: ConfirmCtx, title: string, options: readonly string[]): Promise<string | undefined> {
	return ctx.ui.select(title, options);
}
