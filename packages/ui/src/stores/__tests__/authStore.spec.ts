import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "../auth";
import { useAgentStore } from "../agent";
import { useChatStore } from "../../features/workspace/chat/stores/chat";
import type { User } from "../../types";
import type * as apiModule from "../../composables/api";

vi.mock("../../composables/api", () => ({
    api: {
        login: vi.fn<typeof apiModule.login>(),
        register: vi.fn<typeof apiModule.register>(),
        me: vi.fn<typeof apiModule.api.me>(),
        getWorkspace: vi.fn<typeof apiModule.api.getWorkspace>(),
        getCurrentWorkspace: vi.fn<typeof apiModule.api.getCurrentWorkspace>(),
        // PLAN-0651 T4.2: the action-atom projection behind the settings permission surfaces.
        getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
    },
    onAuthTokensRefreshed: vi.fn<(cb: (accessToken: string) => void) => void>(),
    registerForceLogout: vi.fn<(fn: () => void) => void>(),
    // PLAN-0612 / BL-181: the store now registers the 409 recovery hook, so the module mock
    // must expose it — otherwise every test in this file dies at import time.
    registerWorkspaceContextRequired: vi.fn<(fn: () => void) => void>(),
}));

const mockUser: User = { id: "u1", email: "test@test.com", name: "Test" },
    REQUEST_ID = "11111111-1111-4111-8111-111111111111",
    RUN_ID = "22222222-2222-4222-8222-222222222222",
    SESSION_ID = "33333333-3333-4333-8333-333333333333",
    WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
});

