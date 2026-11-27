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

export function modelIdentityKey(
	model: { provider?: string; id?: string } | null | undefined,
): string | undefined {
	return model && typeof model.id === "string"
		? `${model.provider ?? ""}\u0000${model.id}`
		: undefined;
}
