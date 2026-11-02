import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { api } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { useChatStore } from "../stores/chat.ts";

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getChatRunStatus: vi.fn<typeof apiModule.api.getChatRunStatus>(),
            getPendingApprovals: vi
                .fn<typeof apiModule.api.getPendingApprovals>()
                .mockResolvedValue([]),
        },
    };
});

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
});

describe("useChatStore", () => {
    it("getMessages returns empty array for unknown session", () => {
        const store = useChatStore();
        expect(store.getMessages("nonexistent")).toEqual([]);
    });

    it("keeps branch selection scoped to each session and defaults to its root", () => {
        const store = useChatStore();
        const root = {
                branchId: "root-a",
                parentBranchId: null,
                forkPointMessageId: null,
                forkPointRunId: null,
                createdAt: "2026-09-29T00:00:00Z",
            },
            child = {
                branchId: "child-a",
                parentBranchId: "root-a",
                forkPointMessageId: "message-a",
                forkPointRunId: "run-a",
                createdAt: "2026-09-29T00:01:00Z",
            },
            otherRoot = {
                branchId: "root-b",
                parentBranchId: null,
                forkPointMessageId: null,
                forkPointRunId: null,
                createdAt: "2026-09-29T00:00:00Z",
            };

        store.setSessionBranches("session-a", [root, child]);
        store.setSessionBranches("session-b", [otherRoot]);

        expect(store.getSelectedBranchId("session-a")).toBe(root.branchId);
        expect(store.getSelectedBranchId("session-b")).toBe(otherRoot.branchId);
        expect(store.selectBranch("session-a", child.branchId)).toBe(true);
        expect(store.getSelectedBranchId("session-a")).toBe(child.branchId);
        expect(store.getSelectedBranchId("session-b")).toBe(otherRoot.branchId);
    });

    it("addMessage stores a message for a session", () => {
        const store = useChatStore(),
            msg = {
                id: "m1",
                sessionId: "s1",
                role: "user" as const,
                content: "hello",
                timestamp: new Date().toISOString(),
            };
        store.addMessage("s1", msg);
        expect(store.getMessages("s1")).toHaveLength(1);
        expect(store.getMessages("s1")[0].content).toBe("hello");
    });

    it("addMessage appends to existing messages", () => {
        const store = useChatStore();
        store.addMessage("s1", {
            id: "m1",
            sessionId: "s1",
            role: "user" as const,
            content: "first",
            timestamp: "2024-01-01",
        });
        store.addMessage("s1", {
            id: "m2",
            sessionId: "s1",
            role: "assistant" as const,
            content: "second",
            timestamp: "2024-01-01",
        });
        expect(store.getMessages("s1")).toHaveLength(2);
    });

    it("createStreamingMessage adds assistant message and tracks it", () => {
        const store = useChatStore(),
            id = store.createStreamingMessage("s1"),
            msgs = store.getMessages("s1");
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe("assistant");
        expect(msgs[0].id).toBe(id);
        expect(msgs[0].isStreaming).toBe(true);
        expect(store.getStreamingMessageId("s1")).toBe(id);
        expect(store.isStreaming("s1")).toBe(true);
    });

    it("keeps streaming and run state scoped to each session", () => {
        const store = useChatStore();
        store.setSessionRunState("session-a", "awaiting_approval", "run-a");

        expect(store.isStreaming("session-a")).toBe(true);
        expect(store.getSessionRunId("session-a")).toBe("run-a");
        expect(store.isStreaming("session-b")).toBe(false);
        expect(store.getSessionRunState("session-b").status).toBe("idle");
    });

    it("upsertToolCall creates the live assistant message and merges by id", () => {
        const store = useChatStore();
        store.upsertToolCall("s1", {
            id: "tc-1",
            name: "run_command",
            arguments: "{}",
            status: "running",
        });

        let calls = store.getMessages("s1")[0].toolCalls;
        expect(store.getMessages("s1")).toHaveLength(1);
        expect(store.getStreamingMessageId("s1")).toBe(store.getMessages("s1")[0].id);
        expect(calls?.[0]).toMatchObject({ id: "tc-1", name: "run_command", status: "running" });

        store.upsertToolCall("s1", {
            id: "tc-1",
            status: "completed",
            result: "src/a.ts:1:2: error: bad",
            diagnostics: {
                items: [
                    {
                        file: "src/a.ts",
                        line: 1,
                        column: 2,
                        severity: "error",
                        kind: "compile",
                        message: "bad",
                        confidence: "high",
                    },
                ],
                total: 1,
                confidence: "high",
            },
        });

        calls = store.getMessages("s1")[0].toolCalls;
        expect(calls).toHaveLength(1);
        expect(calls?.[0]).toMatchObject({
            id: "tc-1",
            name: "run_command",
            status: "completed",
            result: "src/a.ts:1:2: error: bad",
        });
        expect(calls?.[0].diagnostics?.total).toBe(1);
    });

    it("upsertToolCall keeps tool calls after finalizeStreaming", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.upsertToolCall("s1", {
            id: "tc-1",
            name: "run_command",
            arguments: "{}",
            status: "running",
        });
        store.finalizeStreaming("s1");

        const message = store.getMessages("s1")[0];
        expect(message.isStreaming).toBe(false);
        expect(message.toolCalls).toHaveLength(1);
        expect(message.toolCalls?.[0].id).toBe("tc-1");
    });
    it("upsertToolCall reuses the active streaming message instead of creating a second", () => {
        const store = useChatStore(),
            messageId = store.createStreamingMessage("s1", "run-1");
        store.upsertToolCall("s1", {
            id: "tc-1",
            name: "run_command",
            arguments: "{}",
            status: "running",
        });

        expect(store.getMessages("s1")).toHaveLength(1);
        expect(store.getMessages("s1")[0].id).toBe(messageId);
        expect(store.getStreamingMessageId("s1")).toBe(messageId);
    });

    it("keeps a tool-only message when the stream fails", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.upsertToolCall("s1", {
            id: "tc-1",
            name: "run_command",
            arguments: "{}",
            status: "failed",
            error: "boom",
        });
        store.markStreamingError("s1", {
            code: "AGENT_STREAM_FAILED",
            detail: "stream failed",
            outcome: "error",
        });

        const message = store.getMessages("s1")[0];
        expect(message.toolCalls).toHaveLength(1);
        expect(message.runStatus).toBe("failed");
        expect(message.terminalOutcome).toBe("error");
        expect(store.isStreaming("s1")).toBe(false);
    });

    it("loadMessages does not replace an in-flight streaming message", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.appendToParts("s1", { type: "text", content: "partial" });

        store.loadMessages("s1", [
            {
                id: "server-user",
                sessionId: "s1",
                role: "user",
                content: "hello",
                timestamp: new Date().toISOString(),
            },
        ]);

        expect(store.getMessages("s1")[0].parts).toEqual([{ type: "text", content: "partial" }]);
        expect(store.isStreaming("s1")).toBe(true);
    });

    it("retains a run's live transcript while the projection has not caught up with it", () => {
        const store = useChatStore(),
            sessionId = "s-live",
            runId = "run-live",
            timestamp = "2026-11-03T00:00:00Z";

        vi.mocked(api.getChatRunStatus).mockResolvedValue({
            runId,
            sessionId,
            origin: "user_submission",
            status: "failed",
            terminalOutcome: "partial",
            leaseExpired: false,
            pendingApprovals: [],
        });
        store.addMessage(sessionId, {
            id: "client-user",
            sessionId,
            role: "user",
            content: "try again",
            timestamp,
            runStatus: "accepted",
        });
        store.markClientOwned(sessionId, "client-user");
        // The reply's first token beat the `202` body, so it has no run id yet.
        store.createStreamingMessage(sessionId);
        store.appendToParts(sessionId, { type: "text", content: "partial response" });
        store.adoptRunId(sessionId, runId);
        store.markStreamingError(sessionId, {
            code: "PROVIDER_TEMPORARY",
            detail: "Provider temporarily unavailable",
            runId,
            retryable: true,
        });

        // The durable projection lags the terminal event and does not carry the run yet.
        store.loadMessages(sessionId, []);

        const retained = store.getMessages(sessionId);
        expect(retained).toHaveLength(2);
        expect(retained[0].content).toBe("try again");
        expect(retained[0].runId).toBe(runId);
        expect(retained[1].content).toBe("partial response");
        expect(retained[1].runId).toBe(runId);
        expect(retained[1].errorCode).toBe("PROVIDER_TEMPORARY");
        expect(retained[1].terminalOutcome).toBe("partial");
    });

    it("hands the transcript back to the projection once it carries the run", () => {
        const store = useChatStore(),
            sessionId = "s-live",
            runId = "run-live",
            timestamp = "2026-11-03T00:00:00Z";

        vi.mocked(api.getChatRunStatus).mockResolvedValue({
            runId,
            sessionId,
            origin: "user_submission",
            status: "failed",
            terminalOutcome: "partial",
            leaseExpired: false,
            pendingApprovals: [],
        });
        store.addMessage(sessionId, {
            id: "client-user",
            sessionId,
            role: "user",
            content: "try again",
            timestamp,
        });
        store.markClientOwned(sessionId, "client-user");
        store.createStreamingMessage(sessionId);
        store.appendToParts(sessionId, { type: "text", content: "partial response" });
        store.adoptRunId(sessionId, runId);
        store.markStreamingError(sessionId, {
            code: "PROVIDER_TEMPORARY",
            detail: "Provider temporarily unavailable",
            runId,
        });
        store.loadMessages(sessionId, []);
        expect(store.getMessages(sessionId)).toHaveLength(2);

        store.loadMessages(sessionId, [
            {
                id: "client-user",
                sessionId,
                role: "user",
                content: "try again",
                timestamp,
                runId,
            },
            {
                id: "server-assistant",
                sessionId,
                role: "assistant",
                content: "partial response",
                timestamp,
                runId,
                runStatus: "failed",
                errorCode: "PROVIDER_TEMPORARY",
            },
        ]);
        expect(store.getMessages(sessionId).map((message) => message.id)).toEqual([
            "client-user",
            "server-assistant",
        ]);

        // Later refreshes stay authoritative: the client copy is gone for good.
        store.loadMessages(sessionId, [
            {
                id: "server-assistant",
                sessionId,
                role: "assistant",
                content: "partial response",
                timestamp,
                runId,
            },
        ]);
        expect(store.getMessages(sessionId).map((message) => message.id)).toEqual([
            "server-assistant",
        ]);
    });

    it("does not retain local messages of a run it never started", () => {
        const store = useChatStore(),
            sessionId = "s-other";

        store.addMessage(sessionId, {
            id: "stale-local",
            sessionId,
            role: "assistant",
            content: "stale",
            timestamp: "2026-11-03T00:00:00Z",
            runId: "run-unrelated",
        });

        store.loadMessages(sessionId, []);

        expect(store.getMessages(sessionId)).toEqual([]);
    });

    it("detaches a live session so a later history load can replace it", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1", "run-1");
        store.appendToParts("s1", { type: "text", content: "partial" });

        store.detachLiveSession("s1");

        expect(store.isStreaming("s1")).toBe(false);
        expect(store.getSessionRunId("s1")).toBeUndefined();
        expect(store.getMessages("s1")).toEqual([]);
        store.loadMessages("s1", [
            {
                id: "server-assistant",
                sessionId: "s1",
                role: "assistant",
                content: "terminal response",
                timestamp: "2026-01-01T00:00:00Z",
            },
        ]);
        expect(store.getMessages("s1")[0]?.content).toBe("terminal response");
    });

    it("appendToParts appends text parts to streaming message content", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.appendToParts("s1", { type: "text", content: "Hel" });
        store.appendToParts("s1", { type: "text", content: "lo" });
        expect(store.getMessages("s1")[0].parts).toHaveLength(1);
        expect(store.getMessages("s1")[0].parts![0]).toEqual({ type: "text", content: "Hello" });
    });

    it("appendToParts appends reasoning parts separately", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.appendToParts("s1", { type: "reasoning", content: "思考中" });
        store.appendToParts("s1", { type: "text", content: "答案" });
        const parts = store.getMessages("s1")[0].parts!;
        expect(parts).toHaveLength(2);
        expect(parts[0]).toEqual({ type: "reasoning", content: "思考中" });
        expect(parts[1]).toEqual({ type: "text", content: "答案" });
    });

    it("appendToParts merges consecutive same-type parts", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.appendToParts("s1", { type: "text", content: "A" });
        store.appendToParts("s1", { type: "text", content: "B" });
        expect(store.getMessages("s1")[0].parts).toHaveLength(1);
        expect(store.getMessages("s1")[0].parts![0].content).toBe("AB");
    });

    it("replaceStreamingParts updates the live parser result", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.replaceStreamingParts("s1", [{ type: "text", content: "A" }]);
        expect(store.getMessages("s1")[0].parts).toEqual([{ type: "text", content: "A" }]);

        store.replaceStreamingParts("s1", [{ type: "text", content: "AB" }]);
        expect(store.getMessages("s1")[0].parts).toEqual([{ type: "text", content: "AB" }]);
    });

    it("appendToParts does nothing when no streaming message exists", () => {
        const store = useChatStore();
        store.appendToParts("s1", { type: "text", content: "orphan" });
        expect(store.getMessages("s1")).toEqual([]);
    });

    it("finalizeStreaming marks streaming message as completed", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.appendToParts("s1", { type: "text", content: "streamed content" });
        store.finalizeStreaming("s1");
        const msgs = store.getMessages("s1");
        expect(msgs[0].content).toBe("streamed content");
        expect(msgs[0].isStreaming).toBe(false);
        expect(store.isStreaming("s1")).toBe(false);
    });

    it("finalizeStreaming merges parts into content", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.appendToParts("s1", { type: "reasoning", content: "思考" });
        store.appendToParts("s1", { type: "text", content: "答案" });
        store.finalizeStreaming("s1");
        expect(store.getMessages("s1")[0].content).toBe("答案");
    });

    it("finalizeStreaming does nothing when no streaming message exists", () => {
        const store = useChatStore();
        store.finalizeStreaming("s1");
        expect(store.getMessages("s1")).toEqual([]);
    });

    it("interruptForOverflowRetry keeps visible content as interrupted (case B)", () => {
        // PLAN-0341 U3: retry is the official reply; prior content is folded.
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.appendToParts("s1", { type: "text", content: "partial answer before overflow" });
        store.interruptForOverflowRetry("s1");

        const messages = store.getMessages("s1"),
            assistant = messages.find((m) => m.role === "assistant");
        expect(assistant?.interrupted).toBe(true);
        expect(assistant?.runStatus).toBe("interrupted");
        expect(assistant?.content).toContain("partial answer before overflow");
        expect(messages.some((m) => m.marker === "status" && m.status === "interrupted")).toBe(
            true,
        );
        expect(store.isStreaming("s1")).toBe(false);
    });

    it("interruptForOverflowRetry drops empty streaming bubble (case A)", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.interruptForOverflowRetry("s1");
        expect(store.getMessages("s1").filter((m) => m.role === "assistant")).toEqual([]);
    });

    // PLAN-0622 D28：429 现在发生在**准入**（202 之前），此时气泡还没有任何内容。
    // 旧规则"无内容就删气泡"会把错误信息一起删掉 ⇒ 用户点发送后界面什么都不显示。
    it("keeps an admission-rejected bubble so the 429 hint can render", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.markStreamingError("s1", {
            code: "RESOURCE_EXHAUSTED",
            detail: "connection concurrency limit reached",
            retryable: true,
            outcome: "error",
            retryAfterSeconds: 2,
            resourceKind: "CONNECTION",
        });

        const messages = store.getMessages("s1");
        expect(messages, "the rejected submission must stay visible").toHaveLength(1);
        expect(messages[0].errorCode).toBe("RESOURCE_EXHAUSTED");
        expect(messages[0].retryAfterSeconds).toBe(2);
        expect(messages[0].resourceKind).toBe("CONNECTION");
        expect(store.isStreaming("s1")).toBe(false);
    });

    // 真实链路（Lead 的怀疑 1，已由 SSEStream.vue:67 证实）：占位气泡只在 `onStart`
    //（第一个 SSE 事件）里创建，而 D28 的 429 发生在**准入**、根本不会有任何 SSE 事件。
    // 所以"有气泡时别删"覆盖不到真实分支 —— 这里必须覆盖"压根没有气泡"。
    it("creates an error bubble when an admission 429 arrives before any stream event", () => {
        const store = useChatStore();
        expect(store.getMessages("s1")).toEqual([]);

        store.markStreamingError("s1", {
            code: "RESOURCE_EXHAUSTED",
            detail: "connection concurrency limit reached",
            retryable: true,
            outcome: "error",
            retryAfterSeconds: 2,
            resourceKind: "CONNECTION",
        });

        const messages = store.getMessages("s1");
        expect(messages, "an admission rejection must still be visible").toHaveLength(1);
        expect(messages[0].role).toBe("assistant");
        expect(messages[0].errorCode).toBe("RESOURCE_EXHAUSTED");
        expect(messages[0].error).toBeTruthy();
        expect(messages[0].retryAfterSeconds).toBe(2);
        expect(messages[0].resourceKind).toBe("CONNECTION");
        expect(messages[0].runStatus).toBe("failed");
    });

    // 内部流哨兵在没有占位气泡时仍然什么都不创建（清理路径不变）。
    it("creates nothing for an internal stream failure without a placeholder", () => {
        const store = useChatStore();
        store.markStreamingError("s1", {
            code: "AGENT_STREAM_FAILED",
            detail: "Agent stream failed",
            outcome: "error",
        });
        expect(store.getMessages("s1")).toEqual([]);
    });
    // golden path 守卫：内部流错误（无内容）仍然走清理，别把这条规则整体废掉。
    it("removes an empty assistant for an internal stream failure", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.markStreamingError("s1", {
            code: "AGENT_STREAM_FAILED",
            detail: "Agent stream failed",
            retryable: true,
            outcome: "error",
        });
        expect(store.getMessages("s1")).toEqual([]);
        expect(store.isStreaming("s1")).toBe(false);
    });

    it("preserves ambiguous terminal state for partial content", () => {
        const store = useChatStore();
        store.createStreamingMessage("s1");
        store.appendToParts("s1", { type: "text", content: "possibly charged" });
        store.markStreamingError("s1", {
            code: "AGENT_TIMEOUT",
            detail: "Provider result is uncertain",
            retryable: false,
            outcome: "ambiguous",
        });
        const message = store.getMessages("s1")[0];
        expect(message.runStatus).toBe("ambiguous");
        expect(message.terminalOutcome).toBe("ambiguous");
        expect(message.retryable).toBe(false);
    });

    it("clearSession removes all data for a session", () => {
        const store = useChatStore();
        store.addMessage("s1", {
            id: "m1",
            sessionId: "s1",
            role: "user" as const,
            content: "x",
            timestamp: "2024-01-01",
        });
        store.setSessionBranches("s1", [
            {
                branchId: "root",
                parentBranchId: null,
                forkPointMessageId: null,
                forkPointRunId: null,
                createdAt: "2026-09-29T00:00:00Z",
            },
        ]);
        store.createStreamingMessage("s1");
        store.clearSession("s1");
        expect(store.getMessages("s1")).toEqual([]);
        expect(store.getSessionBranches("s1")).toEqual([]);
        expect(store.getSelectedBranchId("s1")).toBeUndefined();
        expect(store.getStreamingMessageId("s1")).toBeNull();
        expect(store.isStreaming("s1")).toBe(false);
    });

    it("clearAllData clears auth-only localStorage keys and resets in-memory messages", () => {
        localStorage.setItem("xihe-token", "abc");
        localStorage.setItem("xihe-workspace", JSON.stringify({ id: "ws-1" }));
        const store = useChatStore();
        store.addMessage("s1", {
            id: "m1",
            sessionId: "s1",
            role: "user",
            content: "hello",
            timestamp: new Date().toISOString(),
        });
        store.clearAllData();
        expect(localStorage.getItem("xihe-token")).toBeNull();
        expect(localStorage.getItem("xihe-workspace")).toBeNull();
        expect(store.getMessages("s1")).toEqual([]);
    });
});

