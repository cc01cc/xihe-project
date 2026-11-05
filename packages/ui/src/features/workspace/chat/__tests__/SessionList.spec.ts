import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import type { toast as sonnerToast } from "vue-sonner";
import { i18n } from "../../../../i18n";
import { ApiError, api } from "../../../../composables/api";
import { useChatStore } from "../stores/chat.ts";
import { useSessionStore } from "../../../../stores/session";
import SessionItem from "../components/SessionItem.vue";
import SessionList from "../components/SessionList.vue";

const { toastError, toastSuccess } = vi.hoisted(() => ({
    toastError: vi.fn<typeof sonnerToast.error>(),
    toastSuccess: vi.fn<typeof sonnerToast.success>(),
}));
vi.mock("vue-sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BRANCH_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ANCHOR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CHILD_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function createTestRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: "/workspace/:workspaceId/chat/:sessionId",
                component: { setup: () => () => null },
            },
        ],
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
        sessionStore.sessions = [
            {
                id: SESSION_ID,
                title: "Source session",
                createdAt: "2026-09-29T00:00:00Z",
                updatedAt: "2026-09-29T00:00:00Z",
                workspaceId: WORKSPACE_ID,
                context: { agents: [] },
            },
        ];
        sessionStore.selectSession(SESSION_ID);

        const chatStore = useChatStore();
        chatStore.setSessionBranches(SESSION_ID, [
            {
                branchId: BRANCH_ID,
                parentBranchId: null,
                forkPointMessageId: null,
                forkPointRunId: null,
                createdAt: "2026-09-29T00:00:00Z",
            },
        ]);
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
        const forkSession = vi
            .spyOn(api, "forkSession")
            .mockRejectedValueOnce(
                new ApiError({
                    status: 409,
                    code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                    detail: "Retry this request",
                    requestId: "request-1",
                }),
            )
            .mockResolvedValueOnce({
                id: CHILD_ID,
                title: "Forked session",
                workspaceId: WORKSPACE_ID,
            });
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
        expect(toastError).toHaveBeenCalledWith(
            "IDEMPOTENCY_REQUEST_IN_PROGRESS: Retry this request",
        );
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

describe("SessionList delegation tree (PLAN-0655 T1.5)", () => {
    const PARENT_ID = "11111111-1111-4111-8111-111111111111";
    const DELEGATED_ID = "22222222-2222-4222-8222-222222222222";

    function usage() {
        return {
            rootSessionId: PARENT_ID,
            usedSessions: 1,
            maxCount: 1,
            currentDepth: 1,
            maxDepth: 2,
            principalId: "33333333-3333-4333-8333-333333333333",
            principalName: "Promo Agent B",
            policySource: "subject" as const,
            disabled: false,
        };
    }

    function baseSession(id: string, title: string) {
        return {
            id,
            title,
            createdAt: "2026-11-04T00:00:00Z",
            updatedAt: "2026-11-04T00:00:00Z",
            workspaceId: WORKSPACE_ID,
            context: { agents: [] },
        };
    }

    it("renders a delegated child indented under its parent with badge, chip and one usage fetch", async () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = [
            { ...baseSession(PARENT_ID, "Promo 启动"), kind: null, spawnedFromSessionId: null },
            {
                ...baseSession(DELEGATED_ID, "翻译校对"),
                kind: "SPAWN",
                spawnedFromSessionId: PARENT_ID,
            },
        ];
        const usageSpy = vi.spyOn(api, "delegationUsage").mockResolvedValue(usage());

        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
        await flushPromises();

        const rows = wrapper.findAll('[data-testid="session-item"]');
        expect(rows).toHaveLength(2);
        expect(rows[0].text()).toContain("Promo 启动");
        expect(rows[1].text()).toContain("翻译校对");
        expect(rows[1].get('[data-testid="session-delegated-badge"]').text()).toContain("委派");
        expect(rows[1].get('[data-testid="session-delegation-chip"]').text()).toContain(
            "Promo Agent B",
        );
        expect(rows[1].get('[data-testid="session-delegation-chip"]').text()).toContain("1/1");
        expect(rows[1].attributes("style") ?? "").toContain("padding-left: 2rem");
        expect(usageSpy).toHaveBeenCalledTimes(1);
        expect(usageSpy).toHaveBeenCalledWith(DELEGATED_ID);
        wrapper.unmount();
    });

    it("keeps a child row when its parent is not in the list (filtering never hides delegation)", async () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = [
            {
                ...baseSession(DELEGATED_ID, "翻译校对"),
                kind: "SPAWN",
                spawnedFromSessionId: "99999999-9999-4999-8999-999999999999",
            },
        ];
        vi.spyOn(api, "delegationUsage").mockResolvedValue(usage());

        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
        await flushPromises();

        const rows = wrapper.findAll('[data-testid="session-item"]');
        expect(rows).toHaveLength(1);
        expect(rows[0].text()).toContain("翻译校对");
        expect(rows[0].get('[data-testid="session-delegated-badge"]').exists()).toBe(true);
        expect(rows[0].attributes("style") ?? "").not.toContain("padding-left");
        wrapper.unmount();
    });

    // PLAN-0668 T2.4：三处消费点（会话树层级 / 委派徽标 / DAG 数据源）必须从
    // api.getSessions 的真实投影链路拿到 lineage，而不是靠测试直接塞 store 状态。
    it("keeps the api projection → session tree chain for delegated children (PLAN-0668 T2.4)", async () => {
        const wire = {
            sessions: [
                {
                    id: PARENT_ID,
                    title: "Promo 启动",
                    workspaceId: WORKSPACE_ID,
                    archived: false,
                    kind: null,
                    spawnedFromSessionId: null,
                    spawnedAt: null,
                    createdAt: "2026-11-05T00:00:00Z",
                    updatedAt: "2026-11-05T00:00:00Z",
                },
                {
                    id: DELEGATED_ID,
                    title: "翻译校对",
                    workspaceId: WORKSPACE_ID,
                    archived: false,
                    kind: "SPAWN",
                    spawnedFromSessionId: PARENT_ID,
                    spawnedAt: "2026-11-05T00:01:00Z",
                    createdAt: "2026-11-05T00:01:00Z",
                    updatedAt: "2026-11-05T00:01:00Z",
                },
            ],
        };
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(wire),
        } as Response);
        const response = await api.getSessions();
        fetchSpy.mockRestore();

        expect(response.sessions[1]).toMatchObject({
            id: DELEGATED_ID,
            kind: "SPAWN",
            spawnedFromSessionId: PARENT_ID,
            spawnedAt: "2026-11-05T00:01:00Z",
        });

        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = response.sessions;
        const usageSpy = vi.spyOn(api, "delegationUsage").mockResolvedValue(usage());

        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
        await flushPromises();

        const rows = wrapper.findAll('[data-testid="session-item"]');
        expect(rows).toHaveLength(2);
        expect(rows[1].get('[data-testid="session-delegated-badge"]').exists()).toBe(true);
        expect(rows[1].get('[data-testid="session-delegation-chip"]').text()).toContain(
            "Promo Agent B",
        );
        expect(rows[1].attributes("style") ?? "").toContain("padding-left: 2rem");
        expect(usageSpy).toHaveBeenCalledWith(DELEGATED_ID);
        wrapper.unmount();
    });
});
