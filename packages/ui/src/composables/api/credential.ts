/* task-1032：自 composables/api.ts 拆出的 credential 段（逐字节搬运）。 */
import type {
    CredentialBindPayload,
    CredentialBindResult,
    CredentialCreateRequest,
    CredentialDeleteReport,
    CredentialEventsResponse,
    CredentialListResponse,
    CredentialOwnerType,
    CredentialReferencesResponse,
    CredentialReplaceRequest,
    CredentialRevealResponse,
    CredentialSummary,
} from "../../types";
import { request } from "./_core";

export const credentialApi = {
    async listCredentials(
        params: { ownerType?: CredentialOwnerType; ownerId?: string } = {},
    ): Promise<CredentialListResponse> {
        const query = new URLSearchParams();
        if (params.ownerType) query.set("ownerType", params.ownerType);
        if (params.ownerId) query.set("ownerId", params.ownerId);
        const suffix = query.toString() ? `?${query.toString()}` : "";
        return request<CredentialListResponse>(`/credentials${suffix}`);
    },
    async createCredential(payload: CredentialCreateRequest): Promise<CredentialSummary> {
        return request<CredentialSummary>("/credentials", {
            method: "POST",
            body: JSON.stringify(payload),
        });
    },
    async replaceCredential(
        credentialId: string,
        payload: CredentialReplaceRequest,
    ): Promise<CredentialSummary> {
        return request<CredentialSummary>(
            `/credentials/${encodeURIComponent(credentialId)}/replace`,
            {
                method: "POST",
                body: JSON.stringify(payload),
            },
        );
    },
    async deleteCredential(credentialId: string): Promise<CredentialDeleteReport> {
        return request<CredentialDeleteReport>(`/credentials/${encodeURIComponent(credentialId)}`, {
            method: "DELETE",
        });
    },
    async getCredentialReferences(credentialId: string): Promise<CredentialReferencesResponse> {
        return request<CredentialReferencesResponse>(
            `/credentials/${encodeURIComponent(credentialId)}/references`,
        );
    },
    async precheckCredentialAtoms(
        permissions: Array<{ actionClass: string; resource?: string }>,
    ): Promise<{ uncovered: string[] }> {
        return request<{ uncovered: string[] }>("/credentials/precheck", {
            method: "POST",
            body: JSON.stringify({ permissions }),
        });
    },
    async bindCredential(
        credentialId: string,
        payload: CredentialBindPayload,
    ): Promise<CredentialBindResult> {
        return request<CredentialBindResult>(
            `/credentials/${encodeURIComponent(credentialId)}/bindings`,
            {
                method: "POST",
                body: JSON.stringify(payload),
            },
        );
    },
    async unbindCredential(
        credentialId: string,
        payload: CredentialBindPayload,
    ): Promise<CredentialBindResult> {
        return request<CredentialBindResult>(
            `/credentials/${encodeURIComponent(credentialId)}/bindings`,
            {
                method: "DELETE",
                body: JSON.stringify(payload),
            },
        );
    },
    async revealCredential(
        credentialId: string,
        password: string,
    ): Promise<CredentialRevealResponse> {
        return request<CredentialRevealResponse>(
            `/credentials/${encodeURIComponent(credentialId)}/reveal`,
            {
                method: "POST",
                body: JSON.stringify({ password }),
            },
        );
    },
    async getCredentialEvents(
        credentialId: string,
        limit = 200,
    ): Promise<CredentialEventsResponse> {
        return request<CredentialEventsResponse>(
            `/credentials/${encodeURIComponent(credentialId)}/events?limit=${limit}`,
        );
    },
};
