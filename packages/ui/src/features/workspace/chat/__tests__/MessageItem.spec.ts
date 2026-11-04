import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createPinia } from "pinia";
import { i18n } from "../../../../i18n";
import type { Message } from "../../../../types";
import type { SessionParticipantView } from "../../../../types/participant";
import MessageItem from "../components/MessageItem.vue";
import type { ResolvedDelivery } from "../deliveryView";

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

    it("localizes non-budget errors instead of rendering the CP detail", () => {
        const wrapper = mountBudgetMessage(null, "AGENT_STREAM_FAILED");

        const error = wrapper.get('[data-testid="message-error"]');
        // The stable code stays visible (support/debug), the sentence is the localized
        // mapping — the CP's raw English `detail` must not reach the visible surface.
        expect(error.text()).toContain("AGENT_STREAM_FAILED");
        expect(error.text()).toContain("对话流中断，请重试");
        expect(error.text()).not.toContain("upstream failed");
        expect(error.get("span").attributes("title")).toBe("upstream failed");
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

    it("falls back to generic localized copy for other error codes", () => {
        const wrapper = mountNoProgressMessage("PROVIDER_TEMPORARY");

        const error = wrapper.get('[data-testid="message-error"]');
        expect(error.text()).toContain("PROVIDER_TEMPORARY");
        expect(error.text()).toContain(i18n.global.t("chat.streamErrorGeneric"));
        expect(error.text()).not.toContain("No progress detected (repeat)");
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

// ── PLAN-0631 M1 (D31-07 / D31-12) ─────────────────────────────────────────
describe("MessageItem live status line and empty content", () => {
    function mountLive(overrides: Record<string, unknown> = {}, isStreaming = true) {
        return mount(MessageItem, {
            props: {
                isStreaming,
                message: {
                    id: "message-live",
                    sessionId: "session-1",
                    role: "assistant",
                    content: "",
                    timestamp: "2026-11-02T00:00:00Z",
                    ...overrides,
                },
            },
            global: { plugins: [i18n, createPinia()] },
        });
    }

    it("localizes the live status line instead of hardcoding English", () => {
        const thinking = mountLive({ marker: "status", status: "thinking" }, false);
        expect(thinking.text()).toContain(i18n.global.t("chat.thinking"));
        expect(thinking.text()).not.toContain("Thinking...");
        thinking.unmount();

        const executing = mountLive({ marker: "status", status: "executing" }, false);
        expect(executing.text()).toContain(i18n.global.t("chat.toolStatus.running"));
        expect(executing.text()).not.toContain("Executing task...");
        executing.unmount();
    });

    it("does not render an empty bubble while a tool-first run has no text yet", () => {
        // tool_call arrives before any token: no content and no parts.
        const wrapper = mountLive({ toolCalls: [] }, true);
        expect(wrapper.find('[data-slot="bubble"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("renders the bubble as soon as there is content to show", () => {
        const wrapper = mountLive({ parts: [{ type: "text", content: "partial" }] }, true);
        expect(wrapper.find('[data-slot="bubble"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("partial");
        wrapper.unmount();
    });
});

// ── PLAN-0631 M1-B (D31-05 / D31-08 / D31-09) ──────────────────────────────
describe("MessageItem responder identity", () => {
    function participant(overrides: Partial<SessionParticipantView> = {}): SessionParticipantView {
        return {
            participantId: "participant-member",
            principalKind: "AGENT",
            principalId: "principal-member",
            displayName: "Review Bot",
            role: "MEMBER",
            orderIndex: 20,
            wakePolicy: "MENTION",
            respondPolicy: "WHEN_MENTIONED",
            source: "workspace",
            ...overrides,
        };
    }

    function mountMessage(message: Partial<Message> = {}, responder?: SessionParticipantView) {
        return mount(MessageItem, {
            props: {
                message: {
                    id: "message-1",
                    sessionId: "session-1",
                    role: "assistant",
                    content: "answer",
                    timestamp: "2026-11-02T00:00:00Z",
                    ...message,
                },
                ...(responder ? { responder } : {}),
            },
            global: { plugins: [i18n, createPinia()] },
        });
    }

    it("shows who answered for an agent responder: name, role badge and initials", () => {
        const wrapper = mountMessage({ participantId: "participant-member" }, participant());

        const row = wrapper.get('[data-testid="message-responder"]');
        expect(row.attributes("data-participant-id")).toBe("participant-member");
        expect(row.text()).toContain("Review Bot");
        expect(row.text()).not.toContain("participant-member"); // never a UUID
        expect(
            wrapper.get('[data-testid="message-responder-role"]').attributes("data-session-role"),
        ).toBe("MEMBER");
        expect(wrapper.get('[data-testid="message-responder-initials"]').text()).toBe("RB");
        wrapper.unmount();
    });

    it("marks GUARD by icon, not by a new color (same discipline as ParticipantRow)", () => {
        const wrapper = mountMessage(
            { participantId: "participant-guard" },
            participant({
                participantId: "participant-guard",
                displayName: "Guard",
                role: "GUARD",
            }),
        );
        const badge = wrapper.get('[data-testid="message-responder-role"]');
        expect(badge.attributes("data-session-role")).toBe("GUARD");
        expect(badge.find("svg").exists()).toBe(true);
        wrapper.unmount();
    });

    it("treats a speakAs message as somebody else's: left side, with an identity row", () => {
        // role=user but attributed to another HUMAN participant ⇒ not mine.
        const wrapper = mountMessage(
            { role: "user", participantId: "participant-other", content: "spoken for" },
            participant({
                participantId: "participant-other",
                principalKind: "HUMAN",
                principalId: "other-user",
                displayName: "Other Human",
                selfOwned: false,
                source: null,
            }),
        );
        expect(wrapper.get('[data-slot="message"]').attributes("data-align")).toBe("start");
        expect(wrapper.find('[data-testid="message-responder"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("keeps the caller's own message on the right with no identity row", () => {
        const wrapper = mountMessage(
            { role: "user", participantId: "participant-self", content: "mine" },
            participant({
                participantId: "participant-self",
                principalKind: "HUMAN",
                principalId: "me",
                displayName: "Me",
                selfOwned: true,
                source: null,
            }),
        );
        expect(wrapper.get('[data-slot="message"]').attributes("data-align")).toBe("end");
        expect(wrapper.find('[data-testid="message-responder"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("renders no identity row for a message without attribution (never back-fills PRIMARY)", () => {
        const wrapper = mountMessage({ participantId: undefined });
        expect(wrapper.find('[data-testid="message-responder"]').exists()).toBe(false);
        expect(wrapper.get('[data-slot="message"]').attributes("data-align")).toBe("start");
        wrapper.unmount();
    });

    it("never offers a direct retry for an ambiguous outcome, even if the wire says retryable", () => {
        const wrapper = mountMessage({
            role: "assistant",
            content: "half done",
            error: "provider uncertain",
            errorCode: "AGENT_STREAM_AMBIGUOUS",
            retryable: true,
            terminalOutcome: "ambiguous",
            runStatus: "ambiguous",
        });
        expect(wrapper.find('[data-testid="message-retry-button"]').exists()).toBe(false);

        const failed = mountMessage({
            role: "assistant",
            content: "boom",
            error: "provider failed",
            retryable: true,
            terminalOutcome: "error",
            runStatus: "failed",
        });
        expect(failed.find('[data-testid="message-retry-button"]').exists()).toBe(true);
        wrapper.unmount();
        failed.unmount();
    });
});

// ── PLAN-0631 M1-C (D31-02) ────────────────────────────────────────────────
describe("MessageItem terminal markers", () => {
    function mountTerminal(message: Partial<Message>) {
        return mount(MessageItem, {
            props: {
                message: {
                    id: "message-terminal",
                    sessionId: "session-1",
                    role: "assistant",
                    content: "whatever the run produced",
                    timestamp: "2026-11-02T00:00:00Z",
                    ...message,
                },
            },
            global: { plugins: [i18n, createPinia()] },
        });
    }

    it("marks a partial run at the row end, with label + title from the resolver", () => {
        const wrapper = mountTerminal({ runStatus: "partial", terminalOutcome: "partial" });

        const marker = wrapper.get('[data-testid="message-terminated"]');
        expect(marker.attributes("data-run-outcome")).toBe("partial");
        expect(marker.text()).toBe(i18n.global.t("chat.derivedStateOutcome.partial"));
        // Screen reader + hover get the same sentence; the icon is the only colour cue.
        expect(marker.attributes("aria-label")).toBe(marker.text());
        expect(marker.attributes("title")).toBe(marker.text());
        expect(marker.find("svg").exists()).toBe(true);
        wrapper.unmount();
    });

    it("marks a cancelled run at the row end", () => {
        const wrapper = mountTerminal({ runStatus: "cancelled", terminalOutcome: "cancelled" });

        const marker = wrapper.get('[data-testid="message-terminated"]');
        expect(marker.attributes("data-run-outcome")).toBe("cancelled");
        expect(marker.text()).toBe(i18n.global.t("chat.followUpStatusCancelled"));
        expect(marker.attributes("title")).toBe(marker.text());
        wrapper.unmount();
    });

    it("stays silent for a succeeded run and defers to the error box for a failed one", () => {
        const succeeded = mountTerminal({ runStatus: "succeeded", terminalOutcome: "success" });
        expect(succeeded.find('[data-testid="message-terminated"]').exists()).toBe(false);
        succeeded.unmount();

        const failed = mountTerminal({
            runStatus: "failed",
            terminalOutcome: "error",
            error: "provider failed",
            errorCode: "AGENT_STREAM_FAILED",
        });
        expect(failed.find('[data-testid="message-terminated"]').exists()).toBe(false);
        expect(failed.find('[data-testid="message-error"]').exists()).toBe(true);
        failed.unmount();
    });

    it("renders no marker for a run that is still live or has no status", () => {
        for (const runStatus of ["streaming", "awaiting_approval", undefined] as const) {
            const wrapper = mountTerminal({ runStatus });
            expect(wrapper.find('[data-testid="message-terminated"]').exists()).toBe(false);
            wrapper.unmount();
        }
    });
});

// ── PLAN-0659 T1.2 (actor 徽标) ─────────────────────────────────────────────
describe("MessageItem actor badges (PLAN-0659 T1.2)", () => {
    function participant(overrides: Partial<SessionParticipantView> = {}): SessionParticipantView {
        return {
            participantId: "part-agent-alpha",
            principalKind: "AGENT",
            principalId: "agent-alpha",
            displayName: "Agent Alpha",
            role: "MEMBER",
            orderIndex: 40,
            wakePolicy: "ALL_MESSAGES",
            respondPolicy: "ALWAYS",
            source: "workspace",
            ...overrides,
        };
    }

    function mountActorMessage(
        message: Partial<Message> = {},
        options: { responder?: SessionParticipantView; showActor?: boolean } = {},
    ) {
        return mount(MessageItem, {
            props: {
                message: {
                    id: "message-actor",
                    sessionId: "session-1",
                    role: "assistant",
                    content: "answer",
                    timestamp: "2026-11-04T00:00:00Z",
                    ...message,
                },
                ...(options.responder ? { responder: options.responder } : {}),
                ...(options.showActor === undefined ? {} : { showActor: options.showActor }),
            },
            global: { plugins: [i18n, createPinia()] },
        });
    }

    it("puts an actor badge on the process row in a mixed-principal thread", () => {
        const wrapper = mountActorMessage(
            { participantId: "part-agent-alpha", marker: "status", status: "thinking" },
            { responder: participant(), showActor: true },
        );
        const badge = wrapper
            .get('[data-testid="process-thinking"]')
            .get('[data-testid="process-row-actor"]');
        expect(badge.attributes("data-actor-principal-id")).toBe("part-agent-alpha");
        expect(badge.attributes("data-actor-kind")).toBe("AGENT");
        expect(badge.text()).toContain("Agent Alpha");
        wrapper.unmount();
    });

    it("keeps process rows unlabeled in a single-principal thread (showActor=false)", () => {
        const wrapper = mountActorMessage(
            { participantId: "part-agent-alpha", marker: "status", status: "thinking" },
            { responder: participant(), showActor: false },
        );
        expect(wrapper.find('[data-testid="process-row-actor"]').exists()).toBe(false);
        // 身份行仍在（消息级身份不靠过程行徽标承担）：marker 消息没有消息体，换普通消息
        // 看同一 responder 的身份行。
        const message = mountActorMessage(
            { participantId: "part-agent-alpha" },
            { responder: participant(), showActor: false },
        );
        expect(message.find('[data-testid="message-responder"]').exists()).toBe(true);
        wrapper.unmount();
        message.unmount();
    });

    it("passes the same actor down to tool cards", () => {
        const wrapper = mountActorMessage(
            {
                participantId: "part-agent-alpha",
                toolCalls: [
                    {
                        id: "tc-1",
                        name: "read_file",
                        arguments: "{}",
                        status: "completed",
                        startedAt: "2026-11-04T00:00:01.000Z",
                    },
                ],
            },
            { responder: participant(), showActor: true },
        );
        const badge = wrapper
            .get('[data-testid="tool-card"]')
            .get('[data-testid="process-row-actor"]');
        expect(badge.attributes("data-actor-principal-id")).toBe("part-agent-alpha");
        wrapper.unmount();
    });

    it("carries the actor identity on the message identity dot (DOM assertion surface)", () => {
        const wrapper = mountActorMessage(
            { participantId: "part-agent-beta" },
            {
                responder: participant({
                    participantId: "part-agent-beta",
                    principalId: "agent-beta",
                    displayName: "Agent Beta",
                }),
            },
        );
        const dot = wrapper.get('[data-testid="message-responder-initials"]');
        expect(dot.attributes("data-actor-principal-id")).toBe("part-agent-beta");
        expect(dot.attributes("data-actor-kind")).toBe("AGENT");
        expect(dot.text()).toBe("AB");
        wrapper.unmount();
    });

    it("renders no actor anywhere without server attribution (never back-fills PRIMARY)", () => {
        const wrapper = mountActorMessage(
            { participantId: undefined, marker: "status", status: "thinking" },
            { showActor: true },
        );
        expect(wrapper.find('[data-testid="process-row-actor"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="message-responder"]').exists()).toBe(false);
        wrapper.unmount();
    });
});

// ── PLAN-0659 T1.3 (投递语义) ───────────────────────────────────────────────
describe("MessageItem delivery header (PLAN-0659 T1.3)", () => {
    function mountDelivery(message: Partial<Message>, delivery?: ResolvedDelivery) {
        return mount(MessageItem, {
            props: {
                message: {
                    id: "message-delivery",
                    sessionId: "session-1",
                    role: "user",
                    content: "请 @Member Two 一起看",
                    timestamp: "2026-11-04T00:00:00Z",
                    ...message,
                },
                ...(delivery ? { delivery } : {}),
            },
            global: { plugins: [i18n, createPinia()] },
        });
    }

    it("renders 发送 / 抄送 / 被@ 三态: @ highlighted as its own chip", () => {
        const wrapper = mountDelivery(
            {},
            { to: ["Owner One"], mentions: ["Member Two"], cc: ["Viewer Three"] },
        );

        const header = wrapper.get('[data-testid="message-delivery"]');
        expect(header.text()).toContain(i18n.global.t("chat.delivery.to", { name: "Owner One" }));
        expect(header.text()).toContain(
            i18n.global.t("chat.delivery.cc", { names: "Viewer Three" }),
        );
        const mention = wrapper.get('[data-testid="message-delivery-mention"]');
        expect(mention.text()).toBe("@Member Two");
        expect(mention.attributes("title")).toBe(
            i18n.global.t("chat.delivery.mentioned", { name: "Member Two" }),
        );
        // 单引用的 @ 不再重复进抄送名单（去重在三态解析里做）。
        expect(header.text()).not.toContain("Member Two,");
        wrapper.unmount();
    });

    it("renders mention-only delivery (history messages after BL-239 loses TO/CC)", () => {
        const wrapper = mountDelivery({}, { to: [], mentions: ["Member Two"], cc: [] });
        expect(wrapper.find('[data-testid="message-delivery-to"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="message-delivery-cc"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="message-delivery-mention"]').text()).toBe("@Member Two");
        wrapper.unmount();
    });

    it("renders a multi-target TO set as one joined 发送 line (PLAN-0665 M2)", () => {
        const wrapper = mountDelivery(
            {},
            {
                to: ["Owner One", "Agent Alpha"],
                mentions: [],
                cc: [],
            },
        );
        const header = wrapper.get('[data-testid="message-delivery"]');
        expect(header.text()).toContain(
            i18n.global.t("chat.delivery.to", { name: "Owner One、Agent Alpha" }),
        );
        wrapper.unmount();
    });

    it("renders no delivery header when there is nothing to show", () => {
        const wrapper = mountDelivery({});
        expect(wrapper.find('[data-testid="message-delivery"]').exists()).toBe(false);
        wrapper.unmount();
    });
});
