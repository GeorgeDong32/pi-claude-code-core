/**
 * Shared model-id parser (P0-LB-02).
 *
 * Parses `"provider/model[:effort]"` strings — the format used by pm model
 * profiles (`profiles.ts` parseModelId) and pi-review model resolution.
 * Behavior is byte-equivalent to pm 2.8.0's parser (field names differ:
 * `modelId` / `effort` instead of `model` / `thinkingLevel`):
 *
 *   - `"anthropic/claude-opus-4:high"` → { provider, modelId, effort }
 *   - `"anthropic/claude-opus-4"`      → { provider, modelId }
 *   - trailing `:` (e.g. `"prov/big:"`) is treated as "no effort suffix"
 *   - missing/leading slash, empty provider or empty model → null
 *   - empty / non-string input → null (never throws)
 */

export interface ParsedModelId {
	provider: string;
	modelId: string;
	effort?: string;
}

export function parseModelId(raw: unknown): ParsedModelId | null {
	if (typeof raw !== "string" || !raw) return null;

	const colonIdx = raw.indexOf(":");
	const providerAndModel = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
	const effort =
		colonIdx === -1 ? undefined : raw.slice(colonIdx + 1) || undefined;

	const slashIdx = providerAndModel.indexOf("/");
	if (slashIdx <= 0) return null;
	const provider = providerAndModel.slice(0, slashIdx);
	const modelId = providerAndModel.slice(slashIdx + 1);
	if (!provider || !modelId) return null;

	return effort === undefined ? { provider, modelId } : { provider, modelId, effort };
}
