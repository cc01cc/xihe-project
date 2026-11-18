import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { useSessionStore } from "../../../../stores/session";
import ChatPanel from "../components/ChatPanel.vue";
import ApprovalModal from "../components/ApprovalModal.vue";
import SessionDerivedStatePanel from "../components/SessionDerivedStatePanel.vue";
import SSEStream from "../components/SSEStream.vue";
import MessageList from "../components/MessageList.vue";
import InputArea from "../components/InputArea.vue";
import { i18n } from "../../../../i18n";
import { api, ApiError, type ApiFollowUpQueueSnapshot } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { toast } from "vue-sonner";
import { useAgentStore } from "../../../../stores/agent";
import { useChatStore } from "../stores/chat.ts";
import type { ApprovalRequest, SessionDerivedStateResponse } from "../../../../types";

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
            decideChatApproval: vi.fn<typeof api.decideChatApproval>(),
            getPendingApprovals: vi.fn<typeof api.getPendingApprovals>(),
            getMessages: vi.fn<typeof api.getMessages>(),
            getSessionBranches: vi.fn<typeof api.getSessionBranches>(),
            createSessionBranch: vi.fn<typeof api.createSessionBranch>(),
            getFollowUpQueue: vi.fn<typeof api.getFollowUpQueue>(),
            enqueueFollowUp: vi.fn<typeof api.enqueueFollowUp>(),
            enqueueFollowUpDetailed: vi.fn<typeof api.enqueueFollowUpDetailed>(),
            withdrawFollowUp: vi.fn<typeof api.withdrawFollowUp>(),
            continueFollowUpQueue: vi.fn<typeof api.continueFollowUpQueue>(),
            getSessionDerivedState: vi.fn<typeof api.getSessionDerivedState>(),
            listSessionRuns: vi.fn<typeof api.listSessionRuns>(),
            getSessionDispatchQueue: vi.fn<typeof api.getSessionDispatchQueue>(),
            bindSessionDefaults: vi.fn<typeof api.bindSessionDefaults>(),
            // task-29：首条消息后的那一次会话重读走这里，必须可计数（否则测不到「只读一次」）。
            getSession: vi.fn<typeof api.getSession>(),
        },
    };
});

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const STALE_REQUEST_ID = "22222222-2222-4222-8222-222222222222",
    RUN_ID = "33333333-3333-4333-8333-333333333333";
const ROOT_BRANCH_ID = "44444444-4444-4444-8444-444444444444";

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

function queuedFollowUpSnapshot(content: string): ApiFollowUpQueueSnapshot {
    return followUpSnapshot({
        queueState: "queued",
        outstandingCount: 1,
        items: [
            {
                queueItemId: "77777777-7777-4777-8777-777777777777",
                queueSequence: 1,
                status: "queued",
                content,
                attachments: [],
                branchId: ROOT_BRANCH_ID,
                anchorRunId: RUN_ID,
                pauseReason: null,
                childRunId: null,
                childMessageId: null,
                createdAt: "2026-10-06T00:00:00Z",
                updatedAt: "2026-10-06T00:00:00Z",
            },
        ],
    });
}

const approval: ApprovalRequest = {
    requestId: REQUEST_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    tool: "write_file",
    action: "write file",
    details: "/test.txt",
    state: "pending",
    policy: {
        effect: "ask",
        sourceLayer: "workspace",
        matchedRule: null,
        reason: "No matching allow rule",
        mode: "manual",
        actionClass: "write",
        shape: "structured",
    },
};

/**
 * 挂载 ChatPanel。
 *
 * `attachedTo` 只在**焦点用例**里传 `document.body`：jsdom 对脱离文档树的元素调用 `focus()`
 * 不会改变 `document.activeElement`，不挂载就测不到"焦点去哪了"（BL-328）。
 */
/**
 * 最小 router：`useComposeDeeplink`（BL-339）在 setup 期调用 `useRouter()`，
 * 缺注入会让整个 spec 的 28 个用例在 mount 阶段抛
 * `TypeError: Cannot read properties of undefined (reading 'currentRoute')`（2026-11-06 实测基线红）。
 * 这里给一个内存 router 兜住注入，路由能力本身不在本 spec 的验证范围内。
 */
function testRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div />" } }],
    });
}

