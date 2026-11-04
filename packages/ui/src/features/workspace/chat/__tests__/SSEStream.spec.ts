import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { api } from "../../../../composables/api";
import { i18n } from "../../../../i18n";
import { useChatStore } from "../stores/chat.ts";
import { chatTransport } from "@/services/chatTransport";
import SSEStream from "../components/SSEStream.vue";

vi.mock("@/services/chatTransport", () => ({
    chatTransport: {
        sendMessages: vi.fn<typeof chatTransport.sendMessages>(
            async (
                _sessionId: string,
                options: { onopen?: (response: Response) => void | Promise<void> },
            ) => {
                await options.onopen?.(new Response(null, { status: 200 }));
            },
        ),
        stop: vi.fn<typeof chatTransport.stop>(),
    },
}));

beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SSEStream session ownership", () => {
    it("does not reuse session A run id after switching to session B", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>().mockResolvedValue({
                ok: true,
                status: 202,
                json: async () => ({ status: "accepted", sessionId: "session-a", runId: "run-a" }),
            } as Response),
        );
        const cancel = vi
            .spyOn(api, "cancelChatRun")
            .mockResolvedValue({ status: "cancelled", runId: "run-a" });
        const wrapper = mount(SSEStream, {
            props: { sessionId: "session-a", active: true },
            global: { plugins: [i18n] },
        });

        await (
            wrapper.vm as unknown as {
                sendMessage: (content: string, options: { branchId: string }) => Promise<unknown>;
            }
        ).sendMessage("run", { branchId: "branch-a" });
        await wrapper.setProps({ sessionId: "session-b" });
        await (wrapper.vm as unknown as { stopStreaming: () => void }).stopStreaming();

        expect(cancel).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("refreshes authoritative run state after cancelling from the stream", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>().mockResolvedValue({
                ok: true,
                status: 202,
                json: async () => ({ status: "accepted", sessionId: "session-a", runId: "run-a" }),
            } as Response),
        );
        const chatStore = useChatStore();
        const refreshRunRecovery = vi
            .spyOn(chatStore, "refreshRunRecovery")
            .mockResolvedValue(undefined);
        const cancel = vi
            .spyOn(api, "cancelChatRun")
            .mockResolvedValue({ status: "cancel_accepted", runId: "run-a" });
        const wrapper = mount(SSEStream, {
            props: { sessionId: "session-a", active: true },
            global: { plugins: [i18n] },
        });

        await (
            wrapper.vm as unknown as {
                sendMessage: (content: string, options: { branchId: string }) => Promise<unknown>;
            }
        ).sendMessage("run", { branchId: "branch-a" });
        (wrapper.vm as unknown as { stopStreaming: () => void }).stopStreaming();
        await flushPromises();

        expect(cancel).toHaveBeenCalledWith("run-a");
        expect(refreshRunRecovery).toHaveBeenCalledWith("session-a", "run-a");
        wrapper.unmount();
    });
});

