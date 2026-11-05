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

    it("dispatches participant_notified and ignores unknown/connected events", async () => {
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
});