function mountPanel(attachedTo?: HTMLElement) {
    // C1：这些用例钉 enqueue/branch 契约，不是"未绑定引导"——种子一个已绑会话，让守卫零开销放行
    // （未绑定路径由 ensureProviderBinding.spec / mock e2e 单独覆盖）。
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
        // BL-328：焦点用例必须挂到 `document`，否则 jsdom 里 `element.focus()` 不生效
        // （脱离文档树的元素调用 focus 后 `document.activeElement` 仍是 body）。
        attachTo: attachedTo,
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

beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(api.bindSessionDefaults).mockReset().mockResolvedValue({
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
    });
    vi.mocked(api.decideChatApproval).mockReset();
    vi.mocked(api.getPendingApprovals).mockReset();
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
    vi.mocked(api.getMessages).mockReset();
    vi.mocked(api.getMessages).mockResolvedValue([]);
    vi.mocked(api.getSessionBranches).mockReset();
    vi.mocked(api.getSessionBranches).mockResolvedValue({
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
    vi.mocked(api.createSessionBranch).mockReset();
    vi.mocked(api.getFollowUpQueue).mockReset().mockResolvedValue(followUpSnapshot());
    vi.mocked(api.enqueueFollowUp).mockReset();
    vi.mocked(api.enqueueFollowUpDetailed).mockReset();
    vi.mocked(api.withdrawFollowUp).mockReset();
    vi.mocked(api.continueFollowUpQueue).mockReset();
    vi.mocked(api.getSessionDerivedState).mockReset();
    vi.mocked(api.getSessionDerivedState).mockResolvedValue({
        sessionId: SESSION_ID,
        activeChildren: [],
        terminalNotices: [],
    });
    vi.mocked(api.listSessionRuns).mockReset();
    vi.mocked(api.getSessionDispatchQueue).mockReset().mockResolvedValue({
        sessionId: SESSION_ID,
        queue: [],
    });
    vi.mocked(api.listSessionRuns).mockResolvedValue({
        sessionId: SESSION_ID,
        page: 0,
        size: 100,
        runs: [],
    });
    // task-29：默认给一份「重读回来的会话」，让不关心这条路径的用例（task-49 发送边界）
    // 不会因为重读拿到 undefined 而多打一行 warn。
    vi.mocked(api.getSession).mockReset().mockResolvedValue({
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
    });
});

describe("ChatPanel approval decision correlation (PLAN-0328 T1.14)", () => {
    it("ignores a decision whose requestId is not the actionable pending request", async () => {
        const decideChatApproval = vi.mocked(api.decideChatApproval);
        decideChatApproval.mockResolvedValue({
            status: "accepted",
            requestId: REQUEST_ID,
            approved: true,
            decision: "once",
        });
        const wrapper = mountPanel();
        useAgentStore().addApprovalRequest(approval);
        await nextTick();
        await flushPromises();

        const modal = wrapper.findComponent(ApprovalModal);
        expect(modal.exists()).toBe(true);
        modal.vm.$emit("approve", { decision: "once", requestId: STALE_REQUEST_ID });
        await flushPromises();

        // A stale continuation can never approve a different (or no longer actionable) request.
        expect(decideChatApproval).not.toHaveBeenCalled();
        // The dropped event must not leave the panel busy: the real request still decides.
        await wrapper.find('[data-testid="approval-approve"]').trigger("click");
        await flushPromises();
        expect(decideChatApproval).toHaveBeenCalledTimes(1);
        expect(decideChatApproval).toHaveBeenCalledWith(REQUEST_ID, { decision: "once" });
    });

    it("marks a queued decision with its CP-reported position and jumps to the run (task-161 / D-1785)", async () => {
        // task-161：决定已作出但会话执行数到 cap ⇒ CP 返回 status=queued，位置来自
        // GET /chat/sessions/{id}/dispatch-queue（position 0 = 前面没有别人）。
        vi.mocked(api.decideChatApproval).mockResolvedValue({
            status: "queued",
            requestId: REQUEST_ID,
            approved: true,
            decision: "once",
            propagated: 0,
        });
        vi.mocked(api.getSessionDispatchQueue).mockResolvedValue({
            sessionId: SESSION_ID,
            queue: [{ runId: RUN_ID, position: 1 }],
        });
        const wrapper = mountPanel();
        useAgentStore().addApprovalRequest(approval);
        await nextTick();
        await flushPromises();

        await wrapper.find('[data-testid="approval-approve"]').trigger("click");
        await flushPromises();

        const notice = wrapper.find('[data-testid="dispatch-queue-notice"]');
        expect(notice.exists()).toBe(true);
        // 位置是事实：文案里的数字就是 CP 给的 position，不是本地推算的顺序。
        expect(notice.text()).toContain("1");

        // 跳转目标：消息列表的 run 头（data-run-id）。方位由实现负责，这里只钉"点了会跳"。
        const target = document.createElement("div");
        target.setAttribute("data-run-id", RUN_ID);
        target.scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
        document.body.append(target);

        await wrapper.find(`[data-testid="dispatch-queue-jump-${RUN_ID}"]`).trigger("click");

        expect(target.scrollIntoView).toHaveBeenCalled();
        target.remove();
    });

    it("shows the serial queue progress (1/N) and only the first approval (PLAN-0665 M2 D5)", async () => {
        const wrapper = mountPanel();
        useAgentStore().addApprovalRequest(approval);
        useAgentStore().addApprovalRequest({
            ...approval,
            requestId: "req-second",
            runId: "run-second",
        });
        await nextTick();
        await flushPromises();

        const modal = wrapper.findComponent(ApprovalModal);
        expect(modal.exists()).toBe(true);
        // 只弹队首；第二张留在队列里等第一张决定后再弹（串行，不批量）。
        expect(modal.props("approval")?.requestId).toBe(REQUEST_ID);
        expect(modal.props("queueTotal")).toBe(2);
        expect(wrapper.findAll('[data-testid="approval-tool"]')).toHaveLength(1);
    });

    it("strips the requestId envelope before calling the decision API", async () => {
        const decideChatApproval = vi.mocked(api.decideChatApproval);
        decideChatApproval.mockResolvedValue({
            status: "accepted",
            requestId: REQUEST_ID,
            approved: true,
            decision: "session",
        });
        const wrapper = mountPanel();
        useAgentStore().addApprovalRequest(approval);
        await nextTick();
        await flushPromises();

        await wrapper.find('[data-testid="approval-allow-session"]').trigger("click");
        await flushPromises();

        expect(decideChatApproval).toHaveBeenCalledTimes(1);
        expect(decideChatApproval).toHaveBeenCalledWith(REQUEST_ID, { decision: "session" });
    });
});

describe("ChatPanel approval terminal states (PLAN-0663 M2)", () => {
    function apiProblem(code: string, status: number): ApiError {
        return new ApiError({
            type: "about:blank",
            title: "problem",
            status,
            code,
            detail: code,
            requestId: "00000000-0000-4000-8000-0000000000ff",
        } as never);
    }

    async function mountWithPendingApproval() {
        const wrapper = mountPanel();
        useAgentStore().addApprovalRequest(approval);
        await nextTick();
        await flushPromises();
        expect(wrapper.findComponent(ApprovalModal).exists()).toBe(true);
        return wrapper;
    }

    it("closes the modal after an accepted approve decision", async () => {
        vi.mocked(api.decideChatApproval).mockResolvedValue({
            status: "accepted",
            requestId: REQUEST_ID,
            approved: true,
            decision: "once",
        });
        const wrapper = await mountWithPendingApproval();

        await wrapper.find('[data-testid="approval-approve"]').trigger("click");
        await flushPromises();
        await nextTick();

        expect(wrapper.findComponent(ApprovalModal).props("show")).toBe(false);
    });

    it("closes the modal after an accepted reject decision", async () => {
        vi.mocked(api.decideChatApproval).mockResolvedValue({
            status: "accepted",
            requestId: REQUEST_ID,
            approved: false,
            decision: "once",
        });
        const wrapper = await mountWithPendingApproval();

        await wrapper.find('[data-testid="approval-reject"]').trigger("click");
        await flushPromises();
        await nextTick();

        expect(wrapper.findComponent(ApprovalModal).props("show")).toBe(false);
    });

    it("retires an EXPIRED approval, closes the modal and explains it non-modally", async () => {
        // PLAN-0663 T2.1: `expired` is terminal — the modal must not keep asking for a decision that
        // can no longer be taken; the reason is surfaced through the existing toast channel.
        vi.mocked(api.decideChatApproval).mockRejectedValue(apiProblem("APPROVAL_EXPIRED", 410));
        const wrapper = await mountWithPendingApproval();

        await wrapper.find('[data-testid="approval-approve"]').trigger("click");
        await flushPromises();
        await nextTick();
        await nextTick();

        expect(wrapper.findComponent(ApprovalModal).props("show")).toBe(false);
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("过期"));
    });
});

