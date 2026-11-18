import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import ChatPanel from "../components/ChatPanel.vue";
import SessionDerivedStatePanel from "../components/SessionDerivedStatePanel.vue";
import InputArea from "../components/InputArea.vue";
import { i18n } from "../../../../i18n";
import { api, ApiError, type ApiFollowUpQueueSnapshot } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { toast } from "vue-sonner";
import { useSessionStore } from "../../../../stores/session";
import type { SessionDerivedActiveChild } from "../../../../types";

/**
 * task-188 S3 L0：steer 插话入口（M4）。cp-1 钉形 wire：POST /sessions/{child}/steers +
 * Idempotency-Key + {text}；反假绿重点：入口只在有存活子会话时出现、steer 模式 send 改道
 * （不得落到普通消息发送）、逐码错误面留在原地。
 */

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
        warning: vi.fn<(message: string) => void>(),
        info: vi.fn<(message: string) => void>(),
    },
}));

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            // steer 通道（M4 被测件）
            steerSession: vi.fn<typeof api.steerSession>(),
            // 其余按 ChatPanel.spec 同款最小 mock；team-tasks 404 ⇒ 板静默不抢戏。
            getSessionTeamTasks: vi.fn<typeof api.getSessionTeamTasks>(),
            decideChatApproval: vi.fn<typeof api.decideChatApproval>(),
            getPendingApprovals: vi.fn<typeof api.getPendingApprovals>(),
            getMessages: vi.fn<typeof api.getMessages>(),
            getSessionBranches: vi.fn<typeof api.getSessionBranches>(),
            getFollowUpQueue: vi.fn<typeof api.getFollowUpQueue>(),
            enqueueFollowUp: vi.fn<typeof api.enqueueFollowUp>(),
            enqueueFollowUpDetailed: vi.fn<typeof api.enqueueFollowUpDetailed>(),
            withdrawFollowUp: vi.fn<typeof api.withdrawFollowUp>(),
            continueFollowUpQueue: vi.fn<typeof api.continueFollowUpQueue>(),
            getSessionDerivedState: vi.fn<typeof api.getSessionDerivedState>(),
            listSessionRuns: vi.fn<typeof api.listSessionRuns>(),
            getSessionDispatchQueue: vi.fn<typeof api.getSessionDispatchQueue>(),
            bindSessionDefaults: vi.fn<typeof api.bindSessionDefaults>(),
        },
    };
});

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROOT_BRANCH_ID = "44444444-4444-4444-8444-444444444444";

const CHILD: SessionDerivedActiveChild = {
    childSessionId: CHILD_ID,
    runId: "33333333-3333-4333-8333-333333333333",
    name: "ui-2",
    status: "waiting",
};

function followUpSnapshot(
    overrides: Partial<ApiFollowUpQueueSnapshot> = {},
): ApiFollowUpQueueSnapshot {
    return {
        sessionId: SESSION_ID,
        queueState: "empty",
        outstandingCount: 0,
        capacityLimit: 5,
        pauseReason: null,
        items: [],
        ...overrides,
    };
}

function testRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div />" } }],
    });
}

function mountPanel() {
    useSessionStore().applySessionRecord({
        id: SESSION_ID,
        title: "T",
        workspaceId: "workspace-1",
        agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
        modelProvider: "deepseek",
        modelName: "deepseek-flash",
        providerConnectionId: "conn-1",
        connectionRevision: 2,
        createdAt: "2026-11-04T10:00:00Z",
        updatedAt: "2026-11-04T10:00:00Z",
    } as never);

    return mount(ChatPanel, {
        props: { sessionId: SESSION_ID },
        global: {
            plugins: [i18n, testRouter()],
            stubs: {
                SSEStream: true,
                InputArea: true,
                MessageList: true,
                SessionPolicyControls: true,
                SessionContextTemplate: true,
                ContextSourcesU1: true,
            },
        },
    });
}

let wrapper: ReturnType<typeof mountPanel>;

beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    vi.mocked(api.bindSessionDefaults)
        .mockReset()
        .mockResolvedValue({
            id: SESSION_ID,
            title: "T",
            workspaceId: "workspace-1",
            agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
            modelProvider: "deepseek",
            modelName: "deepseek-flash",
            providerConnectionId: "conn-1",
            connectionRevision: 2,
            createdAt: "2026-11-04T10:00:00Z",
            updatedAt: "2026-11-04T10:00:00Z",
        } as never);
    vi.mocked(api.getPendingApprovals).mockReset().mockResolvedValue([]);
    vi.mocked(api.getMessages).mockReset().mockResolvedValue([]);
    vi.mocked(api.getSessionBranches)
        .mockReset()
        .mockResolvedValue({
            sessionId: SESSION_ID,
            items: [
                {
                    branchId: ROOT_BRANCH_ID,
                    parentBranchId: null,
                    forkPointMessageId: null,
                    forkPointRunId: null,
                    createdAt: "2026-09-29T00:00:00Z",
                },
            ],
        });
    vi.mocked(api.getFollowUpQueue).mockReset().mockResolvedValue(followUpSnapshot());
    vi.mocked(api.enqueueFollowUp).mockReset();
    vi.mocked(api.enqueueFollowUpDetailed).mockReset();
    vi.mocked(api.withdrawFollowUp).mockReset();
    vi.mocked(api.continueFollowUpQueue).mockReset();
    vi.mocked(api.getSessionDerivedState)
        .mockReset()
        .mockResolvedValue({
            sessionId: SESSION_ID,
            activeChildren: [CHILD],
            terminalNotices: [],
        });
    vi.mocked(api.listSessionRuns).mockReset().mockResolvedValue({
        sessionId: SESSION_ID,
        page: 0,
        size: 100,
        runs: [],
    });
    vi.mocked(api.getSessionDispatchQueue).mockReset().mockResolvedValue({
        sessionId: SESSION_ID,
        queue: [],
    });
    vi.mocked(api.getSessionTeamTasks)
        .mockReset()
        .mockRejectedValue(
            new ApiError({ status: 404, code: "MOCK_ENDPOINT_MISSING", requestId: "t" }),
        );
    vi.mocked(api.steerSession).mockReset();
});

