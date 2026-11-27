export type LengthStopVerdict = "context-clamp" | "output-limit" | "not-length";

export interface LengthStopInput {
	stopReason: string | undefined;
	usage?: { output?: number } | undefined;
	modelMaxOutputTokens?: number | undefined;
}

export function classifyLengthStop(input: LengthStopInput): LengthStopVerdict {
	if (input.stopReason !== "length") return "not-length";
	const cap = input.modelMaxOutputTokens;
	if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
		const out = input.usage?.output;
		if (typeof out === "number" && Number.isFinite(out) && out >= cap) {
			return "output-limit";
		}
	}
	return "context-clamp";
}

export interface BoundedRecoveryPolicy {
	userNotice: string | null;
	isQuota: boolean;
}

export function boundedRecoveryPolicy(verdict: LengthStopVerdict): BoundedRecoveryPolicy {
	switch (verdict) {
		case "context-clamp":
			return {
				userNotice:
					"Response truncated by context pressure — consider /compact or smaller task granularity (if replies are oddly short, check maxTokens first).",
				isQuota: false,
			};
		case "output-limit":
			return {
				userNotice:
					"Response hit the output limit — consider raising maxTokens or continuing the turn.",
				isQuota: true,
			};
		case "not-length":
			return { userNotice: null, isQuota: false };
	}
}