describe("refreshRunRecovery tri-state (PLAN-292 M3 C2/C3)", () => {
    const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        NEW_RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        OLD_RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        REQUEST_ID_1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        REQUEST_ID_2 = "ffffffff-ffff-4fff-8fff-ffffffffffff",
        TERMINAL_REQUEST_ID = "99999999-9999-4999-8999-999999999999";

    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
    });

    async function mockStatus(status: string, extra: Record<string, unknown> = {}) {
        const { api } = await import("../../../../composables/api");
        vi.mocked(api.getChatRunStatus).mockResolvedValue({
            runId: RUN_ID,
            sessionId: SESSION_ID,
            origin: "user_submission",
            status,
            leaseExpired: false,
            pendingApprovals: [],
            ...extra,
        });
    }

    it("resumed when run awaits approval; replays approvals into agent store", async () => {
        await mockStatus("awaiting_approval", {
            pendingApprovals: [
                {
                    requestId: REQUEST_ID_1,
                    runId: RUN_ID,
                    sessionId: SESSION_ID,
                    tool: "write_file",
                    action: "a",
                    details: "d",
                },
            ],
        });
        vi.mocked(api.getPendingApprovals).mockResolvedValueOnce([
            {
                sessionId: SESSION_ID,
                workspaceId: "workspace-a",
                count: 1,
                oldestRequestedAt: "2026-10-08T00:00:00Z",
            },
        ]);
        const store = useChatStore();
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);
        expect(store.runRecovery[SESSION_ID]?.state).toBe("resumed");
        const { useAgentStore } = await import("../../../../stores/agent");
        expect(
            useAgentStore().agentState.pendingApprovals.some((a) => a.requestId === REQUEST_ID_1),
        ).toBe(true);
    });

    it("resumed when a failed run carries an ambiguous outcome with a pending approval", async () => {
        await mockStatus("failed", {
            terminalOutcome: "ambiguous",
            pendingApprovals: [
                {
                    requestId: REQUEST_ID_2,
                    runId: RUN_ID,
                    sessionId: SESSION_ID,
                    tool: "write_file",
                    action: "a",
                    details: "d",
                },
            ],
        });
        vi.mocked(api.getPendingApprovals).mockResolvedValueOnce([
            {
                sessionId: SESSION_ID,
                workspaceId: "workspace-a",
                count: 1,
                oldestRequestedAt: "2026-10-08T00:00:00Z",
            },
        ]);
        const store = useChatStore();
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);
        expect(store.runRecovery[SESSION_ID]?.state).toBe("resumed");
        const { useAgentStore } = await import("../../../../stores/agent");
        expect(
            useAgentStore().agentState.pendingApprovals.some((a) => a.requestId === REQUEST_ID_2),
        ).toBe(true);
    });

    it("cancelled for terminal run states", async () => {
        await mockStatus("cancelled");
        const store = useChatStore();
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);
        expect(store.runRecovery[SESSION_ID]?.state).toBe("cancelled");
    });

    it("presents the loop-guard reason for a failed RUN_NO_PROGRESS run", async () => {
        await mockStatus("failed", { errorCode: "RUN_NO_PROGRESS" });
        const store = useChatStore();
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);
        expect(store.runRecovery[SESSION_ID]?.state).toBe("failed");
        expect(store.runRecovery[SESSION_ID]?.message).toContain("检测到重复或无进展动作");
        expect(store.runRecovery[SESSION_ID]?.message).toContain("接续本次会话");
    });

    it("presents the budget reason for a failed RUN_BUDGET_EXHAUSTED run", async () => {
        await mockStatus("failed", { errorCode: "RUN_BUDGET_EXHAUSTED" });
        const store = useChatStore();
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);
        expect(store.runRecovery[SESSION_ID]?.state).toBe("failed");
        expect(store.runRecovery[SESSION_ID]?.message).toContain("累计预算上限");
    });

    it("expires the local approval when a ChatRun is cancelled", async () => {
        const { useAgentStore } = await import("../../../../stores/agent"),
            agent = useAgentStore(),
            store = useChatStore();
        agent.addApprovalRequest({
            requestId: TERMINAL_REQUEST_ID,
            runId: RUN_ID,
            sessionId: SESSION_ID,
            tool: "write_file",
            action: "write",
            details: "d",
            state: "pending",
        });
        vi.mocked(api.getPendingApprovals).mockResolvedValueOnce([
            {
                sessionId: SESSION_ID,
                workspaceId: "workspace-a",
                count: 1,
                oldestRequestedAt: "2026-10-07T00:00:00Z",
            },
        ]);
        await agent.refreshPendingApprovals();
        expect(agent.pendingApprovalCount(SESSION_ID)).toBe(1);
        store.createStreamingMessage(SESSION_ID, RUN_ID);
        store.upsertToolCall(SESSION_ID, {
            id: "tool-call-1",
            name: "start_background_process",
            arguments: "{}",
            status: "running",
        });
        await mockStatus("cancelled");
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);

        expect(agent.agentState.pendingApprovals).toEqual([]);
        expect(agent.pendingApprovalCount(SESSION_ID)).toBe(0);
        expect(agent.resolvedApprovals[TERMINAL_REQUEST_ID]?.state).toBe("expired");
        expect(store.isStreaming(SESSION_ID)).toBe(false);
        const message = store.getMessages(SESSION_ID).find((item) => item.runId === RUN_ID);
        expect(message).toMatchObject({
            isStreaming: false,
            runStatus: "cancelled",
            terminalOutcome: "cancelled",
            toolCalls: [{ status: "cancelled" }],
        });
    });

    it("retry when the lease expired on a running run", async () => {
        await mockStatus("running", { leaseExpired: true });
        const store = useChatStore();
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);
        expect(store.runRecovery[SESSION_ID]?.state).toBe("retry");
    });

    it("sets no banner for succeeded runs", async () => {
        await mockStatus("succeeded");
        const store = useChatStore();
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);
        expect(store.runRecovery[SESSION_ID]).toBeUndefined();
    });

    it("retry when the status query fails", async () => {
        const { api } = await import("../../../../composables/api");
        vi.mocked(api.getChatRunStatus).mockRejectedValue(new Error("network down"));
        const store = useChatStore();
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);
        expect(store.runRecovery[SESSION_ID]?.state).toBe("retry");
    });

    it("ignores a stale recovery response for an older run", async () => {
        const { api } = await import("../../../../composables/api");
        let resolveOld:
            | ((value: {
                  runId: string;
                  sessionId: string;
                  origin: "user_submission" | "spawn";
                  status: string;
                  leaseExpired: boolean;
                  pendingApprovals: never[];
              }) => void)
            | undefined;
        vi.mocked(api.getChatRunStatus)
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveOld = resolve;
                    }),
            )
            .mockResolvedValueOnce({
                runId: NEW_RUN_ID,
                sessionId: SESSION_ID,
                origin: "user_submission",
                status: "cancelled",
                leaseExpired: false,
                pendingApprovals: [],
            });
        const store = useChatStore(),
            oldRequest = store.refreshRunRecovery(SESSION_ID, OLD_RUN_ID),
            newRequest = store.refreshRunRecovery(SESSION_ID, NEW_RUN_ID);
        await newRequest;
        resolveOld?.({
            runId: OLD_RUN_ID,
            sessionId: SESSION_ID,
            origin: "user_submission",
            status: "awaiting_approval",
            leaseExpired: false,
            pendingApprovals: [],
        });
        await oldRequest;

        expect(store.runRecovery[SESSION_ID]).toMatchObject({
            runId: NEW_RUN_ID,
            state: "cancelled",
        });
    });

    it("ignores a recovery response invalidated by a completed decision", async () => {
        const { api } = await import("../../../../composables/api");
        let resolveStatus:
            | ((value: {
                  runId: string;
                  sessionId: string;
                  origin: "user_submission" | "spawn";
                  status: string;
                  leaseExpired: boolean;
                  pendingApprovals: never[];
              }) => void)
            | undefined;
        vi.mocked(api.getChatRunStatus).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveStatus = resolve;
                }),
        );
        const store = useChatStore(),
            pending = store.refreshRunRecovery(SESSION_ID, RUN_ID);
        store.invalidateRunRecovery(SESSION_ID, RUN_ID);
        resolveStatus?.({
            runId: RUN_ID,
            sessionId: SESSION_ID,
            origin: "user_submission",
            status: "awaiting_approval",
            leaseExpired: false,
            pendingApprovals: [],
        });
        await pending;

        expect(store.runRecovery[SESSION_ID]).toBeUndefined();
        expect(store.getSessionRunState(SESSION_ID).status).toBe("idle");
    });

    it("keeps terminal recovery from resurrecting approvals for the run", async () => {
        const { useAgentStore } = await import("../../../../stores/agent");
        const agent = useAgentStore();
        agent.addApprovalRequest({
            requestId: TERMINAL_REQUEST_ID,
            runId: RUN_ID,
            sessionId: SESSION_ID,
            tool: "write_file",
            action: "write",
            details: "d",
            state: "pending",
        });
        await mockStatus("succeeded");
        const store = useChatStore();
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);

        expect(agent.agentState.pendingApprovals).toEqual([]);
        expect(agent.resolvedApprovals[TERMINAL_REQUEST_ID]?.state).toBe("dispatch_unknown");
    });

    it("dismissRunRecovery clears the banner", async () => {
        await mockStatus("cancelled");
        const store = useChatStore();
        await store.refreshRunRecovery(SESSION_ID, RUN_ID);
        store.dismissRunRecovery(SESSION_ID);
        expect(store.runRecovery[SESSION_ID]).toBeUndefined();
    });
});

