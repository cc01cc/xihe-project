import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { i18n } from "../../../i18n";
import { ApiError, api } from "../../../composables/api";
import { useChatStore } from "../../../stores/chat";
import { useSessionStore } from "../../../stores/session";
import SessionItem from "../SessionItem.vue";
import SessionList from "../SessionList.vue";

const { toastError, toastSuccess } = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("vue-sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BRANCH_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ANCHOR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CHILD_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function createTestRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [{
            path: "/workspace/:workspaceId/chat/:sessionId",
            component: { setup: () => () => null },
        }],
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    toastError.mockClear();
    toastSuccess.mockClear();
});

describe("SessionList parent-child deletion warning (PLAN-0408 T3.2)", () => {
    it("warns that spawned children continue, and deletes only after confirmation", async () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = [
            {
                id: SESSION_ID,
                title: "Parent session",
                createdAt: "2026-09-27T00:00:00Z",
                updatedAt: "2026-09-27T00:00:00Z",
                workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                context: { agents: [] },
            },
        ];
        const deleteSession = vi.spyOn(sessionStore, "deleteSession").mockResolvedValue();
        const clearSession = vi.spyOn(useChatStore(), "clearSession");
        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
        const item = wrapper.findComponent(SessionItem);

        item.vm.$emit("delete", SESSION_ID);
        await flushPromises();

        expect(wrapper.get('[data-testid="session-delete-warning"]').text()).toContain(
            "由它派生的子会话和运行会保留，并可继续独立运行",
        );
        expect(deleteSession).not.toHaveBeenCalled();

        await wrapper.get('[data-testid="session-delete-cancel"]').trigger("click");
        expect(deleteSession).not.toHaveBeenCalled();

        item.vm.$emit("delete", SESSION_ID);
        await flushPromises();
        await wrapper.get('[data-testid="session-delete-confirm"]').trigger("click");
        await flushPromises();

        expect(deleteSession).toHaveBeenCalledWith(SESSION_ID);
        expect(clearSession).toHaveBeenCalledWith(SESSION_ID);
        wrapper.unmount();
    });
});

describe("SessionList current-session fork action", () => {
    it("uses the selected server branch and a visible canonical terminal message, reusing its key on retry", async () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = [{
            id: SESSION_ID,
            title: "Source session",
            createdAt: "2026-09-29T00:00:00Z",
            updatedAt: "2026-09-29T00:00:00Z",
            workspaceId: WORKSPACE_ID,
            context: { agents: [] },
        }];
        sessionStore.selectSession(SESSION_ID);

        const chatStore = useChatStore();
        chatStore.setSessionBranches(SESSION_ID, [{
            branchId: BRANCH_ID,
            parentBranchId: null,
            forkPointMessageId: null,
            forkPointRunId: null,
            createdAt: "2026-09-29T00:00:00Z",
        }]);
        chatStore.loadMessages(SESSION_ID, [
            {
                id: ANCHOR_ID,
                sessionId: SESSION_ID,
                role: "user",
                content: "Visible persisted prompt",
                timestamp: "2026-09-29T00:00:00Z",
                runId: "run-anchor",
                runStatus: "succeeded",
            },
            {
                id: "optimistic-client-id",
                sessionId: SESSION_ID,
                role: "assistant",
                content: "Local optimistic content",
                timestamp: "2026-09-29T00:00:01Z",
                runId: "run-local",
                runStatus: "succeeded",
            },
        ]);

        const router = createTestRouter();
        await router.push(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        await router.isReady();
        const wrapper = mount(SessionList, {
            global: { plugins: [i18n, router], stubs: { Teleport: true } },
        });

        vi.spyOn(api, "getMessages").mockResolvedValue([
            {
                id: ANCHOR_ID,
                sessionId: SESSION_ID,
                role: "USER",
                content: "Visible persisted prompt",
                createdAt: "2026-09-29T00:00:00Z",
                runId: "run-anchor",
                runStatus: "succeeded",
            },
            {
                id: "server-only-message",
                sessionId: SESSION_ID,
                role: "ASSISTANT",
                content: "Not currently visible",
                createdAt: "2026-09-29T00:00:02Z",
                runId: "run-server-only",
                runStatus: "succeeded",
            },
        ]);
        const forkSession = vi.spyOn(api, "forkSession")
            .mockRejectedValueOnce(new ApiError({
                status: 409,
                code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                detail: "Retry this request",
                requestId: "request-1",
            }))
            .mockResolvedValueOnce({ id: CHILD_ID, title: "Forked session", workspaceId: WORKSPACE_ID });
        vi.spyOn(api, "getSessions").mockResolvedValue({
            sessions: [
                { id: SESSION_ID, title: "Source session", workspaceId: WORKSPACE_ID },
                { id: CHILD_ID, title: "Forked session", workspaceId: WORKSPACE_ID },
            ],
        });

        const item = wrapper.findComponent(SessionItem);
        const clickFork = async () => {
            await item.get('[data-testid="session-item"]').trigger("contextmenu");
            await item.get('[data-testid="session-item-fork"]').trigger("click");
            await flushPromises();
        };

        await clickFork();
        expect(toastError).toHaveBeenCalledWith("IDEMPOTENCY_REQUEST_IN_PROGRESS: Retry this request");
        await clickFork();

        expect(api.getMessages).toHaveBeenCalledWith(SESSION_ID, BRANCH_ID);
        expect(forkSession).toHaveBeenCalledTimes(2);
        expect(forkSession).toHaveBeenNthCalledWith(
            1,
            SESSION_ID,
            { sourceBranchId: BRANCH_ID, anchorMessageId: ANCHOR_ID },
            expect.any(String),
        );
        expect(forkSession.mock.calls[1]?.[2]).toBe(forkSession.mock.calls[0]?.[2]);
        expect(sessionStore.currentSessionId).toBe(CHILD_ID);
        expect(router.currentRoute.value.path).toBe(`/workspace/${WORKSPACE_ID}/chat/${CHILD_ID}`);
        expect(toastSuccess).toHaveBeenCalledWith("已创建并打开分叉会话");
        wrapper.unmount();
    });
});
