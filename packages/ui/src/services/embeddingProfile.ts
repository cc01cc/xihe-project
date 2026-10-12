import { request } from "../composables/api";
import type { ProviderConnection } from "../types/providerConnection";

export interface EmbeddingResolvedProfile {
    providerId: string;
    connectionKey: string;
    providerConnectionId: string;
    connectionOwnerScope: string;
    connectionRevision: number;
    modelId: string;
    dimension: number;
    profileScope: string;
    modelSource: string;
}

export interface EmbeddingEffectiveProfile {
    profile: { providerId: string; connectionKey: string; model: string } | null;
    profileScope: string | null;
    resolved: EmbeddingResolvedProfile | null;
    /** Server-owned pinned contract; clients must not re-declare it. */
    contract?: { modelId: string; dimension: number };
    code?: string;
}

export interface EmbeddingTestResult {
    status: "ok" | "error";
    model?: string;
    dimension?: number;
    requestId?: string;
    errorCode?: string;
}

export interface EmbeddingProfileInput {
    providerId: string;
    connectionKey: string;
    model: string;
}

export function embeddingConnections(
    connections: ProviderConnection[] | undefined | null,
): ProviderConnection[] {
    return (connections ?? []).filter(
        (item) => item.enabled && item.status === "READY" && item.operation === "embedding",
    );
}

export function fetchEmbeddingEffective(workspaceId?: string): Promise<EmbeddingEffectiveProfile> {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    return request<EmbeddingEffectiveProfile>(`/config/embedding/effective${query}`);
}

export function saveEmbeddingProfile(
    layer: "user" | "workspace" | "instance",
    profile: EmbeddingProfileInput | null,
    workspaceId?: string,
): Promise<void> {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    const body: Record<string, string> = {};
    if (profile) {
        body.profile = JSON.stringify(profile);
    }
    return request<void>(`/config/${layer}/embedding${query}`, {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

export function testEmbedding(workspaceId?: string): Promise<EmbeddingTestResult> {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    return request<EmbeddingTestResult>(`/config/embedding/test${query}`, {
        method: "POST",
        body: JSON.stringify({}),
    });
}
