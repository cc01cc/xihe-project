/* task-1032：自 composables/api.ts 拆出的 auth 段（逐字节搬运）。 */
import { request } from "./_core";
import type { ApiUserCapabilities, ApiWorkspace } from "./_types";
export interface ApiAuthUser {
    id: string;
    email: string;
    username?: string;
    name?: string;
    workspaceId?: string | null;
    capabilities?: ApiUserCapabilities;
}
export interface FirstRunAccountDisclosure {
    state: "generated-secret" | "operator-provided";
    account: { email: string; username: string };
    secret?: { value?: string; issuedAt?: string } | null;
    source?: "env" | null;
}

export const authApi = {
    discloseFirstRunAccount() {
        return request<FirstRunAccountDisclosure>("/bootstrap/first-run-account", {
            method: "POST",
            cache: "no-store",
        });
    },
    rewriteFirstRunAccount(password: string, username?: string) {
        return request<{ account: { email: string; username: string }; secretRevoked: boolean }>(
            "/bootstrap/first-run-account/rewrite",
            {
                method: "POST",
                cache: "no-store",
                body: JSON.stringify({ password, ...(username ? { username } : {}) }),
            },
        );
    },
    login(identifier: string, password: string) {
        return request<{
            accessToken: string;
            refreshToken: string;
            user: ApiAuthUser;
            // PLAN-0614: CP returns null when the account has no workspace (registration no longer creates one).

            workspaceId?: string | null;
            workspace?: ApiWorkspace | null;
        }>("/auth/login", {
            method: "POST",
            body: JSON.stringify({ identifier, password }),
        });
    },
    register(email: string, password: string, name: string, username?: string) {
        // PLAN-0526: local mode may omit the password (server generates one).
        // PLAN-0565 ruling #7: optional username; blank derives one from email.
        const body: Record<string, string | undefined> = {
            email,
            password: password || undefined,
            name,
            username: username || undefined,
        };
        return request<{
            accessToken: string;
            refreshToken: string;
            user: ApiAuthUser;
            // PLAN-0614: CP returns null when the account has no workspace (registration no longer creates one).

            workspaceId?: string | null;
            workspace?: ApiWorkspace | null;
        }>("/auth/register", {
            method: "POST",
            body: JSON.stringify(body),
        });
    },
    me() {
        return request<ApiAuthUser>("/auth/me");
    },
    bootstrapStatus() {
        return request<{ initialized: boolean }>("/auth/bootstrap-status");
    },
};
