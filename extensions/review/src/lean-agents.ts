
export const LEAN_AGENT_PACKAGE = "pi-review";

export function leanAgentName(reviewerId: string): string {
	return `${LEAN_AGENT_PACKAGE}.${reviewerId}`;
}

export const LEAN_GATE_AGENT = leanAgentName("gate");

export interface ToolBudgetSpec {
	soft: number;
	hard: number;
}

export interface LeanBudgetSpec {
	turnBudget: { maxTurns: number; graceTurns: number };
	defaultToolBudget: ToolBudgetSpec;
	historyToolBudget: ToolBudgetSpec;
	gateTurnBudget: { maxTurns: number; graceTurns: number };
	gateToolBudget: ToolBudgetSpec;
	timeoutMs: number;
}

export const LEAN_BUDGETS: LeanBudgetSpec = {
	turnBudget: { maxTurns: 26, graceTurns: 2 },
	defaultToolBudget: { soft: 20, hard: 32 },
	historyToolBudget: { soft: 14, hard: 24 },
	gateTurnBudget: { maxTurns: 16, graceTurns: 2 },
	gateToolBudget: { soft: 14, hard: 20 },
	timeoutMs: 1_000_000,
};

export function toolBudgetForReviewer(id: string): ToolBudgetSpec {
	if (id === "history-context") return LEAN_BUDGETS.historyToolBudget;
	return LEAN_BUDGETS.defaultToolBudget;
}

export function resolveLeanBudgets(override?: {
	turnBudget?: { maxTurns?: number; graceTurns?: number };
}): LeanBudgetSpec {
	const base = { ...LEAN_BUDGETS, turnBudget: { ...LEAN_BUDGETS.turnBudget } };
	if (override?.turnBudget?.maxTurns != null && override.turnBudget.maxTurns >= 1) {
		base.turnBudget.maxTurns = Math.min(48, Math.floor(override.turnBudget.maxTurns));
	}
	if (override?.turnBudget?.graceTurns != null && override.turnBudget.graceTurns >= 0) {
		base.turnBudget.graceTurns = Math.floor(override.turnBudget.graceTurns);
	}
	return base;
}

export function withThinkingSuffix(model: string, thinking?: string): string {
	if (!thinking || thinking === "off" || thinking === "false") return model;
	const colon = model.lastIndexOf(":");
	const known = ["minimal", "low", "medium", "high", "xhigh", "max", "min"];
	if (colon !== -1 && known.includes(model.slice(colon + 1))) {
		return `${model.slice(0, colon)}:${thinking}`;
	}
	return `${model}:${thinking}`;
}

export const FALSE_POSITIVE_GUIDANCE = [
	"Pre-existing issues on lines untouched by this change",
	"Pedantic nitpicks a senior engineer would not call out",
	"Issues a linter, typechecker, or CI would catch",
	"Generic quality (missing tests/docs) unless a project rule explicitly requires it",
	"Something that looks like a bug but is intentional given the change",
].join("; ");
