import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import ChatPanel from "../ChatPanel.vue";
import ApprovalModal from "../ApprovalModal.vue";
import SessionDerivedStatePanel from "../SessionDerivedStatePanel.vue";
import SSEStream from "../SSEStream.vue";
import MessageList from "../MessageList.vue";
import InputArea from "../InputArea.vue";
import { i18n } from "../../../i18n";
import { api, type ApiFollowUpQueueSnapshot } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import { useAgentStore } from "../../../stores/agent";
import { useChatStore } from "../../../stores/chat";
import type { ApprovalRequest, SessionDerivedStateResponse } from "../../../types";

vi.mock("../../../composables/api", async (importOriginal) => {
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

function mountPanel() {
    return mount(ChatPanel, {
        props: { sessionId: SESSION_ID },
        global: {
            plugins: [i18n],
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

        expect(api.getMessages).toHaveBeenLastCalledWith(SESSION_ID, ROOT_BRANCH_ID);
        expect(store.getMessages(SESSION_ID).map((message) => message.id)).toEqual([canonicalId]);
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
        expect(api.getMessages).toHaveBeenCalledWith(SESSION_ID, ROOT_BRANCH_ID);
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