describe("ChatPanel branch actions", () => {
    it("creates a branch from a message, reloads the list and selects the result", async () => {
        const anchorMessageId = "55555555-5555-4555-8555-555555555555";
        const childBranchId = "66666666-6666-4666-8666-666666666666";
        const root = {
            branchId: ROOT_BRANCH_ID,
            parentBranchId: null,
            forkPointMessageId: null,
            forkPointRunId: null,
            createdAt: "2026-09-29T00:00:00Z",
        };
        const child = {
            branchId: childBranchId,
            parentBranchId: ROOT_BRANCH_ID,
            forkPointMessageId: anchorMessageId,
            forkPointRunId: RUN_ID,
            createdAt: "2026-09-29T00:01:00Z",
        };
        vi.mocked(api.getSessionBranches)
            .mockReset()
            .mockResolvedValueOnce({ sessionId: SESSION_ID, items: [root] })
            .mockResolvedValueOnce({ sessionId: SESSION_ID, items: [root, child] });
        vi.mocked(api.createSessionBranch).mockReset().mockResolvedValue({
            branchId: childBranchId,
            parentBranchId: ROOT_BRANCH_ID,
            forkPointMessageId: anchorMessageId,
        });
        vi.mocked(api.getMessages).mockResolvedValue([
            {
                id: anchorMessageId,
                sessionId: SESSION_ID,
                role: "ASSISTANT",
                content: "terminal anchor",
                createdAt: "2026-09-29T00:00:00Z",
                runId: RUN_ID,
                runStatus: "succeeded",
                attachments: [],
            },
        ]);
        useChatStore().addMessage(SESSION_ID, {
            id: anchorMessageId,
            sessionId: SESSION_ID,
            role: "assistant",
            content: "terminal anchor",
            timestamp: "2026-09-29T00:00:00Z",
            runId: RUN_ID,
            runStatus: "succeeded",
        });

        const wrapper = mountPanel();
        await flushPromises();
        wrapper.findComponent(MessageList).vm.$emit("branch", anchorMessageId);
        await flushPromises();

        expect(api.createSessionBranch).toHaveBeenCalledWith(
            SESSION_ID,
            { sourceBranchId: ROOT_BRANCH_ID, anchorMessageId },
            expect.any(String),
        );
        expect(useChatStore().getSelectedBranchId(SESSION_ID)).toBe(childBranchId);
        wrapper.unmount();
    });

    it("replaces optimistic streaming IDs with canonical persisted message IDs on terminal", async () => {
        const canonicalId = "77777777-7777-4777-8777-777777777777";
        vi.mocked(api.getMessages).mockResolvedValue([
            {
                id: canonicalId,
                sessionId: SESSION_ID,
                role: "ASSISTANT",
                content: "persisted answer",
                createdAt: "2026-09-29T00:00:00Z",
                runId: RUN_ID,
                runStatus: "succeeded",
                attachments: [],
            },
        ]);
        const wrapper = mountPanel();
        await flushPromises();
        const store = useChatStore();
        store.setSessionRunState(SESSION_ID, "thinking", RUN_ID);
        store.addMessage(SESSION_ID, {
            id: "client-stream-id",
            sessionId: SESSION_ID,
            role: "assistant",
            content: "streaming answer",
            timestamp: "2026-09-29T00:00:00Z",
            runId: RUN_ID,
            branchId: ROOT_BRANCH_ID,
            runStatus: "streaming",
        });
        expect(store.isStreaming(SESSION_ID)).toBe(true);
        await nextTick();

        store.setSessionRunState(SESSION_ID, "idle");
        expect(store.isStreaming(SESSION_ID)).toBe(false);
        await nextTick();
        await flushPromises();

        expect(api.getMessages).toHaveBeenLastCalledWith(
            SESSION_ID,
            ROOT_BRANCH_ID,
            expect.objectContaining({ limit: expect.any(Number) }),
        );
        expect(store.getMessages(SESSION_ID).map((message) => message.id)).toEqual([canonicalId]);
        wrapper.unmount();
    });

    it("keeps the terminal error detail through a history refresh (PLAN-0492)", async () => {
        const canonicalId = "88888888-8888-4888-8888-888888888888";
        vi.mocked(api.getMessages).mockResolvedValue([
            {
                id: canonicalId,
                sessionId: SESSION_ID,
                role: "ASSISTANT",
                content: "partial answer",
                createdAt: "2026-10-12T00:00:00Z",
                runId: RUN_ID,
                runStatus: "failed",
                terminalOutcome: "error",
                errorCode: "RUN_BUDGET_EXHAUSTED",
                errorDetail: "budgetDimension=tokens",
                attachments: [],
            },
        ]);
        const wrapper = mountPanel();
        await flushPromises();

        const refreshed = useChatStore()
            .getMessages(SESSION_ID)
            .find((message) => message.id === canonicalId);
        expect(refreshed?.errorCode).toBe("RUN_BUDGET_EXHAUSTED");
        expect(refreshed?.error).toBe("budgetDimension=tokens");
        wrapper.unmount();
    });

    // PLAN-0572 / BL-555 G3：快照截断态随历史 DTO 映射进 Message（渲染侧据此显示 N/M）。
    it("carries the persisted toolCalls truncation state through a history refresh", async () => {
        const canonicalId = "aaaaaaaa-1111-4111-8111-111111111111";
        vi.mocked(api.getMessages).mockResolvedValue([
            {
                id: canonicalId,
                sessionId: SESSION_ID,
                role: "ASSISTANT",
                content: "",
                createdAt: "2026-11-10T00:00:00Z",
                runId: RUN_ID,
                runStatus: "succeeded",
                attachments: [],
                toolCalls: [
                    {
                        id: "tc-persisted-1",
                        name: "read_file",
                        arguments: "{}",
                        status: "completed",
                    },
                ],
                toolCallsTruncated: true,
                toolCallsTotal: 250,
            },
        ]);
        const wrapper = mountPanel();
        await flushPromises();

        const refreshed = useChatStore()
            .getMessages(SESSION_ID)
            .find((message) => message.id === canonicalId);
        expect(refreshed?.toolCallsTruncated).toBe(true);
        expect(refreshed?.toolCallsTotal).toBe(250);
        expect(refreshed?.toolCalls).toHaveLength(1);
        wrapper.unmount();
    });

    /**
     * PLAN-0761 (BL-555): the user-visible symptom is "a session reload loses the thinking".
     * This pins the history path end-to-end at the panel level — a persisted assistant Message
     * carrying `reasoning` must re-render as a thinking part after a refresh, and a pre-V150
     * row (no field) must render none.
     */
    it("replays persisted reasoning after a history refresh (PLAN-0761 / BL-555)", async () => {
        const reasoningId = "99999999-9999-4999-8999-999999999999";
        const legacyId = "99999999-9999-4999-8999-888888888888";
        vi.mocked(api.getMessages).mockResolvedValue([
            {
                id: reasoningId,
                sessionId: SESSION_ID,
                role: "ASSISTANT",
                content: "persisted answer",
                reasoning: "思考过程第一行\n思考过程第二行",
                createdAt: "2026-11-10T00:00:00Z",
                runId: RUN_ID,
                runStatus: "succeeded",
                attachments: [],
            },
            {
                id: legacyId,
                sessionId: SESSION_ID,
                role: "ASSISTANT",
                content: "pre-V150 answer",
                createdAt: "2026-11-01T00:00:00Z",
                runId: RUN_ID,
                runStatus: "succeeded",
                attachments: [],
            },
        ]);
        const wrapper = mountPanel();
        await flushPromises();

        const messages = useChatStore().getMessages(SESSION_ID);
        const withReasoning = messages.find((message) => message.id === reasoningId);
        expect(withReasoning?.parts).toEqual([
            { type: "reasoning", content: "思考过程第一行\n思考过程第二行" },
            { type: "text", content: "persisted answer" },
        ]);

        // A pre-V150 row keeps the "no reasoning ⇒ no thinking block" path.
        const legacy = messages.find((message) => message.id === legacyId);
        expect(legacy?.parts ?? []).toEqual([{ type: "text", content: "pre-V150 answer" }]);
        wrapper.unmount();
    });
});

