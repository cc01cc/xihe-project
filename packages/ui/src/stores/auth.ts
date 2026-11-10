import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
    api,
    type ApiWorkspace,
    type SelfPermissionsView,
    onAuthTokensRefreshed,
    registerForceLogout,
    registerWorkspaceContextRequired,
} from "../composables/api";
import { logger, rotateAnonSessionId, clearAnonSessionId } from "../lib/logger";
import {
    clearTabWorkspace,
    migrateLegacyWorkspace,
    readTabWorkspace,
    readTabWorkspaceId,
    writeTabWorkspace,
    type TabWorkspace,
} from "../lib/workspaceContext";
import { broadcastLogout, onRemoteLogout } from "../services/authChannel";
import { useSessionStore } from "./session";
import { clearWorkspaceChatForUserSwitch } from "../features/workspace/chat/lifecycle";
import { useConfigStore } from "./config";
import { useAgentStore } from "./agent";
import { usePolicyStore } from "./policy";
import { useCheckpointStore } from "./checkpoint";
import { EMPTY_USER_CAPABILITIES, type User, type UserCapabilities } from "../types";
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
        userName = computed(() => user.value?.name ?? user.value?.email ?? "User");
    /**
     * PLAN-0610 W3-2b (decision #22): authority comes from the capability projection, never from a
     * role string. A cached pre-upgrade user carries no capabilities until
     * {@link refreshCapabilities} runs, so the default is "no capability" — CP stays authoritative
     * either way (a hidden entry is a UX affordance, not an authorization decision).
     */
    const capabilities = computed<UserCapabilities>(
            () => user.value?.capabilities ?? EMPTY_USER_CAPABILITIES,
        ),
        isAdmin = computed(() => capabilities.value.isInstanceAdmin),
        /** `cap:instance:super` — the full-permission system role (implies {@link isAdmin}). */
        isInstanceSuper = computed(() => capabilities.value.isInstanceSuper);

    /**
     * PLAN-0651 T4.2 (D51-07): the permission surfaces decide from **action atoms**, not from the
     * coarse `instance:admin` capability. CP gates the role/binding face by atom —
     * `RoleController:52-53` / `BindingController:35-36` use
     * `@PreAuthorize("@requesterAuthority.holdsActionAtom('MANAGE_ROLES')")` — so a UI that asks
     * `capabilities.isInstanceAdmin` disagrees with CP for a custom role that holds the atom
     * without the capability. The atom projection is `GET /api/v1/me/permissions`
     * (`instancePermissions`, instance-scope grant rows; `CapabilityProjectionService.permissionsFor`
     * — *not* `instanceCapabilities`, which only carries the three capability atoms).
     *
     * Kept out of the localStorage-cached `User` on purpose: atoms are fetched per session and a
     * missing/failed projection is fail-closed (no atom ⇒ no permission surface).
     */
    const ATOM_MANAGE_ROLES = "MANAGE_ROLES";
    const selfPermissions = ref<SelfPermissionsView | null>(null);
    let selfPermissionsRequest: Promise<boolean> | null = null;
    /** Instance-scope atom names; workspace-scope atoms live under `workspaces[].permissions` and
     * must never unlock an instance-scope surface. */
    const instanceAtoms = computed<Set<string>>(
        () =>
            new Set(
                (selfPermissions.value?.instancePermissions ?? []).map((atom) => atom.actionClass),
            ),
    );

    /**
     * CP parity for {@link ATOM_MANAGE_ROLES}: `holdsActionAtom(atom)` on `RequesterAuthority` is a
     * *membership* test over the instance-scope rows (no resource matching, unlike `allowsForUser`),
     * so the UI must ignore `resource` here or it would hide a tab CP would serve.
     */
    function hasInstanceAtom(actionClass: string): boolean {
        return instanceAtoms.value.has(actionClass);
    }
    const canManageRoles = computed(() => hasInstanceAtom(ATOM_MANAGE_ROLES));

    /**
     * PLAN-0752 V15：设置区「实例层可见 / 可写」判据必须与 CP 同源。CP 的 `ConfigController`
     * 与 `ConfigLockController` 放行实例层用的是 capability `cap:instance:admin`（BL-392），
     * 它由 `GET /me/capabilities` 投影成 `isInstanceAdmin`。这里用一个**名字说清能力位**的
     * 访问器，避免调用点再写 `isAdmin` 这种看起来像角色判断的字面量。
     */
    const hasInstanceAdminCapability = computed(() => capabilities.value.isInstanceAdmin);

    /**
     * Load the atom projection once per session. Single-flight: concurrent callers (settings nav +
     * a settings page) share one request. Failures stay soft — the surface fails closed and a later
     * call retries, while CP remains authoritative.
     */
    function loadSelfPermissions(): Promise<boolean> {
        if (!token.value) return Promise.resolve(false);
        if (selfPermissionsRequest) return selfPermissionsRequest;
        selfPermissionsRequest = (async () => {
            try {
                selfPermissions.value = await api.getSelfPermissions();
                return true;
            } catch (cause) {
                selfPermissions.value = null;
                logger.warn(
                    "Failed to load self permissions: " +
                        (cause instanceof Error ? cause.message : cause),
                );
                return false;
            } finally {
                selfPermissionsRequest = null;
            }
        })();
        return selfPermissionsRequest;
    }

    /** Idempotent: returns true when the projection is available (fresh or cached). */
    function ensureSelfPermissions(): Promise<boolean> {
        if (selfPermissions.value !== null) return Promise.resolve(true);
        return loadSelfPermissions();
    }

    function clearSelfPermissions() {
        selfPermissions.value = null;
        selfPermissionsRequest = null;
    }

    /**
     * `workspace:admin` for one workspace. An instance administrator administers every workspace
     * (CP's `AuthzContext.canWorkspaceAdmin` resolves the same way), so the local check includes the
     * instance capability on top of the explicit id list.
     */
    function canWorkspaceAdmin(workspaceId: string | null | undefined): boolean {
        if (isAdmin.value) return true;
        if (!workspaceId) return false;
        return capabilities.value.workspaceAdminOf.includes(workspaceId);
    }
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
     * BL-344：能力位**三态**。`undefined` = 还不知道（工作区仍在加载/刷新），
     * 只有真正拿到工作区（有角色投影，或有 ownerId 可推)才算"已确定"。
     *
     * 之前只有一个布尔（`workspaceRole !== "VIEWER"`，而 `workspaceRole` 在
     * `workspace === null` 时回落到 `EDITOR`），加载/刷新期间每一帧都像"已确定"：
     * 成员 tab 的面板被**卸载再重挂**，用户填进 `addUsername` 的内容随之清空
     * （host E2E `workspace-members` 30s 超时的根因）。
     */
    const workspaceRoleKnown = computed(
        () =>
            workspace.value !== null &&
            Boolean(workspace.value.workspaceRole || (workspace.value.ownerId && user.value?.id)),
    );

    /**
     * PLAN-0565 ruling #2: the members tab is visible to OWNER/EDITOR and hidden
     * for VIEWER. CP stays authoritative (list returns 403 for VIEWER anyway).
     *
     * BL-344：`undefined`（未知）**不等于**无权 —— 调用方"未知时不销毁子树、不回落 tab"，
     * 只有确定 `false` 才隐藏/回落。
     */
    const canViewMembers = computed<boolean | undefined>(() =>
        workspaceRoleKnown.value ? workspaceRole.value !== "VIEWER" : undefined,
    );

    /**
     * PLAN-0328 decision #56 / PLAN-0559: workspace OWNER (or instance ADMIN) may
     * classify tools. The client only decides whether to offer the affordance;
     * CP remains authoritative and returns 403 otherwise.
     */
    const canClassifyTools = computed(() => {
        if (isAdmin.value) return true;
        return canManageWorkspace.value;
    });

    function _saveToken(t: string, u: User, ws: ApiWorkspace | null, rt?: string) {
        token.value = t;
        user.value = u;
        workspace.value = ws;
        // PLAN-0651 T4.2: a new session invalidates the atom projection fetched for the previous one.
        clearSelfPermissions();
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

    /**
     * PLAN-0611 (BL-169 的姊妹问题): 采用**路由守卫**写下的免密会话。
     *
     * 守卫（`router/index.ts` 的免密分支，PLAN-0758 已移除）曾直接写 localStorage 后放行；此时 store 可能已经被
     * 创建（`main.ts` 先 `app.mount()`，App.vue 的 setup 会实例化 store，而初始导航尚未结束），
     * 内存里的 `token/user` 会一直停在"未登录"：`isAuthenticated`/`isAdmin` 全为 false，免密进入后
     * 看不到管理入口，刷新一次才正常。
     *
     * 与 {@link _saveToken} 的关键区别：**不清 tab 上下文**。守卫刚写入的就是本次要进入的工作区，
     * 清掉会把人弹回选择面 —— I6 的"登录响应里的 workspace 不是用户选择"不适用于守卫的显式写入。
     */
    function adoptGuardSession(
        accessToken: string,
        guardUser: User,
        // PLAN-0614 决策 #5：守卫传进来的可能是"上次 tab 上下文"（只有 id/name/role），
        // 未必是完整的 /workspaces 视图对象；store 这里与 `readWorkspace()` 一样按
        // `ApiWorkspace` 视图使用，缺字段时由调用方/后续刷新补齐。
        guardWorkspace: TabWorkspace | ApiWorkspace | null,
        guardRefreshToken?: string,
    ) {
        token.value = accessToken;
        user.value = guardUser;
        workspace.value = guardWorkspace as ApiWorkspace | null;
        // PLAN-0651 T4.2: the guard session replaces the subject; atom projection must be re-fetched.
        clearSelfPermissions();
        localStorage.setItem("xihe-token", accessToken);
        localStorage.setItem("xihe-user", JSON.stringify(guardUser));
        if (guardRefreshToken) {
            refreshToken.value = guardRefreshToken;
            localStorage.setItem("xihe-refresh-token", guardRefreshToken);
        }
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

    /**
     * PLAN-0610 W5a: refresh the caller's capability projection from `GET /auth/me`.
     *
     * <p>Capabilities ride on the login/register response, so a fresh sign-in is already
     * correct. This exists for the two cases where the cached `xihe-user` is stale: a reload with a
     * user object written by a pre-upgrade build (no `capabilities` field at all), and a capability
     * change made by another administrator. Failure is soft — the cached user stays and CP remains
     * authoritative.</p>
     */
    async function refreshCapabilities(): Promise<boolean> {
        if (!token.value) return false;
        try {
            const me = await api.me();
            if (!me?.id) return false;
            user.value = { ...(user.value ?? { id: me.id, email: me.email }), ...me };
            localStorage.setItem("xihe-user", JSON.stringify(user.value));
            return true;
        } catch (e) {
            logger.warn("Failed to refresh capabilities: " + (e instanceof Error ? e.message : e));
            return false;
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
        } catch (cause) {
            logger.warn("Failed to clear Workspace Chat cache during user switch", {
                error: String(cause),
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
        // PLAN-0651 T4.2: atom projection belongs to the signed-out subject.
        clearSelfPermissions();
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

    /**
     * PLAN-0641 M2 T3.1: force a workspace re-read after a mutation that changes
     * the root projection (declare/undeclare). `hydrateWorkspace` deliberately
     * short-circuits on a loaded workspace, so the refresh needs its own entry.
     */
    async function refreshWorkspace(): Promise<void> {
        const tabWorkspaceId = readTabWorkspaceId() ?? workspace.value?.id ?? null;
        if (!token.value || !tabWorkspaceId) return;
        try {
            const current = await api.getWorkspace(tabWorkspaceId);
            workspace.value = current;
            writeTabWorkspace(current);
        } catch (cause) {
            logger.warn("Failed to refresh the current workspace", cause);
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
    // BL-181: 409 WORKSPACE_CONTEXT_REQUIRED is a recoverable state (authenticated, no workspace
    // context). Clear the tab context so the router guard does not bounce straight back into the
    // missing workspace, then open the picker — the account keeps its session.
    registerWorkspaceContextRequired(() => {
        clearTabWorkspace();
        if (window.location.pathname !== "/workspace" && window.location.pathname !== "/login") {
            void router.push({ name: "workspace-home" });
        }
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
        capabilities,
        isAdmin,
        hasInstanceAdminCapability,
        isInstanceSuper,
        selfPermissions,
        hasInstanceAtom,
        canManageRoles,
        ensureSelfPermissions,
        canWorkspaceAdmin,
        canClassifyTools,
        workspaceRole,
        canWriteWorkspace,
        canManageWorkspace,
        canViewMembers,
        currentWorkspaceId,
        login,
        register,
        adoptGuardSession,
        refreshCapabilities,
        logout,
        hydrateWorkspace,
        refreshWorkspace,
        selectWorkspace,
    };
});
