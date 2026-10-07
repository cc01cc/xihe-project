import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { api } from "../../../composables/api";
import { i18n } from "../../../i18n";
import { useChatStore } from "../../../stores/chat";
import SSEStream from "../SSEStream.vue";

vi.mock("@/services/chatTransport", () => ({
    chatTransport: {
        sendMessages: vi.fn(
            async (
                _sessionId: string,
                options: { onopen?: (response: Response) => void | Promise<void> },
            ) => {
                await options.onopen?.(new Response(null, { status: 200 }));
            },
        ),
        stop: vi.fn(),
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
            vi.fn().mockResolvedValue({
                ok: true,
                status: 202,
                json: async () => ({ status: "accepted", sessionId: "session-a", runId: "run-a" }),
            }),
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
            vi.fn().mockResolvedValue({
                ok: true,
                status: 202,
                json: async () => ({ status: "accepted", sessionId: "session-a", runId: "run-a" }),
            }),
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