// ── PLAN-0631 M1 (D31-04 / D31-07) ─────────────────────────────────────────
describe("PLAN-0631 run state view", () => {
    const SID = "session-0631";

    it("keeps a parked run visible until it actually starts, then clears it", () => {
        const store = useChatStore();
        expect(store.getRunQueued(SID)).toBeNull();

        store.setRunQueued(SID, { runId: "run-q", reason: "agent_down" });
        expect(store.getRunQueued(SID)).toEqual({ runId: "run-q", reason: "agent_down" });

        // First token / tool call creates the live message → the run is no longer parked.
        store.createStreamingMessage(SID, "run-q");
        expect(store.getRunQueued(SID)).toBeNull();
    });

    it("clears the parked view when a parked run terminates without ever starting", () => {
        const store = useChatStore();
        store.setRunQueued(SID, { runId: "run-q" });
        store.finalizeStreaming(SID); // no streaming message → CP never dispatched it
        expect(store.getRunQueued(SID)).toBeNull();
    });

    it("clears the parked view on a terminal error and on session reset", () => {
        const store = useChatStore();
        store.setRunQueued(SID, { runId: "run-q", reason: "agent_down" });
        store.markStreamingError(SID, { code: "RESOURCE_EXHAUSTED", detail: "quota" });
        expect(store.getRunQueued(SID)).toBeNull();

        store.setRunQueued(SID, { runId: "run-q" });
        store.clearSession(SID);
        expect(store.getRunQueued(SID)).toBeNull();
    });

    it("keeps one live status line per run and drops it at the terminal transition", () => {
        const store = useChatStore();
        store.upsertRunStatusMarker(SID, "thinking", "run-1");
        store.upsertRunStatusMarker(SID, "executing", "run-1");
        store.upsertRunStatusMarker(SID, "thinking", "run-1");

        const markers = () =>
            store
                .getMessages(SID)
                .filter((m) => m.marker === "status" && m.status !== "interrupted");
        expect(markers()).toHaveLength(1);
        expect(markers()[0].status).toBe("thinking");
        expect(markers()[0].runId).toBe("run-1");

        store.upsertRunStatusMarker(SID, "thinking", "run-2");
        expect(markers()).toHaveLength(2);

        store.createStreamingMessage(SID, "run-2");
        store.finalizeStreaming(SID);
        expect(markers()).toHaveLength(0);
    });

    it("never removes the interrupted marker: that one is history, not a live status", () => {
        const store = useChatStore();
        store.createStreamingMessage(SID, "run-1");
        store.appendToParts(SID, { type: "text", content: "partial answer" });
        store.upsertRunStatusMarker(SID, "executing", "run-1");
        // Overflow retry: the attempt is folded as `interrupted` (semantic history) …
        store.interruptForOverflowRetry(SID);
        // … and the retry attempt reaches a terminal state, which drops live status lines.
        store.createStreamingMessage(SID, "run-2");
        store.finalizeStreaming(SID);

        const interrupted = store
            .getMessages(SID)
            .filter((m) => m.marker === "status" && m.status === "interrupted");
        expect(interrupted).toHaveLength(1);
        expect(
            store
                .getMessages(SID)
                .filter((m) => m.marker === "status" && m.status !== "interrupted"),
        ).toHaveLength(0);
    });

    it("stamps the live assistant message with the attributed responder exactly once", () => {
        const store = useChatStore();
        store.createStreamingMessage(SID, "run-1");
        store.setStreamingMessageResponder(SID, "participant-a");
        // The attribution is constant per run: a later event must not overwrite it.
        store.setStreamingMessageResponder(SID, "participant-b");

        const live = store.getMessages(SID).find((m) => m.id === store.getStreamingMessageId(SID));
        expect(live?.participantId).toBe("participant-a");
    });

    it("leaves attribution unknown when CP sends none (never back-fills a participant)", () => {
        const store = useChatStore();
        store.createStreamingMessage(SID, "run-1");
        store.setStreamingMessageResponder(SID, null);

        const live = store.getMessages(SID).find((m) => m.id === store.getStreamingMessageId(SID));
        expect(live?.participantId).toBeUndefined();
    });
});
