/**
 * PLAN-0660 T5.23：`sendChat` 判据回归（run7b 真红）。
 *
 * 背景：run7b 在真栈上 `sendChat` 把 900s 测试预算烧光 —— CP 侧 `event=run_question_asked`
 * 已经证明消息发出去了，但 helper 只认「新气泡可见」一个信号，于是反复重点直到超时。
 *
 * 这里钉死两条**必须同时成立**的边界：
 *   ① 按钮点不动（被遮挡/disabled）**不是**发送证据 —— 不得据此判「已发出」（防假绿）；
 *   ② 三条可观测证据全无时**必须**判未发出（防假绿的反面：不许悄悄放过）。
 */
import { describe, expect, it } from "vitest";
import {
    SEND_BUDGET_MS,
    classifySendAttempt,
    isSendBudgetExhausted,
    messageCountGrew,
    type SendObservation,
} from "../sendEvidence";

function observation(overrides: Partial<SendObservation> = {}): SendObservation {
    return {
        baselineCount: 0,
        bubbleCount: 0,
        bubbleVisible: false,
        inputCleared: false,
        sendBlocked: false,
        ...overrides,
    };
}

describe("classifySendAttempt — 可观测发送证据三选一（PLAN-0660 T5.23）", () => {
    it("① 消息条数比基线增长即视为已发出", () => {
        expect(classifySendAttempt(observation({ baselineCount: 3, bubbleCount: 4 }))).toBe("sent");
    });

    it("② 新气泡真实可见即视为已发出", () => {
        expect(classifySendAttempt(observation({ bubbleVisible: true }))).toBe("sent");
    });

    it("③ 输入框文本已离开即视为已发出", () => {
        expect(classifySendAttempt(observation({ inputCleared: true }))).toBe("sent");
    });

    it("条数与基线相同不算增长（必须严格增长）", () => {
        expect(messageCountGrew(2, 2)).toBe(false);
        expect(messageCountGrew(2, 1)).toBe(false);
        expect(messageCountGrew(2, 3)).toBe(true);
        // 只有「持平」不构成证据，仍要按未发出处理
        expect(classifySendAttempt(observation({ baselineCount: 2, bubbleCount: 2 }))).toBe(
            "retry",
        );
    });
});

describe("classifySendAttempt — 点不动的按钮不得冒充发送证据（run7b 回归）", () => {
    it("按钮被遮挡且无任何证据时不得判已发出", () => {
        const verdict = classifySendAttempt(observation({ sendBlocked: true }));
        expect(verdict).not.toBe("sent");
        expect(verdict).toBe("blocked");
    });

    it("按钮 blocked 但同时输入框已清空，仍算已发出（真的发出去了）", () => {
        expect(classifySendAttempt(observation({ sendBlocked: true, inputCleared: true }))).toBe(
            "sent",
        );
    });

    it("按钮 blocked 但气泡数增长，也算已发出", () => {
        expect(
            classifySendAttempt(
                observation({ sendBlocked: true, baselineCount: 1, bubbleCount: 2 }),
            ),
        ).toBe("sent");
    });
});

describe("classifySendAttempt — 真未发出必须失败（不放宽成「没抛异常就算过」）", () => {
    it("三条证据全无且按钮可点时要求重试，不返回 sent", () => {
        expect(classifySendAttempt(observation())).toBe("retry");
    });

    it("三条证据全无且按钮 blocked 时也不返回 sent", () => {
        expect(classifySendAttempt(observation({ sendBlocked: true }))).toBe("blocked");
    });
});

describe("isSendBudgetExhausted — 总预算封顶（900s 烧光的直接防线）", () => {
    it("默认预算是一分钟级的有界值，不是测试总超时", () => {
        expect(SEND_BUDGET_MS).toBeLessThanOrEqual(180_000);
    });

    it("未到预算不抛、到点即判耗尽", () => {
        expect(isSendBudgetExhausted(0)).toBe(false);
        expect(isSendBudgetExhausted(SEND_BUDGET_MS - 1)).toBe(false);
        expect(isSendBudgetExhausted(SEND_BUDGET_MS)).toBe(true);
        expect(isSendBudgetExhausted(SEND_BUDGET_MS + 1)).toBe(true);
    });

    it("预算可显式覆盖（便于单测与调参）", () => {
        expect(isSendBudgetExhausted(1_500, 1_000)).toBe(true);
        expect(isSendBudgetExhausted(500, 1_000)).toBe(false);
    });
});