describe("useAuthStore", () => {
    it("starts unauthenticated", () => {
        const store = useAuthStore();
        expect(store.isAuthenticated).toBe(false);
        expect(store.token).toBeNull();
        expect(store.user).toBeNull();
    });

    it("restores token and user from localStorage", () => {
        localStorage.setItem("xihe-token", "saved-token");
        localStorage.setItem("xihe-user", JSON.stringify(mockUser));
        const store = useAuthStore();
        expect(store.isAuthenticated).toBe(true);
        expect(store.token).toBe("saved-token");
        expect(store.user?.email).toBe("test@test.com");
    });

    it("login success saves token and user", async () => {
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        vi.mocked(api.login).mockResolvedValue({
            accessToken: "new-token",
            user: mockUser,
        });
        const ok = await store.login("test@test.com", "pass");
        expect(ok).toBe(true);
        expect(store.isAuthenticated).toBe(true);
        expect(store.token).toBe("new-token");
        expect(localStorage.getItem("xihe-token")).toBe("new-token");
    });

    it("login failure sets error and returns false", async () => {
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        vi.mocked(api.login).mockRejectedValue(new Error("Invalid credentials"));
        const ok = await store.login("bad@test.com", "wrong");
        expect(ok).toBe(false);
        expect(store.isAuthenticated).toBe(false);
        expect(store.error).toBe("Invalid credentials");
    });

    it("login failure keeps the 429 code and retry delay", async () => {
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        vi.mocked(api.login).mockRejectedValue(
            Object.assign(new Error("Too many login attempts"), {
                problem: { code: "AUTH_RATE_LIMITED" },
                retryAfterSeconds: 12,
            }),
        );
        const ok = await store.login("a@test.com", "wrong");
        expect(ok).toBe(false);
        expect(store.lastError).toEqual({
            code: "AUTH_RATE_LIMITED",
            retryAfterSeconds: 12,
        });
    });

    it("register success saves token and user", async () => {
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        vi.mocked(api.register).mockResolvedValue({
            accessToken: "reg-token",
            user: mockUser,
        });
        const ok = await store.register("new@test.com", "pass", "New");
        expect(ok).toBe(true);
        expect(store.token).toBe("reg-token");
    });

    it("logout clears all state", () => {
        localStorage.setItem("xihe-token", "t");
        localStorage.setItem("xihe-user", JSON.stringify(mockUser));
        const store = useAuthStore();

        store.logout();

        expect(store.token).toBeNull();
        expect(store.user).toBeNull();
        expect(store.error).toBeNull();
        expect(localStorage.getItem("xihe-token")).toBeNull();
        expect(localStorage.getItem("xihe-user")).toBeNull();
    });

    it("logout clears Workspace Chat cache", () => {
        const auth = useAuthStore(),
            chat = useChatStore();
        auth.$patch({ token: "t", user: mockUser });
        chat.addMessage(SESSION_ID, {
            id: "cached-message",
            sessionId: SESSION_ID,
            role: "assistant",
            content: "cached content",
            timestamp: new Date().toISOString(),
        });
        chat.streamingMessageId[SESSION_ID] = "streaming-message";

        auth.logout();

        expect(chat.messages).toEqual({});
        expect(chat.streamingMessageId).toEqual({});
    });

    it("logout clears pending approvals owned by the previous user", () => {
        const auth = useAuthStore();
        auth.$patch({ token: "t", user: mockUser });
        const agent = useAgentStore();
        agent.addApprovalRequest({
            requestId: REQUEST_ID,
            runId: RUN_ID,
            sessionId: SESSION_ID,
            workspaceId: WORKSPACE_ID,
            tool: "write_file",
            action: "write",
            details: "/README.md",
        });
        agent.pendingApprovalSummaries = [
            {
                sessionId: SESSION_ID,
                workspaceId: WORKSPACE_ID,
                count: 1,
                oldestRequestedAt: new Date().toISOString(),
            },
        ];

        auth.logout();

        expect(agent.agentState.pendingApprovals).toEqual([]);
        expect(agent.pendingApprovalSummaries).toEqual([]);
    });

    it("userName falls back to email when name is missing", () => {
        const store = useAuthStore();
        store.$patch({ user: { id: "u2", email: "no-name@test.com" } as User });
        expect(store.userName).toBe("no-name@test.com");
    });

    // PLAN-0608 I6（预期变更）：登录响应里的 workspace 只是 **fallback**，绝不写进
    // tab 上下文——否则每个后续请求都会带着「回退值」冒充用户意图（review P0-1）。
    // 判据未削弱：仍然断言「不得写 localStorage」，并**加强**为「连 sessionStorage 也不得写」，
    // 另加一条 selectWorkspace 之后才允许写入的对照，防止把"什么都不写"当成实现。
    it("login never seeds the workspace context (fallback is not intent); selectWorkspace does", async () => {
        const { api } = await import("../../composables/api");
        vi.mocked(api.login).mockResolvedValue({
            accessToken: "tab-token",
            user: mockUser,
            workspaceId: WORKSPACE_ID,
        });
        vi.mocked(api.getWorkspace).mockResolvedValue({
            id: WORKSPACE_ID,
            name: "Default Workspace",
        });
        const store = useAuthStore();
        await store.login("tab@test.com", "pass");

        expect(sessionStorage.getItem("xihe-workspace")).toBeNull();
        expect(localStorage.getItem("xihe-workspace")).toBeNull();

        // 只写一次的通道是 selectWorkspace（用户显式选择），不是 login。
        const otherId = "55555555-5555-4555-8555-555555555555";
        vi.mocked(api.getWorkspace).mockResolvedValue({ id: otherId, name: "Other" });
        await store.selectWorkspace(otherId);
        expect(JSON.parse(sessionStorage.getItem("xihe-workspace") ?? "{}").id).toBe(otherId);
        expect(localStorage.getItem("xihe-workspace")).toBeNull();
    });

    it("migrates the legacy localStorage workspace once", () => {
        localStorage.setItem(
            "xihe-workspace",
            JSON.stringify({ id: WORKSPACE_ID, name: "Legacy" }),
        );
        const store = useAuthStore();
        expect(store.workspace?.id).toBe(WORKSPACE_ID);
        expect(sessionStorage.getItem("xihe-workspace")).toContain(WORKSPACE_ID);
        expect(localStorage.getItem("xihe-workspace")).toBeNull();
    });

    it("selectWorkspace writes the tab key and ignores a stale response", async () => {
        const { api } = await import("../../composables/api");
        const wsA = { id: WORKSPACE_ID, name: "A" };
        const wsB = { id: "55555555-5555-4555-8555-555555555555", name: "B" };
        vi.mocked(api.getWorkspace).mockImplementation(async (id: string) => {
            if (id === wsA.id) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return wsA;
            }
            return wsB;
        });
        const store = useAuthStore();
        const first = store.selectWorkspace(wsA.id);
        const second = store.selectWorkspace(wsB.id);
        await Promise.all([first, second]);
        expect(store.workspace?.id).toBe(wsB.id);
        expect(JSON.parse(sessionStorage.getItem("xihe-workspace") ?? "{}").id).toBe(wsB.id);
    });

    it("computes viewer read-only and editor write roles", () => {
        const store = useAuthStore();
        store.$patch({ workspace: { id: WORKSPACE_ID, name: "ws", workspaceRole: "VIEWER" } });
        expect(store.canWriteWorkspace).toBe(false);
        expect(store.canManageWorkspace).toBe(false);

        store.$patch({ workspace: { id: WORKSPACE_ID, name: "ws", workspaceRole: "EDITOR" } });
        expect(store.canWriteWorkspace).toBe(true);
        expect(store.canManageWorkspace).toBe(false);

        store.$patch({ workspace: { id: WORKSPACE_ID, name: "ws", workspaceRole: "OWNER" } });
        expect(store.canWriteWorkspace).toBe(true);
        expect(store.canManageWorkspace).toBe(true);
    });

    it("logout clears the tab workspace key", () => {
        const store = useAuthStore();
        sessionStorage.setItem("xihe-workspace", JSON.stringify({ id: WORKSPACE_ID }));
        store.logout();
        expect(sessionStorage.getItem("xihe-workspace")).toBeNull();
    });
});

