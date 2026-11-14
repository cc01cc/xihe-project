import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

/**
 * task-601：ws-less（独立会话）上下文里的 approvals 身份泄漏。
 *
 * 卡面机制：`approvals/pending` 自己没有工作区头，头来自 `apiAuthHeaders` 的 tab 上下文兜底；
 * 进入 ws-less 时「清空」与「在途请求 / 迟到的写回」会交错 ⇒ ws-less 页上出现带非空
 * `X-Workspace-Id` 的请求（上一个工作区的待审批、MCP 握手）。
 *
 * 本 spec 钉三件（都对实现契约，不对时序细节）：
 *  1 上下文已清空 ⇒ `apiAuthHeaders()` 不再产出 `X-Workspace-Id`（ws-less 页 /api/* 不带旧身份）；
 *  2 反向控制：上下文在工作区里 ⇒ 仍带头（证明注入逻辑没被关掉）；
 *  3 `hydrateWorkspace` 在 await 期间被清空上下文时**不得写回**（消除「清空后被复活」的捕获源）。
 */

const apiMock = vi.hoisted(() => ({ getWorkspace: vi.fn<(id: string) => Promise<unknown>>() }));

vi.mock("../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../composables/api")>();
    return { ...actual, api: { ...actual.api, getWorkspace: apiMock.getWorkspace } };
});

vi.mock("../../services/chatTransport", () => ({
    subscribeChatTransport: () => Promise.resolve(),
    disconnectChatTransport: () => {},
}));

describe("task-601 approvals 不在 ws-less 上下文里带旧工作区身份", () => {
    beforeEach(() => {
        vi.resetModules();
        sessionStorage.clear();
        localStorage.clear();
        localStorage.setItem("xihe-token", "token-1");
        setActivePinia(createPinia());
    });

    afterEach(() => {
        sessionStorage.clear();
        localStorage.clear();
    });

    it("清空 tab 上下文后 apiAuthHeaders 不再带 X-Workspace-Id；有上下文时仍带", async () => {
        const { apiAuthHeaders } = await import("../../composables/api");
        const { clearTabWorkspace, writeTabWorkspaceId } =
            await import("../../lib/workspaceContext");

        writeTabWorkspaceId("11111111-1111-1111-1111-111111111111");
        expect(apiAuthHeaders()["X-Workspace-Id"]).toBe("11111111-1111-1111-1111-111111111111");

        clearTabWorkspace();
        expect(apiAuthHeaders()["X-Workspace-Id"]).toBeUndefined();
    });

    it("hydrateWorkspace 在 await 期间进入 ws-less 时不把旧工作区写回", async () => {
        const { useAuthStore } = await import("../../stores/auth");
        const { readTabWorkspaceId, writeTabWorkspaceId } =
            await import("../../lib/workspaceContext");
        const store = useAuthStore();

        writeTabWorkspaceId("22222222-2222-2222-2222-222222222222");
        let resolveWorkspace: (value: unknown) => void = () => {};
        apiMock.getWorkspace.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveWorkspace = resolve;
                }),
        );

        const pending = store.hydrateWorkspace();
        // 进入 ws-less：两份上下文一起清（enterWorkspaceless 做的就是这件事）。
        store.enterWorkspaceless();
        expect(readTabWorkspaceId()).toBeNull();

        resolveWorkspace({
            id: "22222222-2222-2222-2222-222222222222",
            name: "旧工作区",
            ownerId: "owner-1",
        });
        await pending;

        // 旧写法会把结果写回 ⇒ sessionStorage 被复活、后续请求重新带上旧身份。
        expect(readTabWorkspaceId()).toBeNull();
        expect(store.currentWorkspaceId).toBeNull();
    });
});
