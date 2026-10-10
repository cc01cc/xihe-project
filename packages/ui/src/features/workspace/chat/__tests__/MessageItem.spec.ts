import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createPinia } from "pinia";
import { i18n } from "../../../../i18n";
import MessageItem from "../components/MessageItem.vue";

describe("MessageItem branch action", () => {
    it("emits the terminal message ID when branching from a visible message", async () => {
        const wrapper = mount(MessageItem, {
            props: {
                message: {
                    id: "message-1",
                    sessionId: "session-1",
                    role: "assistant",
                    content: "answer",
                    timestamp: "2026-09-29T00:00:00Z",
                    runId: "run-1",
                    runStatus: "succeeded",
                },
            },
            global: { plugins: [i18n, createPinia()] },
        });

        await wrapper.get('[data-testid="message-branch-button"]').trigger("click");

        expect(wrapper.emitted("branch")).toEqual([["message-1"]]);
        wrapper.unmount();
    });

    it("does not offer a branch action for an active or runless message", () => {
        const active = mount(MessageItem, {
            props: {
                message: {
                    id: "message-active",
                    sessionId: "session-1",
                    role: "assistant",
                    content: "streaming",
                    timestamp: "2026-09-29T00:00:00Z",
                    runId: "run-active",
                    runStatus: "running",
                },
            },
            global: { plugins: [i18n, createPinia()] },
        });
        const legacy = mount(MessageItem, {
            props: {
                message: {
                    id: "message-legacy",
                    sessionId: "session-1",
                    role: "assistant",
                    content: "legacy",
                    timestamp: "2026-09-29T00:00:00Z",
                },
            },
            global: { plugins: [i18n, createPinia()] },
        });

        expect(active.find('[data-testid="message-branch-button"]').exists()).toBe(false);
        expect(legacy.find('[data-testid="message-branch-button"]').exists()).toBe(false);
        active.unmount();
        legacy.unmount();
    });
});