describe("useAuthStore capabilities (PLAN-0610 W5a)", () => {
    it("derives isAdmin / isInstanceSuper from the capability projection, not from a role string", () => {
        const store = useAuthStore();
        store.$patch({
            user: {
                id: "u1",
                email: "a@test.com",
                capabilities: {
                    isInstanceAdmin: true,
                    isInstanceSuper: true,
                    workspaceAdminOf: [],
                },
            },
        });
        expect(store.isAdmin).toBe(true);
        expect(store.isInstanceSuper).toBe(true);
        expect(store.canClassifyTools).toBe(true);
    });

    it("treats a missing projection as 'no capability' (stale cached user)", () => {
        const store = useAuthStore();
        store.$patch({ user: { id: "u1", email: "a@test.com" } });
        expect(store.isAdmin).toBe(false);
        expect(store.isInstanceSuper).toBe(false);
        expect(store.canWorkspaceAdmin(WORKSPACE_ID)).toBe(false);
        // The retired wire field must not resurrect authority.
        expect((store.user as unknown as { role?: string })?.role).toBeUndefined();
    });

    it("canWorkspaceAdmin follows the explicit id list and the instance capability", () => {
        const store = useAuthStore();
        store.$patch({
            user: {
                id: "u1",
                email: "a@test.com",
                capabilities: {
                    isInstanceAdmin: false,
                    isInstanceSuper: false,
                    workspaceAdminOf: [WORKSPACE_ID],
                },
            },
        });
        expect(store.canWorkspaceAdmin(WORKSPACE_ID)).toBe(true);
        expect(store.canWorkspaceAdmin("55555555-5555-4555-8555-555555555555")).toBe(false);
        expect(store.canWorkspaceAdmin(null)).toBe(false);

        store.$patch({
            user: {
                id: "u1",
                email: "a@test.com",
                capabilities: {
                    isInstanceAdmin: true,
                    isInstanceSuper: false,
                    workspaceAdminOf: [],
                },
            },
        });
        // CP resolves canWorkspaceAdmin the same way: an instance admin administers every workspace.
        expect(store.canWorkspaceAdmin("55555555-5555-4555-8555-555555555555")).toBe(true);
    });

    it("refreshCapabilities replaces the cached user and persists it", async () => {
        localStorage.setItem("xihe-token", "token");
        localStorage.setItem(
            "xihe-user",
            JSON.stringify({ id: "u1", email: "a@test.com", capabilities: undefined }),
        );
        const { api } = await import("../../composables/api");
        vi.mocked(api.me).mockResolvedValue({
            id: "u1",
            email: "a@test.com",
            username: "tester",
            capabilities: { isInstanceAdmin: true, isInstanceSuper: false, workspaceAdminOf: [] },
        });
        const store = useAuthStore();
        expect(store.isAdmin).toBe(false);

        expect(await store.refreshCapabilities()).toBe(true);
        expect(store.isAdmin).toBe(true);
        expect(store.user?.username).toBe("tester");
        expect(
            JSON.parse(localStorage.getItem("xihe-user") ?? "{}").capabilities.isInstanceAdmin,
        ).toBe(true);
    });

    it("refreshCapabilities is a soft no-op without a token or on failure", async () => {
        const { api } = await import("../../composables/api");
        vi.mocked(api.me).mockReset();
        const store = useAuthStore();
        expect(await store.refreshCapabilities()).toBe(false);
        expect(api.me).not.toHaveBeenCalled();

        localStorage.setItem("xihe-token", "token");
        const authed = useAuthStore();
        authed.$patch({ token: "token" });
        vi.mocked(api.me).mockRejectedValue(new Error("offline"));
        expect(await authed.refreshCapabilities()).toBe(false);
        expect(authed.token).toBe("token");
    });
});

