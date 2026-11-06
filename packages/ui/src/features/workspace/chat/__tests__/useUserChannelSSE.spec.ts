import { describe, expect, it, vi } from "vitest";

import { createSseFrameParser, createUserChannelSse } from "../useUserChannelSSE";

/**
 * PLAN-0660 T5.6 — the `user-events` client contract (`spec/session/user-channel.md` §4).
 *
 * Pinned here: incremental frame parsing (chunks may split anywhere), the three public wire names
 * being the only ones acted on, exponential backoff 1s→2s→4s…capped, and `dispose()` really stopping
 * the loop (abort + no further callbacks) — the leak a naive SSE effect always has.
 */
describe("useUserChannelSSE", () => {
    const encoder = new TextEncoder();

    function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
            },
        });
    }

    it("parses frames incrementally, even when a chunk splits a frame", () => {
        const parse = createSseFrameParser();

        expect(parse('event: connected\ndata: {"serv')).toEqual([]);
        const frames = parse(
            'erTime":"t"}\n\nevent: participant_notified\ndata: {"sessionId":"s"}\n\n',
        );

        expect(frames).toHaveLength(2);
        expect(frames[0].event).toBe("connected");
        expect(frames[1]).toEqual({ event: "participant_notified", data: '{"sessionId":"s"}' });
    });

    it("dispatches participant_notified and user_question, ignores unknown events", async () => {
        const onNotified = vi.fn<(sessionId: string, participantId: string) => void>();
        const onQuestion = vi.fn<(questionId: string, sessionId: string, state: string) => void>();
        const client = createUserChannelSse({
            getToken: () => "token-1",
            onNotified,
            onQuestion,
            fetchImpl: async () =>
                new Response(
                    streamOf([
                        'event: connected\ndata: {"serverTime":"t"}\n\n',
                        'event: some_future_event\ndata: {"x":1}\n\n',
                        'event: participant_notified\ndata: {"sessionId":"s-1","participantId":"p-1"}\n\n',
                        'event: user_question\ndata: {"questionId":"q-1","sessionId":"s-1","state":"pending"}\n\n',
                    ]),
                    { status: 200 },
                ),
        });

        client.start();
        await vi.waitFor(() => expect(onNotified).toHaveBeenCalledTimes(1));

        expect(onNotified).toHaveBeenCalledWith("s-1", "p-1");
        expect(onQuestion).toHaveBeenCalledWith("q-1", "s-1", "pending");
        client.dispose();
    });

    it("fires onConnected on every handshake, so the projection refetches after a reconnect (T5.18)", async () => {
        const onConnected = vi.fn<() => void>();
        const client = createUserChannelSse({
            getToken: () => "token-1",
            onNotified: () => {},
            onConnected,
            // Every stream carries exactly one `connected` frame and then ends ⇒ the client reconnects,
            // and the second handshake must fire `onConnected` again. Backoff must be a real macrotask:
            // a microtask chain never yields the loop to `waitFor`'s polling timer (measured OOM).
            fetchImpl: async () =>
                new Response(streamOf(['event: connected\ndata: {"serverTime":"t"}\n\n']), {
                    status: 200,
                }),
            schedule: (callback) => setTimeout(callback, 0),
            cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        });

        client.start();
        await vi.waitFor(() => expect(onConnected.mock.calls.length).toBeGreaterThanOrEqual(2));
        client.dispose();
    });

    it("reconnects with exponential backoff capped at 30s (no replay request)", async () => {
        const delays: number[] = [];
        const fetchImpl = vi.fn<typeof fetch>(async () => {
            throw new Error("boom");
        });
        const client = createUserChannelSse({
            getToken: () => "token-1",
            onNotified: vi.fn<(sessionId: string, participantId: string) => void>(),
            fetchImpl,
            schedule: (callback, delayMs) => {
                delays.push(delayMs);
                // Do not run the callback: we only want the planned sequence.
                void callback;
                return delays.length;
            },
            cancel: () => undefined,
        });

        client.start();
        await vi.waitFor(() => expect(delays).toHaveLength(1));

        // Six rejections in a row: 1s, 2s, 4s, 8s, 16s, then the 30s cap.
        for (let attempt = 0; attempt < 5; attempt++) {
            const pending = delays[delays.length - 1];
            void pending;
            client.start();
            await vi.waitFor(() => expect(delays.length).toBeGreaterThan(attempt + 1));
        }

        expect(delays[0]).toBe(1_000);
        expect(delays[1]).toBe(2_000);
        expect(delays[2]).toBe(4_000);
        expect(delays[3]).toBe(8_000);
        expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
        client.dispose();
    });

    it("stops delivering after dispose (abort + no timers left)", async () => {
        const onNotified = vi.fn<(sessionId: string, participantId: string) => void>();
        let scheduled = 0;
        const client = createUserChannelSse({
            getToken: () => "token-1",
            onNotified,
            fetchImpl: async () =>
                new Response(
                    streamOf([
                        'event: participant_notified\ndata: {"sessionId":"s-1","participantId":"p-1"}\n\n',
                    ]),
                    { status: 200 },
                ),
            schedule: () => {
                scheduled += 1;
                return scheduled;
            },
            cancel: () => undefined,
        });

        client.dispose();
        client.start();

        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(onNotified).not.toHaveBeenCalled();
        expect(client.attempts()).toBe(0);
    });

    /**
     * PLAN-0660 T5.18（审计 P1）：**401 是终态 —— 必须登出，且不再重连**。
     *
     * 旧实现没有 401 分支：`!response.ok` 一律落到退避重连，于是过期 token 会被每 1s/2s/4s…
     * 重打一遍，而用户永远不会被送回登录页 —— 表现只是"用户通道一直在抖"。
     * 这条同时钉三件事：回调恰好一次、fetch 只发一次、一次重连都不排。
     */
    it("logs out and stops reconnecting on 401 (T5.18 audit P1)", async () => {
        const onUnauthorized = vi.fn<() => void>();
        const fetchImpl = vi.fn<typeof fetch>(
            async () =>
                new Response(JSON.stringify({ status: 401, code: "UNAUTHORIZED" }), {
                    status: 401,
                    headers: { "content-type": "application/problem+json" },
                }),
        );
        const delays: number[] = [];
        const client = createUserChannelSse({
            getToken: () => "expired-token",
            onNotified: vi.fn<(sessionId: string, participantId: string) => void>(),
            onUnauthorized,
            fetchImpl,
            schedule: (callback, delayMs) => {
                delays.push(delayMs);
                void callback;
                return delays.length;
            },
            cancel: () => undefined,
        });

        client.start();
        await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));

        // 终态：不排重连、不重复 handshake，disposed 之后 start() 也不复活。
        expect(delays).toEqual([]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(client.attempts()).toBe(0);

        client.start();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(delays).toEqual([]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    /**
     * BL-335：**上限码是持续态，不许退避重试**。
     *
     * 这条用例把"停止重连"钉在测试里：`429 USER_CHANNEL_FULL` ⇒ 回调一次 + **不再 schedule 重连**
     * （否则每 1s/2s/4s… 都去撞同一个已满通道，持续占配额，用户侧看起来只是"网络抖动"）。
     * 未来若有人把这里"优化"回退避重试，这条会红。
     */
    it("stops reconnecting on 429 USER_CHANNEL_FULL and reports the limit once", async () => {
        const delays: number[] = [];
        const onSubscriberLimit = vi.fn<(code: string, detail: string | null) => void>();
        const fetchImpl = vi.fn<typeof fetch>(
            async () =>
                new Response(
                    JSON.stringify({
                        status: 429,
                        code: "USER_CHANNEL_FULL",
                        detail: "too many tabs",
                    }),
                    { status: 429, headers: { "content-type": "application/problem+json" } },
                ),
        );
        const client = createUserChannelSse({
            getToken: () => "token-1",
            onNotified: vi.fn<(sessionId: string, participantId: string) => void>(),
            onSubscriberLimit,
            fetchImpl,
            schedule: (callback, delayMs) => {
                delays.push(delayMs);
                void callback;
                return delays.length;
            },
            cancel: () => undefined,
        });

        client.start();
        await vi.waitFor(() => expect(onSubscriberLimit).toHaveBeenCalledTimes(1));

        expect(onSubscriberLimit).toHaveBeenCalledWith("USER_CHANNEL_FULL", "too many tabs");
        // 上限不是可恢复失败：一次都不该排重连（对照上一条用例的 1s/2s/4s… 序列）。
        expect(delays).toEqual([]);
        // 再 start() 也不会复活（disposed 后的 start 是 no-op）。
        client.start();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(delays).toEqual([]);
    });

    /** 对照：非上限的 5xx 仍走退避重连（别把"上限停连"误伤成"所有失败都停"）。 */
    it("keeps reconnecting on a plain 503 (limit handling must not swallow recoverable errors)", async () => {
        const delays: number[] = [];
        const onSubscriberLimit = vi.fn<(code: string, detail: string | null) => void>();
        const client = createUserChannelSse({
            getToken: () => "token-1",
            onNotified: vi.fn<(sessionId: string, participantId: string) => void>(),
            onSubscriberLimit,
            fetchImpl: async () => new Response("{}", { status: 503 }),
            schedule: (callback, delayMs) => {
                delays.push(delayMs);
                void callback;
                return delays.length;
            },
            cancel: () => undefined,
        });

        client.start();
        await vi.waitFor(() => expect(delays.length).toBeGreaterThan(0));

        expect(onSubscriberLimit).not.toHaveBeenCalled();
        expect(delays[0]).toBe(1_000);
        client.dispose();
    });

    /**
     * P3-4：`onConnected` 的语义是「重拉投影」，必须**每连接恰好一次**。
     *
     * 不靠"服务端只发一次 connected"这种外部巧合 —— 同一连接里重复的 `connected` 不该把投影请求
     * 翻倍（多标签页/代理解包都可能重复），而重连后必须重新回调（否则断线期间的问题永不出现）。
     * 这里用一条只发两帧 `connected` 的流钉住"同连接去重"，第二条连接挂起以免干扰计数。
     */
    it("announces connected once per connection, not once per frame (P3-4)", async () => {
        const onConnected = vi.fn<() => void>();
        let fetches = 0;
        const client = createUserChannelSse({
            getToken: () => "token-1",
            onNotified: vi.fn<(sessionId: string, participantId: string) => void>(),
            onConnected,
            fetchImpl: async () => {
                fetches += 1;
                if (fetches > 1) return new Promise<Response>(() => {});
                return new Response(
                    streamOf([
                        'event: connected\ndata: {"serverTime":"t1"}\n\n',
                        'event: connected\ndata: {"serverTime":"t2"}\n\n',
                    ]),
                    { status: 200 },
                );
            },
            schedule: (callback) => setTimeout(callback, 0),
            cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        });

        client.start();
        await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
        // 两帧都在同一次 read 里派发完了：若守卫失效这里会变成 2。
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(onConnected).toHaveBeenCalledTimes(1);
        client.dispose();
    });
});