describe("ChatPanel steer mode (task-188 S3)", () => {
    it("shows the entry only when the session has active children", async () => {
        wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-testid="steer-entry"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="steer-mode-banner"]').exists()).toBe(false);

        // 无存活子会话 ⇒ 入口不出现（Q5 的可视性判据 = 读面事实，不发明身份判定）。
        vi.mocked(api.getSessionDerivedState).mockResolvedValue({
            sessionId: SESSION_ID,
            activeChildren: [],
            terminalNotices: [],
        });
        await wrapper.findComponent(SessionDerivedStatePanel).vm.$emit("retry");
        await flushPromises();
        expect(wrapper.find('[data-testid="steer-entry"]').exists()).toBe(false);
    });

    it("enters steer mode with a target selector and cancels back out", async () => {
        wrapper = mountPanel();
        await flushPromises();

        await wrapper.get('[data-testid="steer-entry"]').trigger("click");
        const banner = wrapper.get('[data-testid="steer-mode-banner"]');
        expect(banner.text()).toContain(i18n.global.t("steer.modeTitle"));
        expect(banner.get("select").element.value).toBe(CHILD_ID);
        expect(wrapper.get('[data-testid="steer-target-select"]').text()).toContain("ui-2");
        expect(wrapper.find('[data-testid="steer-entry"]').exists()).toBe(false);

        await wrapper.get('[data-testid="steer-cancel"]').trigger("click");
        expect(wrapper.find('[data-testid="steer-mode-banner"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="steer-entry"]').exists()).toBe(true);
    });

    it("routes composer send to POST /steers (not the normal message path) and exits on 202", async () => {
        vi.mocked(api.steerSession).mockResolvedValue(followUpSnapshot());
        wrapper = mountPanel();
        await flushPromises();
        await wrapper.get('[data-testid="steer-entry"]').trigger("click");

        wrapper.findComponent(InputArea).vm.$emit("send", "先别合并，等我看完");
        await flushPromises();

        expect(api.steerSession).toHaveBeenCalledTimes(1);
        const [target, body, key] = vi.mocked(api.steerSession).mock.calls[0];
        expect(target).toBe(CHILD_ID);
        expect(body).toEqual({ text: "先别合并，等我看完" });
        expect(typeof key).toBe("string");
        expect(key.length).toBeGreaterThan(0);
        // 成功：toast + 退出模式。
        expect(toast.success).toHaveBeenCalledWith(i18n.global.t("steer.sent"));
        expect(wrapper.find('[data-testid="steer-mode-banner"]').exists()).toBe(false);
    });

    it("maps STEER_FORBIDDEN to an inline error and stays in mode (errors are not swallowed)", async () => {
        vi.mocked(api.steerSession).mockRejectedValue(
            new ApiError({ status: 403, code: "STEER_FORBIDDEN", requestId: "t" }),
        );
        wrapper = mountPanel();
        await flushPromises();
        await wrapper.get('[data-testid="steer-entry"]').trigger("click");

        wrapper.findComponent(InputArea).vm.$emit("send", "插话内容");
        await flushPromises();

        const error = wrapper.get('[data-testid="steer-error"]');
        expect(error.text()).toContain(i18n.global.t("steer.forbidden"));
        // 留在原地（AlertDialogAction 教训：失败不许无条件关面板）。
        expect(wrapper.find('[data-testid="steer-mode-banner"]').exists()).toBe(true);
        expect(toast.success).not.toHaveBeenCalled();
    });

    it("maps FOLLOW_UP_QUEUE_FULL to its own copy instead of a generic failure", async () => {
        vi.mocked(api.steerSession).mockRejectedValue(
            new ApiError({ status: 409, code: "FOLLOW_UP_QUEUE_FULL", requestId: "t" }),
        );
        wrapper = mountPanel();
        await flushPromises();
        await wrapper.get('[data-testid="steer-entry"]').trigger("click");

        wrapper.findComponent(InputArea).vm.$emit("send", "插话内容");
        await flushPromises();

        expect(wrapper.get('[data-testid="steer-error"]').text()).toContain(
            i18n.global.t("steer.queueFull"),
        );
    });

    it("rejects attachments with a toast and never calls the steer endpoint", async () => {
        wrapper = mountPanel();
        await flushPromises();
        await wrapper.get('[data-testid="steer-entry"]').trigger("click");

        wrapper.findComponent(InputArea).vm.$emit("send", "带附件的插话", [{}]);
        await flushPromises();

        expect(api.steerSession).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledWith(i18n.global.t("steer.attachmentsUnsupported"));
        expect(wrapper.find('[data-testid="steer-mode-banner"]').exists()).toBe(true);
    });
});
