/**
 * lib/truncation-verdict.ts — [cherry-batch1 B1] dual verdict for
 * stopReason="length" terminations (spec docs/{en,zh}/cherry-batch1-spec.md).
 *
 * Cherry-derived (piLengthRecovery lineage): a length stop has two causes
 * with different guidance — context clamp (the response was squeezed by
 * the context window; compacting or splitting the task helps) vs output
 * limit (the model wrote up to its configured max output; raising
 * maxTokens or continuing the turn helps). "Truncation is never a silent
 * success": both verdicts carry user-facing notice copy.
 *
 * Pure lib module (invariant 1: no extensions imports). The model cap is
 * OPTIONAL: when the caller cannot resolve it, the conservative verdict
 * is context-clamp — a notice with slightly wrong guidance beats silence.
 */

export type LengthStopVerdict = "context-clamp" | "output-limit" | "not-length";

export interface LengthStopInput {
	stopReason: string | undefined;
	/** Partial usage view — only `output` is needed. */
	usage?: { output?: number } | undefined;
	/** The model's configured max output tokens, when resolvable. */
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
	// Unknown cap (or output under it): the conservative verdict. The copy
	// carries the hedge so a mis-verdict still guides the user right.
	return "context-clamp";
}

export interface BoundedRecoveryPolicy {
	/** Notice copy for the shared bus notification queue; null when not-length. */
	userNotice: string | null;
	/** true when the cause is the model's configured quota (config-side fix). */
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
