/**
 * PLAN-0504: the whole llm-provider default profile unit
 * (providerId + connectionKey + model). It is stored as one JSON value and
 * always written/cleared as a unit — layers never merge fields.
 */
export interface LlmProviderProfile {
    providerId: string;
    connectionKey: string;
    model: string;
}

/** Parse the stored profile value; malformed/absent values read as "no profile". */
export function parseLlmProfileValue(raw: string | null | undefined): LlmProviderProfile | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const record = parsed as Record<string, unknown>;
        const providerId = record.providerId;
        const connectionKey = record.connectionKey;
        const model = record.model;
        if (typeof providerId !== "string" || !providerId.trim()) return null;
        if (typeof connectionKey !== "string" || !connectionKey.trim()) return null;
        if (typeof model !== "string" || !model.trim()) return null;
        return { providerId, connectionKey, model };
    } catch {
        return null;
    }
}
