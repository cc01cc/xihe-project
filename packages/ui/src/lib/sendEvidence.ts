/**
 * PLAN-0660 T5.23：`sendChat` 的「消息是否真的发出去了」判据。
 *
 * 为什么单独抽成纯函数：run7b 实测红在 `sendChat` 把 900s 测试预算烧光 ——
 * 点击后 CP 侧已经 `event=run_question_asked`（消息确实发出、`ask_user` 真的被调用），
 * 但 helper 只认「新气泡出现」一个信号，于是反复重试到超时。
 *
 * 现在的判据是**可观测发送证据三选一**，满足任一即视为已发出：
 *   ① 消息列表条目数比点击前多（`baselineCount` 增长）；
 *   ② 新气泡真实可见；
 *   ③ 输入框里的文本已不在（`inputCleared`）。
 *
 * 关键边界：**「发送按钮点不动」本身不是发送证据**。按钮被遮挡/禁用只说明
 * 「这一下点了个空」，既不能据此判定已发出（会假绿），也不能据此判定失败。
 * 所以 `sendBlocked` 只影响「要不要再点」，绝不参与「是否已发出」的判定。
 *
 * 三者都不满足 ≠ 立刻失败：外层仍需在**有界预算**内继续观察，预算耗尽才抛错。
 */

/** 单次尝试结束时的可观测事实。全部为「读到的那一刻」的真实值。 */
export interface SendObservation {
    /** 点击前的消息条数基线。 */
    baselineCount: number;
    /** 本次观察到的消息条数。 */
    bubbleCount: number;
    /** 基线位置那条气泡是否真实可见（选择器真命中，不是「等到了没报错」）。 */
    bubbleVisible: boolean;
    /** 输入框内容里已经不含本次要发送的文本。 */
    inputCleared: boolean;
    /** 发送按钮此刻是否「点不动」：disabled / aria-disabled / 被遮挡 / trial 探测失败。 */
    sendBlocked: boolean;
}

/**
 * `sent` = 有可观测发送证据，可以继续往下走；
 * `blocked` = 按钮点不动且**没有任何**发送证据 —— 再点也是空点，别浪费预算去点；
 * `retry` = 按钮可点但还没看到证据，值得再点一次。
 */
export type SendVerdict = "sent" | "blocked" | "retry";

/** 消息列表条目数是否比基线增长（③ 的判据：必须是严格增长）。 */
export function messageCountGrew(baselineCount: number, bubbleCount: number): boolean {
    return bubbleCount > baselineCount;
}

/**
 * 判定一次尝试的结果。
 *
 * 顺序有意义：**先判证据、再判阻塞**。这样「按钮已禁用 + 输入框已清空」这类
 * **真的发出去了**的组合仍判 `sent`，而不会被误判成 `blocked` 而错过返回。
 */
export function classifySendAttempt(observation: SendObservation): SendVerdict {
    const grew = messageCountGrew(observation.baselineCount, observation.bubbleCount);
    if (grew || observation.bubbleVisible || observation.inputCleared) {
        return "sent";
    }
    return observation.sendBlocked ? "blocked" : "retry";
}

/** `sendChat` 的总预算上限：run7b 用 900s 说明缺这一层，这里显式封顶。 */
export const SEND_BUDGET_MS = 120_000;

/** 预算是否已经耗尽（耗尽即必须抛错，不允许「没抛异常就算过」）。 */
export function isSendBudgetExhausted(
    elapsedMs: number,
    budgetMs: number = SEND_BUDGET_MS,
): boolean {
    return elapsedMs >= budgetMs;
}
