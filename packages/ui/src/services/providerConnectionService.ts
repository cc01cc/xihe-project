import { request } from "../composables/api";
import type { ProviderCatalog } from "../types/provider";
import type {
    ApiInputType,
    ProviderConnection,
    ProviderConnectionInput,
    ProviderDefinition,
} from "../types/providerConnection";

/**
 * task-401：一条连接下**可用于对话**的模型名（唯一口径）。
 *
 * <p>目录按 connectionId 聚合（`GET /models` 的 `providers` 映射，`configStore.modelCache.providers`）。
 * 目录里没有这条连接时，只有 `operation=chat` 且 `modelDiscovery=manual` 的连接才回其手填模型 ——
 * 不猜、不跨连接借模型（与 `ProviderHub.vue#chatModelsOf` 同策略；该文件目前仍持本地副本，
 * 迁移到本 helper 是后续项，不在本卡写域内）。</p>
 */
export function chatModelNamesOf(
    connection: ProviderConnection,
    catalogs: Record<string, ProviderCatalog> | undefined,
): string[] {
    const catalog = catalogs?.[connection.id];
    const chat = (catalog?.connectionId === connection.id ? (catalog.models ?? []) : [])
        .filter((model) => model.capabilities?.chat)
        .map((model) => model.name);
    if (chat.length) return chat;
    return connection.operation === "chat" && connection.modelDiscovery === "manual"
        ? connection.manualModels
        : [];
}

export interface ProviderCatalogResponse {
    catalogRevision: string;
    providers: ProviderDefinition[];
}

export interface ApiInputTypeListResponse {
    types: ApiInputType[];
}

export interface ProviderConnectionListResponse {
    connections: ProviderConnection[];
}

export interface ProviderVerifyResponse {
    connection: ProviderConnection;
    models: Array<{ name: string }>;
}

export interface ConnectionTypeImpact {
    connectionRevision: number;
    currentType: { apiTypeId: string; version: number };
    targetType: { apiTypeId: string; version: number };
    compatibleTemplates: import("./apiRequestTemplates").TemplateOption[];
    incompatibleOverrides: Array<{ scope: string; count: number }>;
    sessionRebindCount: number;
}
export function getConnectionTypeImpact(id: string, apiTypeId: string, version: number) {
    const query = new URLSearchParams({ apiTypeId, version: String(version) });
    return request<ConnectionTypeImpact>(
        `/provider-connections/${encodeURIComponent(id)}/api-type-change-impact?${query}`,
    );
}

export function listProviderCatalog(): Promise<ProviderCatalogResponse> {
    return request<ProviderCatalogResponse>("/provider-catalog");
}

export function listApiInputTypes(): Promise<ApiInputTypeListResponse> {
    return request<ApiInputTypeListResponse>("/api-input-types");
}

export function listProviderConnections(): Promise<ProviderConnectionListResponse> {
    return request<ProviderConnectionListResponse>("/provider-connections");
}

export function createProviderConnection(
    input: ProviderConnectionInput,
): Promise<ProviderConnection> {
    return request<ProviderConnection>("/provider-connections", {
        method: "POST",
        body: JSON.stringify(input),
    });
}

export function updateProviderConnection(
    id: string,
    input: Partial<ProviderConnectionInput>,
): Promise<ProviderConnection> {
    return request<ProviderConnection>(`/provider-connections/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
    });
}

export function verifyProviderConnection(id: string): Promise<ProviderVerifyResponse> {
    return request<ProviderVerifyResponse>(
        `/provider-connections/${encodeURIComponent(id)}/verify`,
        {
            method: "POST",
        },
    );
}

export function deleteProviderConnection(id: string): Promise<void> {
    return request<void>(`/provider-connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
}

/** PLAN-0505: delete impact preview — reference counts the delete would cascade away. */
export interface DeleteImpact {
    connectionId: string;
    providerId: string;
    connectionKey: string;
    bindingCount: number;
    bindingUserScopes: number;
    defaultTemplateRef: boolean;
    profileCount: number;
    profileScopes: string[];
    sessionCount: number;
    blocked: boolean;
}

export function getDeleteImpact(id: string): Promise<DeleteImpact> {
    return request<DeleteImpact>(`/provider-connections/${encodeURIComponent(id)}/delete-impact`);
}