describe("ChatPanel approval dismiss and reopen pill (PLAN-0404)", () => {
    it("dismisses locally with zero decisions and reopens from the pill", async () => {
        const decideChatApproval = vi.mocked(api.decideChatApproval);
        decideChatApproval.mockResolvedValue({
            status: "accepted",
            requestId: REQUEST_ID,
            approved: true,
            decision: "once",
        });
        const wrapper = mountPanel();
        useAgentStore().addApprovalRequest(approval);
        await nextTick();
        await flushPromises();

        const modal = wrapper.findComponent(ApprovalModal);
        expect(modal.props("show")).toBe(true);

        modal.vm.$emit("dismiss");
        await nextTick();

        expect(decideChatApproval).not.toHaveBeenCalled();
        expect(modal.props("show")).toBe(false);
        const pill = wrapper.find('[data-testid="pending-approval-reopen-pill"]');
        expect(pill.exists()).toBe(true);
        expect(pill.attributes("type")).toBe("button");
        expect((pill.text() ?? "").trim().length).toBeGreaterThan(0);

        await pill.trigger("click");
        await nextTick();

        expect(modal.props("show")).toBe(true);
        expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(false);

        await wrapper.find('[data-testid="approval-approve"]').trigger("click");
        await flushPromises();

        expect(decideChatApproval).toHaveBeenCalledTimes(1);
        expect(decideChatApproval).toHaveBeenCalledWith(REQUEST_ID, { decision: "once" });
    });

    it("keeps the dispatch_unknown recovery entry shown after a dismiss", async () => {
        const wrapper = mountPanel();
        useAgentStore().addApprovalRequest({ ...approval, state: "dispatch_unknown" });
        await nextTick();
        await flushPromises();

        const modal = wrapper.findComponent(ApprovalModal);
        expect(modal.props("show")).toBe(true);

        modal.vm.$emit("dismiss");
        await nextTick();

        expect(modal.props("show")).toBe(true);
        expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(false);
        expect(vi.mocked(api.decideChatApproval)).not.toHaveBeenCalled();
    });

    // PLAN-0631 M1-C: a decision that can no longer be taken must not keep asking for one.
    it("retires the reopen pill once the approval's run is terminal", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        useChatStore().addMessage(SESSION_ID, {
            id: "message-terminal",
            sessionId: SESSION_ID,
            role: "assistant",
            content: "cancelled before deciding",
            timestamp: "2026-11-02T00:00:00Z",
            runId: RUN_ID,
            runStatus: "cancelled",
            terminalOutcome: "cancelled",
        });
        useAgentStore().addApprovalRequest(approval);
        await nextTick();
        await flushPromises();

        const modal = wrapper.findComponent(ApprovalModal);
        expect(modal.props("show")).toBe(true);
        modal.vm.$emit("dismiss");
        await nextTick();

        // Dismissal still closes the modal (it never means reject) …
        expect(modal.props("show")).toBe(false);
        // … but there is no way back in: the Run is over, the decision is moot.
        expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(false);
    });

    it("keeps the reopen pill while the approval's run is still live", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        useChatStore().addMessage(SESSION_ID, {
            id: "message-live",
            sessionId: SESSION_ID,
            role: "assistant",
            content: "waiting for a decision",
            timestamp: "2026-11-02T00:00:00Z",
            runId: RUN_ID,
            runStatus: "awaiting_approval",
        });
        useAgentStore().addApprovalRequest(approval);
        await nextTick();
        await flushPromises();

        wrapper.findComponent(ApprovalModal).vm.$emit("dismiss");
        await nextTick();

        // Unknown/live is never treated as terminal — the shortcut must stay.
        expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(true);
    });

    it("moves focus to the reopen pill when the approval card is dismissed (BL-328)", async () => {
        const wrapper = mountPanel(document.body);
        try {
            await flushPromises();

            useChatStore().addMessage(SESSION_ID, {
                id: "message-focus",
                sessionId: SESSION_ID,
                role: "assistant",
                content: "waiting for a decision",
                timestamp: "2026-11-02T00:00:00Z",
                runId: RUN_ID,
                runStatus: "awaiting_approval",
            });
            useAgentStore().addApprovalRequest(approval);
            await nextTick();
            await flushPromises();

            wrapper.findComponent(ApprovalModal).vm.$emit("dismiss");
            // 焦点在 `nextTick` 里落到 pill：多等一次 tick，模拟浏览器渲染完成。
            await nextTick();
            await nextTick();

            const pill = wrapper.get('[data-testid="pending-approval-reopen-pill"]');
            // 关掉的是"可恢复的"卡 ⇒ 焦点必须回到恢复入口；掉到 body 等于键盘用户丢失落点。
            expect(document.activeElement).toBe(pill.element);
        } finally {
            wrapper.unmount();
        }
    });

    it("drops the local dismiss record once the pending approval disappears", async () => {
        const wrapper = mountPanel(),
            store = useAgentStore();
        store.addApprovalRequest(approval);
        await nextTick();
        await flushPromises();

        const modal = wrapper.findComponent(ApprovalModal);
        modal.vm.$emit("dismiss");
        await nextTick();
        expect(modal.props("show")).toBe(false);
        expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(true);

        store.agentState.pendingApprovals.splice(0);
        await nextTick();
        expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(false);

        store.addApprovalRequest(approval);
        await nextTick();
        expect(modal.props("show")).toBe(true);
        expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(false);
    });

    it("ships reopen pill i18n keys in zh-CN and en-US without placeholders", () => {
        const keys = ["pendingApprovalReopenLabel", "pendingApprovalReopenAction"];
        for (const locale of ["zh-CN", "en-US"] as const) {
            const messages = i18n.global.getLocaleMessage(locale) as {
                chat: Record<string, string>;
            };
            for (const key of keys) {
                expect(messages.chat[key], `${locale}.${key}`).toBeTruthy();
                expect(messages.chat[key], `${locale}.${key}`).not.toMatch(/\{[^}]*\}/);
            }
        }
    });
});

describe("ChatPanel derived child state (PLAN-0408 M3)", () => {
    const derivedState: SessionDerivedStateResponse = {
        sessionId: SESSION_ID,
        activeChildren: [
            {
                childSessionId: "44444444-4444-4444-8444-444444444444",
                runId: "55555555-5555-4555-8555-555555555555",
                name: "Research child",
                status: "running",
            },
        ],
        terminalNotices: [],
    };

    it("loads the API projection for the current Session and renders it separately from messages", async () => {
        vi.mocked(api.getSessionDerivedState).mockResolvedValue(derivedState);
        const wrapper = mountPanel();
        await flushPromises();

        expect(api.getSessionDerivedState).toHaveBeenCalledWith(SESSION_ID);
        const panel = wrapper.findComponent(SessionDerivedStatePanel);
        expect(panel.exists()).toBe(true);
        expect(panel.props("activeChildren")).toEqual(derivedState.activeChildren);
        expect(panel.props("terminalNotices")).toEqual([]);
    });

    it("treats the SSE event as a refresh hint and associates tool waiting by durable childRunId", async () => {
        const response = vi.mocked(api.getSessionDerivedState);
        response.mockResolvedValue(derivedState);
        const wrapper = mountPanel();
        await flushPromises();

        const chatStore = useChatStore();
        chatStore.addMessage(SESSION_ID, {
            id: "parent-user-message",
            sessionId: SESSION_ID,
            role: "user",
            content: "run spawn_agent",
            timestamp: "2026-09-27T00:00:00Z",
            runId: RUN_ID,
        });
        chatStore.addMessage(SESSION_ID, {
            id: "message-tool-call",
            sessionId: SESSION_ID,
            role: "assistant",
            content: "",
            timestamp: "2026-09-27T00:00:00Z",
            toolCalls: [
                {
                    id: "spawn-tool-call",
                    runId: "agent-tool-run",
                    name: "spawn_agent",
                    arguments: "{}",
                    status: "completed",
                },
            ],
        });
        // PLAN-0464 T2.1: the waiting link lives on the child ChatRun row, so
        // the panel reads the child Session's run page instead of paging
        // Operations and fetching every trace.
        vi.mocked(api.listSessionRuns).mockResolvedValue({
            sessionId: derivedState.activeChildren[0].childSessionId,
            page: 0,
            size: 200,
            runs: [
                {
                    runId: derivedState.activeChildren[0].runId,
                    sessionId: derivedState.activeChildren[0].childSessionId,
                    origin: "spawn",
                    status: "running",
                    terminalOutcome: null,
                    errorCode: null,
                    createdAt: "2026-09-27T00:00:00Z",
                    terminalAt: null,
                    waitingOnRunId: RUN_ID,
                    waitingToolCallId: "spawn-tool-call",
                },
            ],
        });

        const stream = wrapper.findComponent(SSEStream);
        stream.vm.$emit("derivedStateRefresh");
        await flushPromises();

        expect(response).toHaveBeenCalledTimes(2);
        expect(api.listSessionRuns).toHaveBeenCalledWith(
            derivedState.activeChildren[0].childSessionId,
            { page: 0, size: 200 },
        );
        const rendered = wrapper.findComponent(MessageList).props("messages") as Array<{
            id: string;
            toolCalls?: Array<{
                waitingOn?: { childRunId: string; name: string | null; status: string } | null;
            }>;
        }>;
        expect(
            rendered.find((message) => message.id === "message-tool-call")?.toolCalls?.[0]
                ?.waitingOn,
        ).toEqual({
            childRunId: derivedState.activeChildren[0].runId,
            name: "Research child",
            status: "running",
        });
    });
});

