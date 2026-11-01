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

describe("MessageItem no-progress terminal (PLAN-0493)", () => {
    function mountNoProgressMessage(code = "RUN_NO_PROGRESS") {
        return mount(MessageItem, {
            props: {
                message: {
                    id: "message-no-progress",
                    sessionId: "session-1",
                    role: "assistant",
                    content: "partial answer",
                    timestamp: "2026-10-13T00:00:00Z",
                    runId: "run-loop",
                    runStatus: "failed",
                    terminalOutcome: "error",
                    errorCode: code,
                    error: "No progress detected (repeat)",
                    retryable: false,
                },
            },
            global: { plugins: [i18n, createPinia()] },
        });
    }

    it("renders the localized reason with the takeover hint and no retry", () => {
        const wrapper = mountNoProgressMessage();

        const error = wrapper.get('[data-testid="message-error"]');
        expect(error.text()).toContain("RUN_NO_PROGRESS");
        expect(error.text()).toContain(i18n.global.t("chat.noProgressReason"));
        expect(wrapper.get('[data-testid="message-no-progress-hint"]').text()).toContain(
            i18n.global.t("chat.budgetExhaustedHint"),
        );
        expect(wrapper.find('[data-testid="message-retry-button"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("keeps the raw rendering for other error codes", () => {
        const wrapper = mountNoProgressMessage("AGENT_STREAM_FAILED");

        const error = wrapper.get('[data-testid="message-error"]');
        expect(error.text()).toContain("AGENT_STREAM_FAILED: No progress detected (repeat)");
        expect(wrapper.find('[data-testid="message-no-progress-hint"]').exists()).toBe(false);
        wrapper.unmount();
    });
});

// ── PLAN-0622 Resource Governor：429 的提示必须本地化、可操作，且绝不直显英文 detail ──────
describe("MessageItem RESOURCE_EXHAUSTED hint (PLAN-0622)", () => {
    function mountWithError(error: Record<string, unknown>) {
        return mount(MessageItem, {
            props: {
                message: {
                    id: "message-429",
                    sessionId: "session-1",
                    role: "assistant",
                    content: "",
                    timestamp: "2026-11-02T00:00:00Z",
                    errorCode: "RESOURCE_EXHAUSTED",
                    error: "Resource exhausted: model concurrency limit reached",
                    retryable: true,
                    ...error,
                },
            },
            global: { plugins: [i18n, createPinia()] },
        });
    }

    it("renders a localized wait hint for a model limit and never the CP English detail", async () => {
        const wrapper = mountWithError({ resourceKind: "MODEL", retryAfterSeconds: 12 });
        const hint = wrapper.get('[data-testid="message-resource-exhausted"]');
        expect(hint.text()).toContain("12");
        expect(hint.text()).toContain("模型");
        // 不许直显英文 detail 原文。
        expect(wrapper.text()).not.toContain("Resource exhausted: model concurrency limit reached");
        expect(wrapper.text()).not.toContain("RESOURCE_EXHAUSTED");
        expect(
            wrapper.get('[data-testid="message-resource-exhausted-hint"]').text().length,
        ).toBeGreaterThan(0);
        wrapper.unmount();
    });

    // PLAN-0622：错误气泡上的重试按钮曾经直接回显 i18n key（`chat.retry`），真机截图抓到。
    // 这条断言覆盖**所有**错误气泡，不只 429 —— 只要按钮文案是 key 就是缺陷。
    it("renders localized retry wording, never a raw i18n key", async () => {
        const wrapper = mountWithError({ resourceKind: "CONNECTION", retryAfterSeconds: 2 });
        const retry = wrapper.get('[data-testid="message-retry-button"]');
        expect(retry.text(), "a raw i18n key must never reach the user").not.toMatch(
            /^[a-z]+\.[a-zA-Z]+$/,
        );
        expect(retry.text()).toMatch(/重试|retry/i);
        wrapper.unmount();
    });
    // D14：`resourceKind` 必须让用户看到**具体**是哪种资源不够；「资源」只在真的未知时才出现。
    it("renders the concrete CONNECTION wording instead of the unknown-resource fallback", async () => {
        const wrapper = mountWithError({ resourceKind: "CONNECTION", retryAfterSeconds: 2 });
        const exhausted = wrapper.get('[data-testid="message-resource-exhausted"]');
        expect(exhausted.text()).toBe("连接并发已满，约 2 秒后重试");
        expect(exhausted.text()).not.toContain("资源");
        wrapper.unmount();
    });

    it("falls back to the unknown-resource wording only when resourceKind is absent", async () => {
        const wrapper = mountWithError({ resourceKind: undefined, retryAfterSeconds: 2 });
        const exhausted = wrapper.get('[data-testid="message-resource-exhausted"]');
        expect(exhausted.text()).toContain("资源");
        wrapper.unmount();
    });
    it.each([
        ["CONNECTION", "连接"],
        ["FILE_WRITE", "文件写入"],
        ["PROCESS", "进程"],
        ["JOB", "任务"],
        ["MCP", "MCP 调用"],
    ])("names the %s resource kind in Chinese", (kind, label) => {
        const wrapper = mountWithError({ resourceKind: kind, retryAfterSeconds: 5 });
        expect(wrapper.get('[data-testid="message-resource-exhausted"]').text()).toContain(label);
        wrapper.unmount();
    });

    it("falls back to a generic retry hint when the CP sends no wait time", async () => {
        const wrapper = mountWithError({ resourceKind: "CONNECTION" });
        const text = wrapper.get('[data-testid="message-resource-exhausted"]').text();
        expect(text).toContain("连接");
        expect(text).not.toContain("秒");
        wrapper.unmount();
    });
});
