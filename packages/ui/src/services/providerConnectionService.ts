import { request } from "../composables/api";
import type {
    ApiInputType,
    ProviderConnection,
    ProviderConnectionInput,
    ProviderDefinition,
} from "../types/providerConnection";

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
