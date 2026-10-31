import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
    api,
    type ApiWorkspace,
    onAuthTokensRefreshed,
    registerForceLogout,
} from "../composables/api";
import { logger, rotateAnonSessionId, clearAnonSessionId } from "../lib/logger";
import {
    clearTabWorkspace,
    migrateLegacyWorkspace,
    readTabWorkspace,
    readTabWorkspaceId,
    writeTabWorkspace,
} from "../lib/workspaceContext";
import { broadcastLogout, onRemoteLogout } from "../services/authChannel";
import { useSessionStore } from "./session";
import { clearWorkspaceChatForUserSwitch } from "../features/workspace/chat/lifecycle";
import { useConfigStore } from "./config";
import { useAgentStore } from "./agent";
import { usePolicyStore } from "./policy";
import { useCheckpointStore } from "./checkpoint";
import type { User } from "../types";
// PLAN-0546: SPA-route logout. router/index.ts does not import stores, so this is acyclic.
import router from "../router";

export const useAuthStore = defineStore("auth", () => {
    // Authentication is the only state worth caching. Server is the canonical
    // source for workspace/session/messages; we never write business fields
    // (workspaceId, sessions, messages) to localStorage.
    function readUser(): User | null {
        try {
            const raw = localStorage.getItem("xihe-user");
            return raw ? JSON.parse(raw) : null;
        } catch {
            logger.warn("Failed to parse saved user from localStorage");
            return null;
        }
    }
    function readWorkspace(): ApiWorkspace | null {
        // PLAN-0559: the workspace is a per-tab selection. Migrate the old
        // localStorage value once, then only ever read sessionStorage.
        migrateLegacyWorkspace();
        return readTabWorkspace() as ApiWorkspace | null;
    }

    const token = ref<string | null>(localStorage.getItem("xihe-token")),
        refreshToken = ref<string | null>(localStorage.getItem("xihe-refresh-token")),
        user = ref<User | null>(readUser()),
        workspace = ref<ApiWorkspace | null>(readWorkspace()),
        loading = ref(false),
        error = ref<string | null>(null),
        lastError = ref<{ code: string; retryAfterSeconds?: number } | null>(null);

    const isAuthenticated = computed(() => !!token.value),
        userName = computed(() => user.value?.name ?? user.value?.email ?? "User"),
        isAdmin = computed(() => user.value?.role === "ADMIN");
    /**
     * PLAN-0559 role matrix. Legacy responses without `workspaceRole` fall back
     * to owner/EDITOR inference so an old CP build does not hide every write
     * control; the server still enforces the role.
     */
    const workspaceRole = computed<"OWNER" | "EDITOR" | "VIEWER">(() => {
        const explicit = workspace.value?.workspaceRole;
        if (explicit === "OWNER" || explicit === "EDITOR" || explicit === "VIEWER") {
            return explicit;
        }
        const ownerId = workspace.value?.ownerId;
        return ownerId && user.value?.id && ownerId === user.value.id ? "OWNER" : "EDITOR";
    });
    const canWriteWorkspace = computed(
        () => workspace.value?.canWrite ?? workspaceRole.value !== "VIEWER",
    );
    const canManageWorkspace = computed(() => workspaceRole.value === "OWNER");

    /**
     * PLAN-0565 ruling #2: the members tab is visible to OWNER/EDITOR and hidden
     * for VIEWER. CP stays authoritative (list returns 403 for VIEWER anyway).
     */
    const canViewMembers = computed(() => workspaceRole.value !== "VIEWER");

    /**
     * PLAN-0328 decision #56 / PLAN-0559: workspace OWNER (or instance ADMIN) may
     * classify tools. The client only decides whether to offer the affordance;
     * CP remains authoritative and returns 403 otherwise.
     */
    const canClassifyTools = computed(() => {
        if (user.value?.role === "ADMIN") return true;
        return canManageWorkspace.value;
    });

    function _saveToken(t: string, u: User, ws: ApiWorkspace | null, rt?: string) {
        token.value = t;
        user.value = u;
        workspace.value = ws;
        localStorage.setItem("xihe-token", t);
        localStorage.setItem("xihe-user", JSON.stringify(user.value));
        if (rt) {
            refreshToken.value = rt;
            localStorage.setItem("xihe-refresh-token", rt);
        }
        // PLAN-0608 (I6): the login response's workspace is a *fallback*, not the
        // user's choice. Persisting it as tab intent made every later request
        // carry the wrong workspace (review P0-1). A multi-workspace member now
        // picks explicitly; the router sends them to the picker.
        clearTabWorkspace();
        // New authentication session: rotate the anonymous telemetry session id (PLAN-0527).
        rotateAnonSessionId();
    }

    /** PLAN-0565 ruling #7: identifier is email or username. */
    async function login(identifier: string, password: string) {
        loading.value = true;
        error.value = null;
        lastError.value = null;
        try {
            const res = await api.login(identifier, password);
            const ws =
                res.workspace ??
                (res.workspaceId ? { id: res.workspaceId, name: "Default Workspace" } : null);
            _saveToken(res.accessToken, res.user, ws, res.refreshToken);
            clearSessionCaches();
            return true;
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Login failed";
            logger.error("Login failed: " + msg);
            error.value = msg;
            lastError.value = errorDetails(e);
            return false;
        } finally {
            loading.value = false;
        }
    }

    /** PLAN-0565 ruling #7: optional username; blank derives one from email. */
    async function register(email: string, password: string, name: string, username?: string) {
        loading.value = true;
        error.value = null;
        lastError.value = null;
        try {
            const res = await api.register(email, password, name, username);
            const ws =
                res.workspace ??
                (res.workspaceId ? { id: res.workspaceId, name: "Default Workspace" } : null);
            _saveToken(res.accessToken, res.user, ws, res.refreshToken);
            clearSessionCaches();
            return true;
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Registration failed";
            logger.error("Registration failed: " + msg);
            error.value = msg;
            lastError.value = errorDetails(e);
            return false;
        } finally {
            loading.value = false;
        }
    }

    /** PLAN-0558: keep the stable Problem code and Retry-After for localized UI copy. */
    function errorDetails(
        errorValue: unknown,
    ): { code: string; retryAfterSeconds?: number } | null {
        const problem = (errorValue as { problem?: { code?: string } } | null)?.problem;
        if (!problem?.code) return null;
        return {
            code: problem.code,
            retryAfterSeconds: (errorValue as { retryAfterSeconds?: number } | null)
                ?.retryAfterSeconds,
        };
    }

    /** PLAN-0526: passwordless re-entry for the single local user (loopback-only gate on CP). */
    async function localLogin(): Promise<boolean> {
        loading.value = true;
        error.value = null;
        lastError.value = null;
        try {
            const res = await api.localLogin();
            const ws =
                res.workspace ??
                (res.workspaceId ? { id: res.workspaceId, name: "Default Workspace" } : null);
            _saveToken(res.accessToken, res.user, ws, res.refreshToken);
            clearSessionCaches();
            return true;
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Local login failed";
            logger.warn("Local login failed: " + msg);
            error.value = msg;
            return false;
        } finally {
            loading.value = false;
        }
    }

    function clearSessionCaches() {
        try {
            const sessionStore = useSessionStore();
            sessionStore.resetForUserSwitch();
        } catch {
            // Pinia not yet initialised — store will start fresh on next access.
        }
        try {
            clearWorkspaceChatForUserSwitch();
        } catch (error) {
            logger.warn("Failed to clear Workspace Chat cache during user switch", {
                error: String(error),
            });
            // Preserve the existing fail-soft auth lifecycle; the cleanup failure is logged.
        }
        try {
            const configStore = useConfigStore();
            configStore.clearForUserSwitch();
        } catch {
            // Pinia not yet initialised — store will start fresh on next access.
        }
        try {
            const agentStore = useAgentStore();
            agentStore.reset();
        } catch {
            // Pinia not yet initialised — store will start fresh on next access.
        }
        try {
            usePolicyStore().reset();
        } catch {
            // Pinia not yet initialised — store will start fresh on next access.
        }
        try {
            useCheckpointStore().clearForUserSwitch();
        } catch {
            // Pinia not yet initialised — store will start fresh on next access.
        }
    }

    function clearAuthState() {
        token.value = null;
        refreshToken.value = null;
        user.value = null;
        workspace.value = null;
        error.value = null;
        lastError.value = null;
        localStorage.removeItem("xihe-token");
        localStorage.removeItem("xihe-refresh-token");
        localStorage.removeItem("xihe-user");
        clearTabWorkspace();
        // Logout: clear the anonymous telemetry session id (PLAN-0527 decision #5).
        clearAnonSessionId();
        clearSessionCaches();
    }

    function logout() {
        clearAuthState();
        broadcastLogout();
    }

    function handleRemoteLogout() {
        clearAuthState();
        if (!["/login", "/register"].includes(window.location.pathname)) {
            router.push({ name: "login" });
        }
    }

    onRemoteLogout(handleRemoteLogout);

    /**
     * Fetches the workspace for this tab. The URL/sessionStorage workspace is
     * authoritative; `/workspaces/current` is only the bootstrap default.
     */
    async function hydrateWorkspace(): Promise<void> {
        if (!token.value) return;
        const tabWorkspaceId = readTabWorkspaceId();
        if (tabWorkspaceId && workspace.value?.id === tabWorkspaceId && workspace.value.ownerId) {
            return;
        }
        try {
            if (!tabWorkspaceId) {
                // PLAN-0608 (I6): never invent a workspace from the fallback
                // (`/workspaces/current` = first member workspace). "Not chosen yet"
                // is a real state; the router renders the picker for it.
                workspace.value = null;
                return;
            }
            const current = await api.getWorkspace(tabWorkspaceId);
            workspace.value = current;
            writeTabWorkspace(current);
        } catch (cause) {
            logger.warn("Failed to hydrate current workspace", cause);
            if (tabWorkspaceId) {
                // Stale/deleted tab workspace: do not keep retrying it.
                clearTabWorkspace();
                workspace.value = null;
            }
        }
    }

    let selectSequence = 0;

    async function selectWorkspace(workspaceId: string): Promise<ApiWorkspace> {
        const sequence = ++selectSequence;
        if (
            workspace.value?.id === workspaceId &&
            (workspace.value.name || workspace.value.workspaceRole)
        ) {
            return workspace.value;
        }
        const previousId = workspace.value?.id;
        try {
            const selected = await api.getWorkspace(workspaceId);
            if (sequence !== selectSequence) {
                // A newer switch won; never let a late response overwrite it.
                return selected;
            }
            workspace.value = selected;
            writeTabWorkspace(selected);
            if (previousId !== selected.id) {
                clearSessionCaches();
            }
            // PLAN-0555 R8: the connection list is workspace-scoped; without this
            // the composer keeps showing the previous workspace's connections.
            useConfigStore().invalidateProviderConnections();
            return selected;
        } catch (cause) {
            if (sequence === selectSequence) {
                workspace.value = null;
                clearTabWorkspace();
            }
            throw cause;
        }
    }

    const currentWorkspaceId = computed(() => workspace.value?.id ?? null);

    // PLAN-0546: silent refresh (api.ts) writes new tokens to localStorage; keep the
    // in-memory refs in sync and route via SPA instead of window.location.href.
    onAuthTokensRefreshed((accessToken) => {
        token.value = accessToken;
        refreshToken.value = localStorage.getItem("xihe-refresh-token");
    });
    registerForceLogout(() => {
        logout();
        router.push({
            name: "login",
            query: { redirect: window.location.pathname + window.location.search },
        });
    });

    return {
        token,
        user,
        workspace,
        loading,
        error,
        lastError,
        isAuthenticated,
        userName,
        isAdmin,
        canClassifyTools,
        workspaceRole,
        canWriteWorkspace,
        canManageWorkspace,
        canViewMembers,
        currentWorkspaceId,
        login,
        register,
        localLogin,
        logout,
        hydrateWorkspace,
        selectWorkspace,
    };
});