describe("ChatPanel Follow-up queue", () => {
    it("reloads the owner Message when a child approval reveals admission", async () => {
        const content = "run the next check",
            childRunId = "88888888-8888-4888-8888-888888888888";
        const childMessageId = "99999999-9999-4999-8999-999999999999";
        const queued = queuedFollowUpSnapshot(content).items[0]!;
        const admitted = followUpSnapshot({
            queueState: "queued",
            outstandingCount: 1,
            items: [
                {
                    ...queued,
                    status: "admitted",
                    content: null,
                    childRunId,
                    childMessageId,
                },
            ],
        });
        vi.mocked(api.getFollowUpQueue)
            .mockResolvedValueOnce(followUpSnapshot())
            .mockResolvedValue(admitted);
        let admissionVisible = false;
        vi.mocked(api.getMessages).mockImplementation(async () =>
            admissionVisible
                ? [
                      {
                          id: childMessageId,
                          sessionId: SESSION_ID,
                          role: "USER",
                          content,
                          createdAt: "2026-10-08T00:00:00Z",
                          runId: childRunId,
                          runStatus: null,
                          terminalOutcome: null,
                          errorCode: null,
                          error: null,
                          retryable: null,
                      },
                  ]
                : [],
        );

        const wrapper = mountPanel();
        await flushPromises();
        admissionVisible = true;
        useAgentStore().addApprovalRequest({
            ...approval,
            requestId: "abababab-abab-4bab-8bab-abababababab",
            runId: childRunId,
        });
        await flushPromises();

        expect(api.getFollowUpQueue).toHaveBeenCalledTimes(2);
        expect(api.getMessages).toHaveBeenCalledWith(
            SESSION_ID,
            ROOT_BRANCH_ID,
            expect.objectContaining({ limit: expect.any(Number) }),
        );
        expect(
            wrapper.find('[data-testid="follow-up-item-status"]').attributes("data-status"),
        ).toBe("admitted");
        expect(wrapper.find('[data-testid="follow-up-queue-item"]').text()).toContain(content);
    });

    it("enqueues through CP with the selected branch and renders the authoritative snapshot", async () => {
        const snapshot = queuedFollowUpSnapshot("run the next check");
        vi.mocked(api.getFollowUpQueue)
            .mockReset()
            .mockResolvedValueOnce(followUpSnapshot())
            .mockResolvedValue(snapshot);
        vi.mocked(api.enqueueFollowUpDetailed).mockResolvedValue({ snapshot, replayed: false });
        const wrapper = mountPanel();
        await flushPromises();

        wrapper.findComponent(InputArea).vm.$emit("queue", "run the next check", []);
        await flushPromises();

        expect(api.enqueueFollowUpDetailed).toHaveBeenCalledWith(
            SESSION_ID,
            expect.objectContaining({
                content: "run the next check",
                branchId: ROOT_BRANCH_ID,
                toolMode: "none",
            }),
            expect.any(String),
        );
        expect(wrapper.find('[data-testid="follow-up-queue"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="follow-up-queue-item"]').text()).toContain(
            "run the next check",
        );
        expect(wrapper.findComponent(InputArea).props("queueMode")).toBe(true);
    });

    it("shows explicit continuation while paused and sends the continue action", async () => {
        const paused = queuedFollowUpSnapshot("resume the remaining steps");
        paused.queueState = "paused";
        paused.pauseReason = "parent_cancelled";
        paused.items[0]!.status = "paused";
        vi.mocked(api.getFollowUpQueue)
            .mockResolvedValueOnce(paused)
            .mockResolvedValue(followUpSnapshot());
        vi.mocked(api.continueFollowUpQueue).mockResolvedValue(followUpSnapshot());

        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-testid="follow-up-pause-reason"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="follow-up-continue-button"]').exists()).toBe(true);

        await wrapper.find('[data-testid="follow-up-continue-button"]').trigger("click");
        await flushPromises();
        expect(api.continueFollowUpQueue).toHaveBeenCalledWith(SESSION_ID);
    });

    it("reuses the request key for an identical retry after an ambiguous network failure", async () => {
        vi.mocked(api.enqueueFollowUpDetailed)
            .mockRejectedValueOnce(new Error("connection lost"))
            .mockResolvedValue({
                snapshot: queuedFollowUpSnapshot("retry the same queue action"),
                replayed: false,
            });
        const wrapper = mountPanel();
        await flushPromises();
        const input = wrapper.findComponent(InputArea);

        input.vm.$emit("queue", "retry the same queue action", []);
        await flushPromises();
        input.vm.$emit("queue", "retry the same queue action", []);
        await flushPromises();

        const calls = vi.mocked(api.enqueueFollowUpDetailed).mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0]?.[2]).toBe(calls[1]?.[2]);
    });

    /**
     * task-125（D-1480-S1）：**陈旧键**才是缺陷。
     *
     * <p>「失败后立即重发」是正确重试（上一条用例钉着），不能改；缺陷在于失败留下的幂等键
     * **没有寿命**：用户 abandon 这次失败（改稿 / 切走 / 隔了很久），之后再发**同一内容**时，
     * 判据仍复用旧键 ⇒ CP 按幂等键把它当重放 ⇒ 返回旧 snapshot ⇒ 前端照常提示「已排队」并清稿 ⇒
     * **这一条真实的新消息没有入队**。所以键必须在「重试窗口」之后失效。</p>
     *
     * <p>窗口取值依据：失败分支本身会 refreshFollowUpQueue（首次请求其实已落地时队列会把它显示出来），
     * 所以需要复用键保护的真实重试只发生在**秒级**；超过窗口就按「新动作」处理。</p>
     */
    it("失败后过了保留窗口，再发同内容必须换新键（陈旧键不得把新消息当重放）", async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
        try {
            vi.mocked(api.enqueueFollowUpDetailed)
                .mockRejectedValueOnce(new Error("connection lost"))
                .mockResolvedValue({
                    snapshot: queuedFollowUpSnapshot("same content"),
                    replayed: false,
                });
            const wrapper = mountPanel();
            await flushPromises();
            const input = wrapper.findComponent(InputArea);

            input.vm.$emit("queue", "same content", []);
            await flushPromises();

            // 用户 abandon 这次失败；很久之后才再次主动发**同一内容**。
            clock.mockReturnValue(1_700_000_000_000 + 31 * 60_000);
            input.vm.$emit("queue", "same content", []);
            await flushPromises();

            const calls = vi.mocked(api.enqueueFollowUpDetailed).mock.calls;
            expect(calls).toHaveLength(2);
            expect(calls[0]?.[2]).not.toBe(calls[1]?.[2]);
        } finally {
            clock.mockRestore();
        }
    });

    /**
     * task-125 (c′)：**重放必须被说出来**。
     *
     * <p>CP 用状态码区分「命中既有幂等键（200）」与「新建（202）」（`ChatController:364-365`），
     * 而 UI 原来只看 body ⇒ 重放被当成新入队：报「已排队」并清稿 ⇒ 用户以为这条新消息进了队列。
     * 正确行为 = 提示「此前已提交，未新建」且**不清稿**（这条内容并没有被入队）。</p>
     */
    it("命中 CP 的重放 ⇒ 提示此前已提交且不清稿", async () => {
        vi.mocked(api.enqueueFollowUpDetailed).mockResolvedValue({
            snapshot: queuedFollowUpSnapshot("already there"),
            replayed: true,
        });
        // InputArea 真身在这里被桩掉（mountPanel 用 auto-stub），拿不到暴露的 clearDraft ⇒
        // 用一个记账桩把「有没有清稿」变成可断言的事实。
        const clearDraft = vi.fn<() => void>();
        const wrapper = mount(ChatPanel, {
            props: { sessionId: SESSION_ID },
            global: {
                plugins: [i18n, testRouter()],
                stubs: {
                    SSEStream: true,
                    InputArea: { template: "<span />", methods: { clearDraft } },
                    MessageList: true,
                    SessionPolicyControls: true,
                    SessionContextTemplate: true,
                    ContextSourcesU1: true,
                },
            },
        });
        await flushPromises();
        vi.mocked(toast.success).mockClear();
        vi.mocked(toast.info).mockClear();
        // 挂载期可能已经清过一次稿（chatPanel:1158 的另一条路径）⇒ 只观察这次排队动作。
        clearDraft.mockClear();

        wrapper.findComponent(InputArea).vm.$emit("queue", "already there", []);
        await flushPromises();

        expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
            i18n.global.t("chat.followUpAlreadyQueued"),
        );
        // 精确到「没有报已排队」：同一次交互里别的成功提示不归这条用例管。
        expect(vi.mocked(toast.success)).not.toHaveBeenCalledWith(
            i18n.global.t("chat.followUpQueued"),
        );
        // 没有新建 ⇒ 不能清稿，否则等于替用户丢掉这条内容。
        expect(clearDraft).not.toHaveBeenCalled();
    });

    /**
     * task-129：**「改稿 → 改回」也是新动作**。
     *
     * <p>只比内容不够：用户把稿改成 B 再改回 A，内容与旧稿相同，但中途稿变了 ⇒ 代次变了 ⇒
     * 这是新动作。若复用旧键，CP 会把它当重放（首请求其实已落地时），这条新消息就静默消失。</p>
     */
    it("改稿后再改回原样，60 s 内发送也必须换新键", async () => {
        vi.mocked(api.enqueueFollowUpDetailed).mockRejectedValue(new Error("connection lost"));
        const wrapper = mountPanel();
        await flushPromises();
        const input = wrapper.findComponent(InputArea);

        // 同一代次：这是「同一份稿的连续两次尝试」，第二次必须复用（真重试语义）。
        input.vm.$emit("queue", "edited back", [], undefined, undefined, undefined, 0);
        await flushPromises();
        input.vm.$emit("queue", "edited back", [], undefined, undefined, undefined, 0);
        await flushPromises();
        // 改稿再改回：内容相同但代次前进 ⇒ 必须是新键。
        input.vm.$emit("queue", "edited back", [], undefined, undefined, undefined, 2);
        await flushPromises();

        const calls = vi.mocked(api.enqueueFollowUpDetailed).mock.calls;
        expect(calls).toHaveLength(3);
        expect(calls[1]?.[2]).toBe(calls[0]?.[2]);
        expect(calls[2]?.[2]).not.toBe(calls[0]?.[2]);
    });
});