/**
 * PLAN-0651 T4.2 (D51-07): the settings permission surfaces are gated by the `MANAGE_ROLES`
 * **action atom** from `GET /me/permissions`. CP's gate is
 * `@requesterAuthority.holdsActionAtom('MANAGE_ROLES')` = membership in the instance-scope grant
 * atoms (`RequesterAuthority.actionAtoms` collects `actionClass` only — no resource matching), so
 * the store must (a) read `instancePermissions` and never `instanceCapabilities`, and (b) never let
 * a workspace-scope atom unlock an instance-scope surface.
 */
describe("useAuthStore self permission atoms (PLAN-0651 T4.2)", () => {
    const ATOM_WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";

    beforeEach(async () => {
        const { api } = await import("../../composables/api");
        vi.mocked(api.getSelfPermissions).mockReset();
    });

    function view(
        instancePermissions: { actionClass: string; resource: string }[],
        workspaces: {
            workspaceId: string;
            workspaceRole?: string | null;
            workspaceAdmin?: boolean;
            permissions?: { actionClass: string; resource: string }[];
        }[] = [],
        instanceCapabilities: string[] = [],
    ): apiModule.SelfPermissionsView {
        return { userId: "u1", instanceCapabilities, instancePermissions, workspaces };
    }

    it("derives canManageRoles from the MANAGE_ROLES instance atom", async () => {
        localStorage.setItem("xihe-token", "token");
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        expect(store.canManageRoles).toBe(false);

        vi.mocked(api.getSelfPermissions).mockResolvedValue(
            view([{ actionClass: "MANAGE_ROLES", resource: "*" }]),
        );
        expect(await store.ensureSelfPermissions()).toBe(true);
        expect(store.canManageRoles).toBe(true);
        expect(api.getSelfPermissions).toHaveBeenCalledTimes(1);
    });

    /**
     * task-74 的负例：实例内容读面与工具面写面的 CP 对端是**动作原子**
     * （`ConfigController.java:89-90` / `PolicyController.java:166-168`），
     * 不是 `cap:instance:admin`。所以「有 cap 无原子 ⇒ false」与「有原子无 cap ⇒ true」两个方向都要钉，
     * 否则下一个人按 `AGENTS.md`「禁止 isInstanceAdmin 特判」把这里改回能力位也不会红。
     */
    it("canReadInstanceContent / canManageWorkspacePolicy follow atoms, not the instance capability", async () => {
        localStorage.setItem("xihe-token", "token");
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        // 能力位为真（老 UI 会据此放行），但两个原子都没授予。
        store.$patch({
            user: {
                id: "u1",
                email: "a@test.com",
                capabilities: {
                    isInstanceAdmin: true,
                    isInstanceSuper: false,
                    workspaceAdminOf: [],
                },
            },
        });
        vi.mocked(api.getSelfPermissions).mockResolvedValue(view([]));
        expect(await store.ensureSelfPermissions()).toBe(true);
        expect(store.isAdmin).toBe(true);
        expect(store.canReadInstanceContent).toBe(false);
        expect(store.canManageWorkspacePolicy).toBe(false);

        // 反过来：原子在手、能力位为假 ⇒ 两个判据都为真（UI 不比 CP 严）。
        store.$patch({ selfPermissions: null });
        store.$patch({
            user: {
                id: "u1",
                email: "a@test.com",
                capabilities: {
                    isInstanceAdmin: false,
                    isInstanceSuper: false,
                    workspaceAdminOf: [],
                },
            },
        });
        vi.mocked(api.getSelfPermissions).mockResolvedValue(
            view([
                { actionClass: "READ_INSTANCE_CONTENT", resource: "*" },
                { actionClass: "MANAGE_WORKSPACE_POLICY", resource: "*" },
            ]),
        );
        expect(await store.ensureSelfPermissions()).toBe(true);
        expect(store.isAdmin).toBe(false);
        expect(store.canReadInstanceContent).toBe(true);
        expect(store.canManageWorkspacePolicy).toBe(true);
    });

    it("ignores instanceCapabilities and workspace-scope atoms", async () => {
        localStorage.setItem("xihe-token", "token");
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        vi.mocked(api.getSelfPermissions).mockResolvedValue(
            view(
                [],
                [
                    {
                        workspaceId: ATOM_WORKSPACE_ID,
                        workspaceRole: "OWNER",
                        workspaceAdmin: true,
                        permissions: [{ actionClass: "MANAGE_ROLES", resource: "*" }],
                    },
                ],
                // `instanceCapabilities` only carries the 3 capability atoms; a same-named entry
                // here must not stand in for the action atom.
                ["instance:admin", "MANAGE_ROLES"],
            ),
        );

        expect(await store.ensureSelfPermissions()).toBe(true);
        // The workspace-scope atom stays inside its workspace: it does not unlock the
        // instance-scope permission page (CP evaluates `holdsActionAtom` with workspaceId=null).
        expect(store.hasInstanceAtom("MANAGE_ROLES")).toBe(false);
        expect(store.canManageRoles).toBe(false);
    });

    it("treats an instance atom as membership, not as a resource wildcard", async () => {
        localStorage.setItem("xihe-token", "token");
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        vi.mocked(api.getSelfPermissions).mockResolvedValue(
            view([{ actionClass: "MANAGE_ROLES", resource: ATOM_WORKSPACE_ID }]),
        );

        expect(await store.ensureSelfPermissions()).toBe(true);
        // CP's `holdsActionAtom` is a set-contains over action classes (LayeredPolicyResolver's
        // resource matching belongs to `allowsForUser`, which this gate does not use).
        expect(store.canManageRoles).toBe(true);
    });

    it("shares one request between concurrent callers and caches the result", async () => {
        localStorage.setItem("xihe-token", "token");
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        vi.mocked(api.getSelfPermissions).mockResolvedValue(
            view([{ actionClass: "MANAGE_ROLES", resource: "*" }]),
        );

        const [first, second] = await Promise.all([
            store.ensureSelfPermissions(),
            store.ensureSelfPermissions(),
        ]);
        expect(first).toBe(true);
        expect(second).toBe(true);
        // A later mount reuses the loaded projection instead of re-fetching on every settings page.
        expect(await store.ensureSelfPermissions()).toBe(true);
        expect(api.getSelfPermissions).toHaveBeenCalledTimes(1);
    });

    it("fails closed on a failed projection and retries on the next call", async () => {
        localStorage.setItem("xihe-token", "token");
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        vi.mocked(api.getSelfPermissions).mockRejectedValueOnce(new Error("offline"));

        expect(await store.ensureSelfPermissions()).toBe(false);
        expect(store.selfPermissions).toBeNull();
        expect(store.canManageRoles).toBe(false);

        vi.mocked(api.getSelfPermissions).mockResolvedValue(
            view([{ actionClass: "MANAGE_ROLES", resource: "*" }]),
        );
        expect(await store.ensureSelfPermissions()).toBe(true);
        expect(store.canManageRoles).toBe(true);
        expect(api.getSelfPermissions).toHaveBeenCalledTimes(2);
    });

    it("does not fetch without a session and clears the projection on logout", async () => {
        const { api } = await import("../../composables/api"),
            store = useAuthStore();
        expect(await store.ensureSelfPermissions()).toBe(false);
        expect(api.getSelfPermissions).not.toHaveBeenCalled();

        // Same store, now with a session (e.g. adopted by the router guard).
        store.$patch({ token: "token" });
        vi.mocked(api.getSelfPermissions).mockResolvedValue(
            view([{ actionClass: "MANAGE_ROLES", resource: "*" }]),
        );
        expect(await store.ensureSelfPermissions()).toBe(true);
        expect(store.canManageRoles).toBe(true);

        store.logout();
        expect(store.selfPermissions).toBeNull();
        expect(store.canManageRoles).toBe(false);
    });
});
