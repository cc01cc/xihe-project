import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * task-101 ② R1：`reconnectAttempt` 的归零条件从「连接成功」改成「连接健康」（寿命 ≥ 阈值）。
 *
 * 背景（§12.8/§12.9）：`onclose` 之后的重连由本层发起，而旧实现 `onopen` 无条件把
 * `reconnectAttempt` 归零 ⇒ 每次「连上就被关」都会把退避打回 250 ms 档，退避永不增长
 * （旧夹具上实测 101 次/30 s，是规范值的 3.4×）。
 */
const fetchEventSourceMock = vi.hoisted(() =>
    vi.fn<(url: string, options: Record<string, unknown>) => Promise<void>>(),
);

vi.mock("@microsoft/fetch-event-source", () => ({ fetchEventSource: fetchEventSourceMock }));

import { chatTransport, SSE_HEALTHY_CONNECTION_MS } from "../chatTransport";

let seq = 0;

/** 组装一份最小 options；回调都用 typed mock，避免 `require-mock-type-parameters`。 */
function makeOptions() {
    return {
        url: "/api/v1/chat/sessions/state-test/stream",
        onopen: vi.fn<() => void>(),
        onmessage: vi.fn<() => void>(),
        onerror: vi.fn<() => void>(),
        onclose: vi.fn<() => void>(),
    };
}

beforeEach(() => {
    // 必须把 Date 也接过来：`setSystemTime` 只有在 Date 被 fake 时才影响 `Date.now()`
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fetchEventSourceMock.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

/**
 * 挂一次连接：mock 内部先 `onopen`，再按模式结束。
 * `liveMs` 用 `vi.setSystemTime` 推进「墙上时间」，但不触发 setTimeout（这样重连不会自己跑起来）。
 */
async function connect(sessionId: string, end: "close" | "fail", liveMs = 0): Promise<void> {
    fetchEventSourceMock.mockImplementationOnce(
        async (_url: string, options: Record<string, unknown>) => {
            if (end === "fail") {
                throw new Error("network down");
            }
            const onopen = options.onopen as (response: Response) => Promise<void>;
            const onclose = options.onclose as () => void;
            await onopen(new Response(null, { status: 200 }));
            if (liveMs > 0) {
                vi.setSystemTime(Date.now() + liveMs);
            }
            onclose();
        },
    );
    await chatTransport.sendMessages(sessionId, makeOptions());
}

describe("chatTransport R1 — 连接健康才清退避", () => {
    it("连上即断连续 5 次 ⇒ reconnectAttempt 单调增长（不再被打回 1）", async () => {
        const sessionId = "r1-churn-" + seq++;
        const seen: number[] = [];
        for (let i = 0; i < 5; i += 1) {
            await connect(sessionId, "close");
            seen.push(chatTransport.getState(sessionId).reconnectAttempt);
        }
        expect(seen, "每次 churn 都该把 attempt 往上推").toEqual([1, 2, 3, 4, 5]);
    });

    it("连接活过阈值再断 ⇒ 结算时把 attempt 归零（下一次重连从 1 档开始）", async () => {
        const sessionId = "r1-healthy-" + seq++;
        await connect(sessionId, "close");
        await connect(sessionId, "close");
        expect(chatTransport.getState(sessionId).reconnectAttempt, "先制造两次 churn").toBe(2);

        await connect(sessionId, "close", SSE_HEALTHY_CONNECTION_MS + 1_000);
        // 健康关闭 ⇒ settleHealth 清零 ⇒ 紧接着 scheduleReconnect 又把它推到 1。
        // 判据不是「等于 0」，而是「回到第 1 档」（churn 情形此刻会是 3）。
        expect(
            chatTransport.getState(sessionId).reconnectAttempt,
            "健康连接的关闭应清零，之后重连回到第 1 档",
        ).toBe(1);
    });

    it("寿命未达阈值（差 1 ms）⇒ 不归零", async () => {
        const sessionId = "r1-almost-" + seq++;
        await connect(sessionId, "close");
        expect(chatTransport.getState(sessionId).reconnectAttempt).toBe(1);

        await connect(sessionId, "close", SSE_HEALTHY_CONNECTION_MS - 1);
        expect(chatTransport.getState(sessionId).reconnectAttempt, "边界：差 1 ms 不算健康").toBe(
            2,
        );
    });

    it("连接失败（onopen 从未执行）⇒ 不算健康，attempt 继续增长", async () => {
        const sessionId = "r1-fail-" + seq++;
        await connect(sessionId, "fail");
        await connect(sessionId, "fail");
        expect(chatTransport.getState(sessionId).reconnectAttempt).toBe(2);
    });

    it("stop 之后不再排重连，且开流时刻被清掉（防止 map 泄漏）", async () => {
        const sessionId = "r1-stop-" + seq++;
        await connect(sessionId, "close");
        expect(chatTransport.getState(sessionId).reconnectAttempt).toBe(1);

        chatTransport.stop(sessionId);
        const attemptAfterStop = chatTransport.getState(sessionId).reconnectAttempt;

        // 计时器已被 stop 清掉 ⇒ 推进时间也不会有新连接
        fetchEventSourceMock.mockClear();
        vi.advanceTimersByTime(60_000);
        expect(fetchEventSourceMock, "stop 后不该再发起连接").not.toHaveBeenCalled();
        expect(chatTransport.getState(sessionId).reconnectAttempt).toBe(attemptAfterStop);
    });
});