// ── PLAN-0631 M1 (D31-04) ──────────────────────────────────────────────────
describe("ChatPanel parked run", () => {
    it("explains a parked run with the CP reason instead of staying silent", async () => {
        const wrapper = mountPanel();
        useChatStore().setRunQueued(SESSION_ID, { runId: RUN_ID, reason: "agent_down" });
        await nextTick();

        const row = wrapper.find('[data-testid="chat-run-queued"]');
        expect(row.exists()).toBe(true);
        // Readable status region, not a colour-only signal (spec/ui/accessibility.md:16).
        expect(row.attributes("role")).toBe("status");
        expect(row.attributes("aria-live")).toBe("polite");
        expect(row.text()).toContain(i18n.global.t("chat.runState.queued"));
        expect(row.text()).toContain(i18n.global.t("chat.runState.reasonAgentDown"));

        // The parked view lives exactly as long as the wire fact does.
        useChatStore().createStreamingMessage(SESSION_ID, RUN_ID);
        await nextTick();
        expect(wrapper.find('[data-testid="chat-run-queued"]').exists()).toBe(false);
    });

    it("falls back to the generic hint when CP gives no reason or an unknown one", async () => {
        const wrapper = mountPanel();
        useChatStore().setRunQueued(SESSION_ID, { runId: RUN_ID });
        await nextTick();
        expect(wrapper.find('[data-testid="chat-run-queued"]').text()).toContain(
            i18n.global.t("chat.runState.queuedHint"),
        );

        useChatStore().setRunQueued(SESSION_ID, { runId: RUN_ID, reason: "something_new" });
        await nextTick();
        expect(wrapper.find('[data-testid="chat-run-queued"]').text()).toContain(
            i18n.global.t("chat.runState.queuedHint"),
        );
        expect(wrapper.find('[data-testid="chat-run-queued"]').text()).not.toContain(
            i18n.global.t("chat.runState.reasonAgentDown"),
        );
    });
});

// ── PLAN-0631 M1-B (D31-03 / D31-05) ───────────────────────────────────────
describe("ChatPanel approval waiting surface", () => {
    it("keeps a readable status region after the modal is dismissed, wording shared with the pill", async () => {
        const wrapper = mountPanel();
        useAgentStore().addApprovalRequest(approval);
        await nextTick();
        await flushPromises();

        const row = wrapper.get('[data-testid="chat-approval-waiting"]');
        expect(row.attributes("role")).toBe("status");
        expect(row.attributes("aria-live")).toBe("polite");
        expect(row.text()).toContain(i18n.global.t("chat.runState.awaitingApproval"));
        expect(row.text()).toContain("write_file");

        wrapper.findComponent(ApprovalModal).vm.$emit("dismiss");
        await nextTick();

        // One resolver labelKey ⇒ the pill and the status row cannot drift apart.
        const pill = wrapper.get('[data-testid="pending-approval-reopen-pill"]');
        expect(pill.text()).toContain(i18n.global.t("chat.runState.awaitingApproval"));
        // The status row is not dismissible: it follows CP's pending state only.
        expect(wrapper.find('[data-testid="chat-approval-waiting"]').exists()).toBe(true);
    });

    it("upgrades the recovery banner to alert only for a failed state", async () => {
        const wrapper = mountPanel();
        const store = useChatStore();

        store.runRecovery[SESSION_ID] = {
            state: "resumed",
            runId: RUN_ID,
            message: "still running",
        };
        await nextTick();
        expect(wrapper.get('[data-testid="run-recovery-banner"]').attributes("role")).toBe(
            "status",
        );

        store.runRecovery[SESSION_ID] = {
            state: "failed",
            runId: RUN_ID,
            message: "guard stopped the run",
        };
        await nextTick();
        expect(wrapper.get('[data-testid="run-recovery-banner"]').attributes("role")).toBe("alert");
    });
});

