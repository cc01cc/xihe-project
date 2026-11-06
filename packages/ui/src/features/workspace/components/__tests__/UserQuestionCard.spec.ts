import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import UserQuestionCard from "../UserQuestionCard.vue";
import type { UserQuestionView } from "../../../types/userQuestion";

/**
 * PLAN-0660 T5.20/T5.22 —— 问题卡的契约面。
 *
 * 这里钉三件事：①四态**真的**渲染成四种可区分的样子（不是"只有一个态实现了、其余靠默认"）；
 * ②只有 `pending` 能作答，且提交出去的是 trim 后的文本；③`prompt`/`answer` 是不可信文本，
 * 带尖括号也必须原样显示成文本（卡片绝不能走 `v-html`）。
 */
function question(overrides: Partial<UserQuestionView> = {}): UserQuestionView {
    return {
        id: "q-1",
        sessionId: "s-1",
        runId: "r-1",
        state: "pending",
        prompt: "要继续执行吗？",
        answer: null,
        expiresAt: null,
        createdAt: "2026-11-06T12:00:00Z",
        firstDeliveredAt: null,
        settledAt: null,
        ...overrides,
    };
}

function mountCard(
    props: Partial<{ question: UserQuestionView; submitting: boolean; errorText: string }> = {},
) {
    return mount(UserQuestionCard, {
        props: { question: question(), ...props },
        global: { plugins: [i18n] },
    });
}

describe("UserQuestionCard（PLAN-0660 T5.20 四态渲染）", () => {
    it("pending：可作答，显示输入框与提交按钮", () => {
        const card = mountCard();

        expect(card.get("[data-testid=user-question-card]").attributes("data-state")).toBe(
            "pending",
        );
        expect(card.get("[data-testid=user-question-state]").text()).toBe("待回答");
        expect(card.find("[data-testid=user-question-input]").exists()).toBe(true);
        expect(card.find("[data-testid=user-question-submit]").exists()).toBe(true);
        expect(card.find("[data-testid=user-question-answer]").exists()).toBe(false);
    });

    it("answered：只读展示答案，不再提供输入", () => {
        const card = mountCard({
            question: question({
                state: "answered",
                answer: "继续",
                settledAt: "2026-11-06T12:00:05Z",
            }),
        });

        expect(card.get("[data-testid=user-question-card]").attributes("data-state")).toBe(
            "answered",
        );
        expect(card.get("[data-testid=user-question-state]").text()).toBe("已回答");
        expect(card.get("[data-testid=user-question-answer]").text()).toBe("继续");
        expect(card.find("[data-testid=user-question-input]").exists()).toBe(false);
        expect(card.find("[data-testid=user-question-submit]").exists()).toBe(false);
    });

    it("expired 与 cancelled：无输入，且两者状态文案不同（不能合并成「已结束」）", () => {
        const expired = mountCard({ question: question({ state: "expired" }) });
        const cancelled = mountCard({ question: question({ state: "cancelled" }) });

        expect(expired.get("[data-testid=user-question-card]").attributes("data-state")).toBe(
            "expired",
        );
        expect(cancelled.get("[data-testid=user-question-card]").attributes("data-state")).toBe(
            "cancelled",
        );
        expect(expired.get("[data-testid=user-question-state]").text()).toBe("已过期");
        expect(cancelled.get("[data-testid=user-question-state]").text()).toBe("已取消");
        for (const card of [expired, cancelled]) {
            expect(card.find("[data-testid=user-question-input]").exists()).toBe(false);
            expect(card.find("[data-testid=user-question-submit]").exists()).toBe(false);
        }
    });

    it("只有限时提问（expiresAt 非 null）才显示截止时间", () => {
        expect(mountCard().find("[data-testid=user-question-deadline]").exists()).toBe(false);

        const timed = mountCard({ question: question({ expiresAt: "2026-11-06T12:10:00Z" }) });
        expect(timed.find("[data-testid=user-question-deadline]").exists()).toBe(true);
    });

    it("提交出去的是 trim 后的文本；空/纯空白时按钮禁用", async () => {
        const card = mountCard();
        const input = card.get("[data-testid=user-question-input]");
        const submit = card.get("[data-testid=user-question-submit]");

        expect(submit.attributes("disabled")).toBeDefined();

        await input.setValue("   继续   ");
        expect(submit.attributes("disabled")).toBeUndefined();

        await submit.trigger("click");
        expect(card.emitted("answer")).toEqual([["继续"]]);
    });

    it("submitting 时禁用提交按钮（防重复点）", () => {
        const card = mountCard({ submitting: true, question: question({ state: "pending" }) });
        expect(card.get("[data-testid=user-question-submit]").attributes("disabled")).toBeDefined();
        expect(card.get("[data-testid=user-question-input]").attributes("disabled")).toBeDefined();
    });

    it("错误文案以 role=alert 呈现，且不回显 CP 的英文 detail（由调用方映射后传入）", () => {
        const card = mountCard({ errorText: "回答没能送达 Agent，请重试" });
        const alert = card.get("[data-testid=user-question-error]");

        expect(alert.attributes("role")).toBe("alert");
        expect(alert.text()).toBe("回答没能送达 Agent，请重试");
    });

    it("prompt 是不可信文本：尖括号原样显示，绝不渲染成 HTML", () => {
        const card = mountCard({
            question: question({ prompt: '<img src=x onerror="alert(1)">' }),
        });

        const prompt = card.get("[data-testid=user-question-prompt]");
        expect(prompt.text()).toBe('<img src=x onerror="alert(1)">');
        expect(prompt.find("img").exists()).toBe(false);
    });
});
