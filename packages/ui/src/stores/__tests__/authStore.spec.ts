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
        getWorkspace: vi.fn<typeof apiModule.api.getWorkspace>(),
        getCurrentWorkspace: vi.fn<typeof apiModule.api.getCurrentWorkspace>(),
    },
    onAuthTokensRefreshed: vi.fn<(cb: (accessToken: string) => void) => void>(),
    registerForceLogout: vi.fn<(fn: () => void) => void>(),
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

    it("login stores the workspace in sessionStorage, never localStorage", async () => {
        const { api } = await import("../../composables/api");
        vi.mocked(api.login).mockResolvedValue({
            accessToken: "tab-token",
            user: mockUser,
            workspaceId: WORKSPACE_ID,
        });
        const store = useAuthStore();
        await store.login("tab@test.com", "pass");

        expect(JSON.parse(sessionStorage.getItem("xihe-workspace") ?? "{}").id).toBe(WORKSPACE_ID);
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