describe("BL-228: 刷新重开（冷启动）在途 run 的投影追平", () => {
    it("存在非终态 run 时周期性重拉历史，终态补齐后停止", async () => {
        vi.useFakeTimers();
        try {
            // 计数驱动（不是 mockResolvedValueOnce 链）：PLAN-0659 起 `listSessionRuns` 的
            // 消费者可能不止一个（会话激活期的追平循环 + 终态点刷新），"谁先调用"不该改变
            // 语义。这里钉的是**第 N 次看到的状态序列**：前两次仍在途，第三次起终态。
            let listCalls = 0;
            vi.mocked(api.listSessionRuns)
                .mockReset()
                .mockImplementation(async () => {
                    listCalls += 1;
                    const status = listCalls <= 2 ? "streaming" : "succeeded";
                    return {
                        sessionId: SESSION_ID,
                        page: 0,
                        size: 50,
                        runs: [{ runId: "run-active", status }],
                    } as never;
                });
            const wrapper = mountPanel();
            await flushPromises();

            // 基线：挂载的历史加载 + immediate tick 见到在途 run 的第一次追平。
            const baseline = vi.mocked(api.getMessages).mock.calls.length;
            expect(baseline).toBeGreaterThanOrEqual(1);

            // 第 2 次 tick：仍在途（streaming）→ 继续重拉（追平不中断）。
            await vi.advanceTimersByTimeAsync(1000);
            await flushPromises();
            const afterInFlightTick = vi.mocked(api.getMessages).mock.calls.length;
            expect(afterInFlightTick).toBeGreaterThan(baseline);

            // 第 3 次 tick：已终态（succeeded）→ 再拉一次（把补齐的 assistant 消息带回来）后停止。
            await vi.advanceTimersByTimeAsync(1000);
            await flushPromises();
            expect(vi.mocked(api.getMessages).mock.calls.length).toBe(afterInFlightTick + 1);

            // 停止后不再增长。
            await vi.advanceTimersByTimeAsync(5000);
            await flushPromises();
            expect(vi.mocked(api.getMessages).mock.calls.length).toBe(afterInFlightTick + 1);

            wrapper.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it("冷启动无在途 run 时不产生额外历史请求", async () => {
        vi.useFakeTimers();
        try {
            // 计数驱动：会话激活期只有追平循环这一个 `listSessionRuns` 消费者（PLAN-0659
            // T1.1 起会话切换不再另发一次），因此断言强度保持「恰好 1 次」。
            let listCalls = 0;
            vi.mocked(api.listSessionRuns)
                .mockReset()
                .mockImplementation(async () => {
                    listCalls += 1;
                    return {
                        sessionId: SESSION_ID,
                        page: 0,
                        size: 50,
                        runs: [],
                    } as never;
                });
            const wrapper = mountPanel();
            await flushPromises();
            const mountCalls = vi.mocked(api.getMessages).mock.calls.length;

            await vi.advanceTimersByTimeAsync(5000);
            await flushPromises();
            expect(vi.mocked(api.getMessages).mock.calls.length).toBe(mountCalls);
            expect(vi.mocked(api.listSessionRuns).mock.calls.length).toBe(1);
            expect(listCalls).toBe(1);

            wrapper.unmount();
        } finally {
            vi.useRealTimers();
        }
    });
});
describe("Problem detail surfacing (BL-288)", () => {
    it("shows the 413 PAGINATION_REQUIRED detail instead of the generic load copy", async () => {
        vi.mocked(toast.error).mockClear();
        vi.mocked(api.getMessages).mockRejectedValueOnce(
            new ApiError({
                status: 413,
                code: "PAGINATION_REQUIRED",
                requestId: "req-288",
                detail: "会话 20001 条超过单次读取上限 20000；请改用分页读取或导出",
            }),
        );
        mountPanel();
        await flushPromises();
        await nextTick();
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("20001"));
    });

    it("falls back to the localized generic copy when the Problem has no detail", async () => {
        vi.mocked(toast.error).mockClear();
        vi.mocked(api.getMessages).mockRejectedValueOnce(
            new ApiError({
                status: 413,
                code: "PAGINATION_REQUIRED",
                requestId: "req-288b",
            }),
        );
        mountPanel();
        await flushPromises();
        await nextTick();
        const calls = vi.mocked(toast.error).mock.calls.map(([message]) => String(message));
        expect(calls.some((message) => /加载消息失败|Failed to load messages/.test(message))).toBe(
            true,
        );
    });
});

/**
 * task-49 判据 **2a（mock 层证据）**：独立会话发送前的**兜底预剥离**只允许吃掉附件。
 *
 * <p>⚠️ 这条**不覆盖 wire**：请求体字段是否真被 CP 接受、是否真起 run，要 2b 真栈另跑。
 * 这里钉的是**函数边界**（`ChatPanel.handleSend` → `SSEStream.sendMessage` 的实参）—— 即
 * 「UI 有没有在发出去之前把用户选的 to/cc/as 悄悄删掉」这件事，它在哪一层被决定就在哪一层被断言。</p>
 *
 * <p>为什么不在 dev mock 实例里抓 `POST /api/v1/chat`：该实例的 `POST /sessions/{id}/bind-defaults`
 * 路由缺失（404）且 SSE 未建立 ⇒ 发送路径在 mock 实例上根本走不到发请求那一步，抓不到请求体。
 * 这条缺口本身另立卡，见交付说明 —— **别把「抓不到」当成「没问题」**。</p>
 */
describe("task-49 独立会话预剥离（2a：函数边界，非 wire）", () => {
    const WORKSPACE_LESS_SID = SESSION_ID;

    function workspaceLessRouter() {
        const router = createRouter({
            history: createMemoryHistory(),
            routes: [{ path: "/chat/:sessionId", component: { template: "<div />" } }],
        });
        return router;
    }

    /** 独立会话（`/chat/:sessionId`，无 workspaceId 段）+ 已绑会话 ⇒ 绑定守卫零开销放行。 */
    async function mountWorkspaceLess() {
        const sendMessage = vi.fn<(...args: unknown[]) => Promise<{ runId: string }>>(async () => ({
            runId: RUN_ID,
        }));
        useSessionStore().applySessionRecord({
            id: WORKSPACE_LESS_SID,
            title: "独立会话",
            workspaceId: null,
            agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
            modelProvider: "deepseek",
            modelName: "deepseek-flash",
            providerConnectionId: "conn-1",
            connectionRevision: 2,
            createdAt: "2026-11-04T10:00:00Z",
            updatedAt: "2026-11-04T10:00:00Z",
        } as never);
        const router = workspaceLessRouter();
        await router.push("/chat/" + WORKSPACE_LESS_SID);
        await router.isReady();
        const wrapper = mount(ChatPanel, {
            props: { sessionId: WORKSPACE_LESS_SID },
            global: {
                plugins: [i18n, router],
                stubs: {
                    // 只桩「发送出口」：SSEStream 被替换成带 sendMessage 的替身 ⇒ 我们断言的是**实参**。
                    SSEStream: { template: "<span />", methods: { sendMessage } },
                    // InputArea 真身的 clearDraft 会在发送后被调用；桩掉后必须也提供，否则
                    // 抛 unhandled rejection（`inputComponent.value?.clearDraft is not a function`）。
                    InputArea: { template: "<span />", methods: { clearDraft: () => undefined } },
                    MessageList: true,
                    SessionPolicyControls: true,
                    SessionContextTemplate: true,
                    ContextSourcesU1: true,
                },
            },
        });
        await flushPromises();
        return { wrapper, sendMessage };
    }

    /**
     * 从 composer 侧触发一次发送（InputArea 的真身已被桩掉，这里发它本该发的事件）。
     *
     * ⚠️ `ChatPanel.onInputSend` 是**位置参数**（`:1060-1068`：content, attachments, asParticipantId, cc,
     * toParticipantIds），不是对象 —— 传对象会让五个值全落到 `content` 上，断言会红在
     * "字段 undefined" 而误判成产品缺陷（本卡实测踩过：见 commit body 的 2a 段）。
     */
    async function emitSend(
        wrapper: Awaited<ReturnType<typeof mountWorkspaceLess>>["wrapper"],
        payload: {
            attachments?: unknown[];
            asParticipantId?: string;
            cc?: string[];
            toParticipantIds?: string[];
        },
    ) {
        wrapper
            .findComponent(InputArea)
            .vm.$emit(
                "send",
                "task-49 2a",
                payload.attachments,
                payload.asParticipantId,
                payload.cc,
                payload.toParticipantIds,
            );
        await flushPromises();
    }

    it("正例：to / cc / as 三样都必须原样交给发送出口", async () => {
        const { wrapper, sendMessage } = await mountWorkspaceLess();
        await emitSend(wrapper, {
            asParticipantId: "p-self",
            cc: ["p-human"],
            toParticipantIds: ["p-other"],
        });

        expect(sendMessage).toHaveBeenCalledTimes(1);
        const [, options] = sendMessage.mock.calls[0] as [string, Record<string, unknown>];
        // 断言的是**有值**（不是"存在这个字段"）：空数组/undefined 都算失败 ——
        // 这正是 task-49 修的缺陷形态（字段被剥成 undefined，用户面前零效果）。
        expect(options.asParticipantId, "代发身份被预剥离吃掉了").toBe("p-self");
        expect(options.cc, "抄送被预剥离吃掉了").toEqual(["p-human"]);
        expect(options.toParticipantIds, "发送目标被预剥离吃掉了").toEqual(["p-other"]);
        expect(vi.mocked(toast.warning), "没有附件时不该弹「已丢弃」").not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("负例：附件仍必须被剥掉，并且**说出来**（有附件才响 warning）", async () => {
        const { wrapper, sendMessage } = await mountWorkspaceLess();
        await emitSend(wrapper, {
            attachments: [{ fileId: "file-1", name: "a.txt", size: 1, mimeType: "text/plain" }],
        });

        expect(sendMessage).toHaveBeenCalledTimes(1);
        const [, options] = sendMessage.mock.calls[0] as [string, Record<string, unknown>];
        expect(options.attachments, "独立会话附件仍 400（D-1436 裁定 3）⇒ 必须剥").toBeUndefined();
        expect(vi.mocked(toast.warning), "剥了东西就必须说出来").toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });
});

/**
 * task-29（D-1866 后续）：**首条消息之后**重读该会话一次。
 *
 * <p>事实：CP 已在首条 user-facing 消息落库的同一事务里把默认标题改成派生标题（`0cc9fb449`），
 * 但仓库没有 session-updated SSE、`POST /chat` 响应也不带标题 ⇒ 不重读就得刷新页面/切会话才见新名。
 * 这里钉的是 UI 欠下的那一次重读；wire 层（真浏览器 ≤2 s、不整页刷新）由 Playwright 另证。</p>
 *
 * <p>四条判据：① 首条消息 ⇒ **恰好一次** `GET /sessions/{id}`，新标题落进侧栏渲染的 live 投影；
 * ② 后续消息 ⇒ **不再重读**（每条都读等于每次对话多拉一遍会话投影）；③ 有历史的会话不算首条
 * ⇒ 零重读；④ 重读失败只留痕、不改投影、不重试。</p>
 */
describe("task-29 首条消息后重读会话标题（零刷新）", () => {
    const DERIVED = "解释一下这个概念";

    function sessionRecord(title: string) {
        return {
            id: SESSION_ID,
            title,
            workspaceId: "workspace-1",
            agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
            modelProvider: "deepseek",
            modelName: "deepseek-flash",
            providerConnectionId: "conn-1",
            connectionRevision: 2,
            createdAt: "2026-11-04T10:00:00Z",
            updatedAt: "2026-11-04T10:00:00Z",
        };
    }

    /** 默认标题 + 已绑定的**空会话**（= 用户刚点「新建对话」落进侧栏的那个状态）。 */
    async function mountUnnamedPanel() {
        const sendMessage = vi.fn<
            (...args: unknown[]) => Promise<{ runId: string; messageId: string; status: string }>
        >(async () => ({
            runId: RUN_ID,
            messageId: "55555555-5555-4555-8555-555555555555",
            status: "thinking",
        }));
        useSessionStore().applySessionRecord(
            sessionRecord(i18n.global.t("workspace.sessionDefaultTitle")) as never,
        );
        // 重读回来的是派生标题（CP 的 durable 事实）⇒ 钉这一次读确实把新名带回投影。
        vi.mocked(api.getSession).mockResolvedValue(sessionRecord(DERIVED));
        const router = createRouter({
            history: createMemoryHistory(),
            routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div />" } }],
        });
        const wrapper = mount(ChatPanel, {
            props: { sessionId: SESSION_ID },
            global: {
                plugins: [i18n, router],
                stubs: {
                    // 桩"发送出口"：sendMessage 成功返回 ⇒ 走完整 submitMessage 路径。
                    SSEStream: { template: "<span />", methods: { sendMessage } },
                    InputArea: { template: "<span />", methods: { clearDraft: () => undefined } },
                    MessageList: true,
                    SessionPolicyControls: true,
                    SessionContextTemplate: true,
                    ContextSourcesU1: true,
                },
            },
        });
        await flushPromises();
        // 只统计发送之后的重读；挂载期若有人替我们读了一次，也应该被算进"每条都读"的账。
        vi.mocked(api.getSession).mockClear();
        return { wrapper, sendMessage };
    }

    async function emitSend(wrapper: Awaited<ReturnType<typeof mountUnnamedPanel>>["wrapper"]) {
        wrapper.findComponent(InputArea).vm.$emit("send", DERIVED);
        await flushPromises();
    }

    it("首条消息发出后恰好重读一次，新标题进入侧栏读的 live 投影", async () => {
        const { wrapper } = await mountUnnamedPanel();
        await emitSend(wrapper);

        expect(api.getSession).toHaveBeenCalledTimes(1);
        expect(api.getSession).toHaveBeenCalledWith(SESSION_ID);
        expect(
            useSessionStore().sessions.find((item) => item.id === SESSION_ID)?.title,
            "重读回来的派生标题必须落进侧栏渲染的那份投影",
        ).toBe(DERIVED);
        wrapper.unmount();
    });

    it("后续消息不得再重读（每条都读 = 每次对话多拉一遍会话投影）", async () => {
        const { wrapper } = await mountUnnamedPanel();
        await emitSend(wrapper);
        await emitSend(wrapper);
        await emitSend(wrapper);

        expect(api.getSession, "重读只属于首条消息").toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it("已有历史的会话不是首条 ⇒ 零重读", async () => {
        const { wrapper } = await mountUnnamedPanel();
        useChatStore().addMessage(SESSION_ID, {
            id: "88888888-8888-4888-8888-888888888888",
            sessionId: SESSION_ID,
            role: "user",
            content: "earlier",
            timestamp: "2026-11-04T10:00:00Z",
        });
        await emitSend(wrapper);

        expect(api.getSession).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("重读失败：不改投影、不重试，只留痕", async () => {
        const { wrapper } = await mountUnnamedPanel();
        vi.mocked(api.getSession).mockRejectedValueOnce(new Error("network down"));
        await emitSend(wrapper);

        expect(api.getSession).toHaveBeenCalledTimes(1);
        expect(
            useSessionStore().sessions.find((item) => item.id === SESSION_ID)?.title,
            "读失败不得把默认名抹成 undefined，也不得改动会话行",
        ).toBe(i18n.global.t("workspace.sessionDefaultTitle"));

        // 失败后也不重试：重试判据（发送前无消息）在乐观消息入表后已不成立。
        await emitSend(wrapper);
        expect(api.getSession, "重读按会话至多一次").toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });
});
