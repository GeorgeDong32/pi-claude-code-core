export interface ConfirmCtx {
	ui: {
		select(title: string, options: readonly string[]): Promise<string | undefined>;
	};
}

export function confirmChoice(ctx: ConfirmCtx, title: string, options: readonly string[]): Promise<string | undefined> {
	return ctx.ui.select(title, options);
}
