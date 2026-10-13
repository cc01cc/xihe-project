export type ProviderScope = "USER" | "WORKSPACE";
export type ProviderAdapter = "native-litellm" | "openai-compatible" | "manual-model";
export type ProviderCredentialType = "api-key" | "none";
export type ApiTypeOperation = "chat" | "embedding";
export type ProviderConnectionStatus =
    | "UNVERIFIED"
    | "VERIFYING"
    | "READY"
    | "INVALID_CREDENTIALS"
    | "UNREACHABLE"
    | "DISABLED";

export interface ApiTypePair {
    apiTypeId: string;
    version: number;
    defaultBaseUrl?: string | null;
    modelDiscovery?: ProviderDefinition["modelDiscovery"];
}

export interface ApiInputType {
    apiTypeId: string;
    version: number;
    operation: ApiTypeOperation;
    method: "POST";
    path: string;
    requestShape: string;
    responseShape: string;
    streamShape: string;
}

export interface ProviderDefinition {
    id: string;
    displayName: string;
    category?: "recommended" | "other" | "custom";
    description?: string;
    adapter: ProviderAdapter;
    litellmProvider?: string | null;
    defaultBaseUrl?: string | null;
    modelDiscovery: "remote-models" | "litellm-catalog" | "curated" | "manual";
    credential: {
        type: ProviderCredentialType;
        required: boolean;
        placeholder?: string | null;
    };
    supports: {
        customBaseUrl: boolean;
        streaming: boolean;
        tools?: boolean;
        vision?: boolean;
    };
    supportedApiTypes: ApiTypePair[];
    defaultApiType: ApiTypePair;
}

export interface ProviderConnection {
    id: string;
    providerId: string;
    connectionKey: string;
    apiTypeId: string;
    apiTypeVersion: number;
    operation: ApiTypeOperation;
    label: string;
    scope: ProviderScope;
    ownerId?: string;
    workspaceId?: string | null;
    baseUrl?: string | null;
    modelDiscovery: ProviderDefinition["modelDiscovery"];
    manualModels: string[];
    hasKey: boolean;
    maskedKey?: string | null;
    enabled: boolean;
    status: ProviderConnectionStatus;
    lastVerifiedAt?: string | null;
    lastErrorCode?: string | null;
    revision: number;
}

export interface ProviderConnectionInput {
    providerId: string;
    label: string;
    scope: ProviderScope;
    connectionKey: string;
    apiKey?: string;
    baseUrl?: string;
    modelDiscovery?: ProviderDefinition["modelDiscovery"];
    manualModels?: string[];
    enabled?: boolean;
    apiTypeId?: string;
    apiTypeVersion?: number;
    expectedRevision?: number;
    connectionDefaultTemplateRef?: import("../services/apiRequestTemplates").TemplateRef;
    confirmedTypeChange?: boolean;
}
