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
            withdrawFollowUp: vi.fn<typeof api.withdrawFollowUp>(),
            continueFollowUpQueue: vi.fn<typeof api.continueFollowUpQueue>(),
            getSessionDerivedState: vi.fn<typeof api.getSessionDerivedState>(),
            listSessionRuns: vi.fn<typeof api.listSessionRuns>(),
            bindSessionDefaults: vi.fn<typeof api.bindSessionDefaults>(),
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
    vi.mocked(api.withdrawFollowUp).mockReset();
    vi.mocked(api.continueFollowUpQueue).mockReset();
    vi.mocked(api.getSessionDerivedState).mockReset();
    vi.mocked(api.getSessionDerivedState).mockResolvedValue({
        sessionId: SESSION_ID,
        activeChildren: [],
        terminalNotices: [],
    });
    vi.mocked(api.listSessionRuns).mockReset();
    vi.mocked(api.listSessionRuns).mockResolvedValue({
        sessionId: SESSION_ID,
        page: 0,
        size: 100,
        runs: [],
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
        vi.mocked(api.enqueueFollowUp).mockResolvedValue(snapshot);
        const wrapper = mountPanel();
        await flushPromises();

        wrapper.findComponent(InputArea).vm.$emit("queue", "run the next check", []);
        await flushPromises();

        expect(api.enqueueFollowUp).toHaveBeenCalledWith(
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
        vi.mocked(api.enqueueFollowUp)
            .mockRejectedValueOnce(new Error("connection lost"))
            .mockResolvedValue(queuedFollowUpSnapshot("retry the same queue action"));
        const wrapper = mountPanel();
        await flushPromises();
        const input = wrapper.findComponent(InputArea);

        input.vm.$emit("queue", "retry the same queue action", []);
        await flushPromises();
        input.vm.$emit("queue", "retry the same queue action", []);
        await flushPromises();

        const calls = vi.mocked(api.enqueueFollowUp).mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0]?.[2]).toBe(calls[1]?.[2]);
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
