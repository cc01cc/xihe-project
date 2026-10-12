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

describe("MessageItem budget exhaustion (PLAN-0492)", () => {
    function mountBudgetMessage(dimension: string | null, code = "RUN_BUDGET_EXHAUSTED") {
        return mount(MessageItem, {
            props: {
                message: {
                    id: "message-budget",
                    sessionId: "session-1",
                    role: "assistant",
                    content: "partial answer",
                    timestamp: "2026-10-12T00:00:00Z",
                    runId: "run-budget",
                    runStatus: "failed",
                    terminalOutcome: "error",
                    errorCode: code,
                    error: dimension === null ? "upstream failed" : `budgetDimension=${dimension}`,
                    retryable: false,
                },
            },
            global: { plugins: [i18n, createPinia()] },
        });
    }

    it("renders the localized turns reason with the takeover hint", () => {
        const wrapper = mountBudgetMessage("turns");

        const error = wrapper.get('[data-testid="message-error"]');
        expect(error.text()).toContain("RUN_BUDGET_EXHAUSTED");
        expect(error.text()).toContain("budgetDimension=turns");
        expect(error.text()).toContain(i18n.global.t("chat.budgetExhaustedTurns"));
        expect(wrapper.get('[data-testid="message-budget-exhausted-hint"]').text()).toContain(
            i18n.global.t("chat.budgetExhaustedHint"),
        );
        expect(wrapper.find('[data-testid="message-retry-button"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("maps the elapsed and tokens dimensions to their reasons", () => {
        const elapsed = mountBudgetMessage("elapsed");
        expect(elapsed.get('[data-testid="message-error"]').text()).toContain(
            i18n.global.t("chat.budgetExhaustedElapsed"),
        );
        elapsed.unmount();

        const tokens = mountBudgetMessage("tokens");
        expect(tokens.get('[data-testid="message-error"]').text()).toContain(
            i18n.global.t("chat.budgetExhaustedTokens"),
        );
        tokens.unmount();
    });

    it("keeps the raw code/detail rendering for non-budget errors", () => {
        const wrapper = mountBudgetMessage(null, "AGENT_STREAM_FAILED");

        const error = wrapper.get('[data-testid="message-error"]');
        expect(error.text()).toContain("AGENT_STREAM_FAILED: upstream failed");
        expect(wrapper.find('[data-testid="message-budget-exhausted-hint"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("does not repeat the run error on the user message", () => {
        const wrapper = mount(MessageItem, {
            props: {
                message: {
                    id: "message-user-error",
                    sessionId: "session-1",
                    role: "user",
                    content: "keep looping",
                    timestamp: "2026-10-12T00:00:00Z",
                    runId: "run-budget",
                    runStatus: "failed",
                    errorCode: "RUN_BUDGET_EXHAUSTED",
                    error: "budgetDimension=turns",
                },
            },
            global: { plugins: [i18n, createPinia()] },
        });

        expect(wrapper.find('[data-testid="message-error"]').exists()).toBe(false);
        wrapper.unmount();
    });
});