describe("SSEStream terminal error scoping", () => {
    type StreamHandlers = {
        onmessage?: (event: { event: string; data: string; id?: string }) => void | Promise<void>;
    };

    async function mountStream(sessionId = "session-terminal") {
        let handlers: StreamHandlers = {};
        vi.mocked(chatTransport.sendMessages).mockImplementation(async (_sessionId, options) => {
            handlers = options as StreamHandlers;
            await options.onopen?.(new Response(null, { status: 200 }));
        });
        const wrapper = mount(SSEStream, {
            props: { sessionId, active: true },
            global: { plugins: [i18n] },
        });
        await flushPromises();
        return {
            wrapper,
            async push(event: string, data: unknown) {
                await handlers.onmessage?.({ event, data: JSON.stringify(data) });
                await flushPromises();
            },
        };
    }

    it("keeps the failed run's surfaced error and does not relabel it at done", async () => {
        const { wrapper, push } = await mountStream(),
            chatStore = useChatStore();

        await push("token", { content: "partial response" });
        await push("error", {
            code: "PROVIDER_TEMPORARY",
            detail: "Provider temporarily unavailable",
            retryable: true,
        });
        await push("done", { outcome: "partial" });

        const assistants = chatStore
            .getMessages("session-terminal")
            .filter((message) => message.role === "assistant");
        // One bubble: the terminal error already delivered the failure surface, so `done`
        // must not spawn a second, contentless error message.
        expect(assistants).toHaveLength(1);
        expect(assistants[0].content).toBe("partial response");
        expect(assistants[0].errorCode).toBe("PROVIDER_TEMPORARY");
        // A failed/partial run is never reported as a normal completion.
        expect(assistants[0].runStatus).not.toBe("succeeded");
        expect(assistants[0].terminalOutcome).toBe("partial");
        wrapper.unmount();
    });

    it("does not resurrect a finished run when the 202 body lands after its terminal event", async () => {
        const sessionId = "session-race";
        let resolvePost: ((response: Response) => void) | undefined;
        let handlers: StreamHandlers = {};
        vi.mocked(chatTransport.sendMessages).mockImplementation(async (_sid, options) => {
            handlers = options as StreamHandlers;
            await options.onopen?.(new Response(null, { status: 200 }));
        });
        // The POST response is held back on purpose: the run's events travel on a different
        // connection, and nothing orders them against this body.
        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>().mockImplementation(
                () =>
                    new Promise<Response>((resolve) => {
                        resolvePost = resolve;
                    }),
            ),
        );
        const wrapper = mount(SSEStream, {
            props: { sessionId, active: true },
            global: { plugins: [i18n] },
        });
        await flushPromises();

        const sending = (
            wrapper.vm as unknown as {
                sendMessage: (content: string, options: { branchId: string }) => Promise<unknown>;
            }
        ).sendMessage("hi", { branchId: "branch-a" });
        await flushPromises();

        await handlers.onmessage?.({
            event: "token",
            data: JSON.stringify({ content: "partial" }),
        });
        await handlers.onmessage?.({
            event: "error",
            data: JSON.stringify({
                code: "PROVIDER_TEMPORARY",
                detail: "Provider temporarily unavailable",
                retryable: true,
            }),
        });
        await flushPromises();
        expect(useChatStore().isStreaming(sessionId)).toBe(false);

        resolvePost?.({
            ok: true,
            status: 202,
            json: async () => ({ status: "accepted", sessionId, runId: "run-race" }),
        } as Response);
        await sending;
        await flushPromises();

        const chatStore = useChatStore();
        // The run already ended; late `202` bookkeeping must not put the composer back into
        // "thinking" (a phantom active run that never terminates and swallows the next send).
        expect(chatStore.isStreaming(sessionId)).toBe(false);
        const assistants = chatStore
            .getMessages(sessionId)
            .filter((message) => message.role === "assistant");
        expect(assistants).toHaveLength(1);
        expect(assistants[0].errorCode).toBe("PROVIDER_TEMPORARY");
        wrapper.unmount();
    });

    it("does not replay the previous run's error onto the next run", async () => {
        const { wrapper, push } = await mountStream(),
            chatStore = useChatStore();

        await push("token", { content: "first attempt" });
        await push("error", { code: "PROVIDER_TEMPORARY", detail: "boom", retryable: true });

        // Retry: a new run on the same connection streams a healthy reply.
        await push("token", { content: "recovered response" });
        await push("done", {});

        const assistants = chatStore
            .getMessages("session-terminal")
            .filter((message) => message.role === "assistant");
        expect(assistants).toHaveLength(2);
        expect(assistants[0].errorCode).toBe("PROVIDER_TEMPORARY");

        const recovered = assistants[1];
        expect(recovered.content).toBe("recovered response");
        expect(recovered.errorCode).toBeUndefined();
        expect(recovered.runStatus).toBe("succeeded");
        expect(recovered.terminalOutcome).toBe("success");
        wrapper.unmount();
    });

    it("keeps two concurrent runs in separate bubbles and finalizes each on its own done", async () => {
        // PLAN-0645 M2: cap=2 means two runs can stream into one session at once. Before this
        // change both replies' tokens were written into a single bubble and the first `done`
        // froze it — the "mixed stream" the plan's案 B described.
        const sessionId = "session-per-run";
        const { wrapper, push } = await mountStream(sessionId),
            chatStore = useChatStore();

        await push("token", { content: "a1", runId: "run-a" });
        await push("token", { content: "b1", runId: "run-b" });
        await push("token", { content: "a2", runId: "run-a" });
        await push("token", { content: "b2", runId: "run-b" });

        const assistants = chatStore
            .getMessages(sessionId)
            .filter((message) => message.role === "assistant");
        expect(assistants).toHaveLength(2, "one bubble per run, not one per session");
        const bubbleA = assistants.find((message) => message.runId === "run-a"),
            bubbleB = assistants.find((message) => message.runId === "run-b");
        expect(bubbleA?.parts?.map((part) => part.content).join("")).toBe("a1a2");
        expect(bubbleB?.parts?.map((part) => part.content).join("")).toBe("b1b2");
        expect(chatStore.isStreaming(sessionId)).toBe(true);

        // run A finishes: only A's bubble freezes, the session is still streaming for B.
        await push("done", { outcome: "success", runId: "run-a" });
        expect(bubbleA?.isStreaming).toBe(false);
        expect(bubbleB?.isStreaming).toBe(true);
        expect(chatStore.isStreaming(sessionId)).toBe(true);

        await push("done", { outcome: "success", runId: "run-b" });
        expect(bubbleB?.isStreaming).toBe(false);
        expect(chatStore.isStreaming(sessionId)).toBe(false);
        wrapper.unmount();
    });

    it("keeps a tool-first run in one bubble and releases the composer on done (BL-229)", async () => {
        // BL-229 真实 wire：tool 事件同时带 Agent 的 snake `run_id`（LangChain 回调 id）与
        // CP 的 camel `runId`（ChatRun id），而 `done` 只认后者。按 `run_id` 分流会留下孤儿活
        // scope ⇒ `isStreaming()` 不回 idle ⇒ composer 停在停止键（发送键从 DOM 消失）。
        const sessionId = "session-tool-first";
        const { wrapper, push } = await mountStream(sessionId),
            chatStore = useChatStore();
        const assistants = () =>
            chatStore.getMessages(sessionId).filter((message) => message.role === "assistant");

        await push("tool_call", {
            tool: "run_command",
            arguments: { command: "ls" },
            run_id: "lc-tool-1",
            runId: "run-cp",
            toolCallId: "lc-tool-1",
        });
        await push("tool_result", {
            tool: "run_command",
            result: "a.txt",
            run_id: "lc-tool-1",
            runId: "run-cp",
            toolCallId: "lc-tool-1",
        });
        await push("token", { content: "finished", runId: "run-cp" });

        // tool-first: the bubble already exists before the first token, and the token joins it.
        expect(assistants()).toHaveLength(1);
        expect(chatStore.isStreaming(sessionId)).toBe(true);

        await push("done", { outcome: "success", runId: "run-cp" });

        expect(assistants()).toHaveLength(1);
        expect(assistants()[0].content).toBe("finished");
        expect(assistants()[0].toolCalls?.[0]).toMatchObject({
            id: "lc-tool-1",
            status: "completed",
        });
        expect(assistants()[0].isStreaming).toBe(false);
        expect(chatStore.isStreaming(sessionId)).toBe(false);
        expect(chatStore.getSessionRunState(sessionId).status).toBe("idle");
        wrapper.unmount();
    });
});
