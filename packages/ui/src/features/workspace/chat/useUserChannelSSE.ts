/**
 * PLAN-0660 T5.6 — the `user-events` client.
 *
 * Why not `EventSource`: it cannot send an `Authorization` header, and this channel is authenticated by
 * the user's Bearer token only (no workspace context, `spec/session/user-channel.md` §4). So the stream
 * is read with `fetch` + incremental `text/event-stream` parsing.
 *
 * Deliberate properties (frozen by the spec):
 * - the three public wire names are the ONLY ones we act on (`connected` / `participant_notified` /
 *   `user_question`); anything else is ignored, never guessed;
 * - **no replay**: the server does not replay, so the client must not "catch up" either (no
 *   `Last-Event-ID`, no backfill request);
 * - reconnect uses exponential backoff 1s → 2s → 4s … capped at 30s;
 * - `dispose()` aborts the in-flight fetch and clears the pending timer (no leaked loops).
 *
 * A reconnect CAN re-deliver the same `participant_notified` (the server keeps no cursor), which is
 * exactly why the hint is idempotent by construction: it only schedules a coalesced roster reload
 * (`userChannelHintCoalescer`), and the badge itself is re-read from CP.
 */

import { logger } from "@/lib/logger";
import { handleUnauthorized as logoutOnUnauthorized } from "@/services/chatTransport";
import { SSE_SUBSCRIBER_LIMIT_CODES } from "../composables/sseSubscriberLimit";

export interface SseFrame {
    event: string;
    data: string;
}

/**
 * Incremental `text/event-stream` parser: chunks may split anywhere (even mid-frame), so the caller
 * feeds decoded strings and receives only complete frames.
 */
export function createSseFrameParser(): (chunk: string) => SseFrame[] {
    let buffer = "";
    return (chunk: string): SseFrame[] => {
        buffer += chunk;
        const frames: SseFrame[] = [];
        let separator = buffer.indexOf("\n\n");
        while (separator >= 0) {
            const raw = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const frame = parseFrame(raw);
            if (frame) frames.push(frame);
            separator = buffer.indexOf("\n\n");
        }
        return frames;
    };
}

function parseFrame(raw: string): SseFrame | null {
    let event = "message";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
            event = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
            data.push(line.slice("data:".length).trimStart());
        }
    }
    if (data.length === 0) return null;
    return { event, data: data.join("\n") };
}

export interface UserChannelSseOptions {
    /** Absolute or relative URL of the user channel. */
    url?: string;
    /** Resolve the current Bearer token (null ⇒ do not connect). */
    getToken: () => string | null;
    /** `participant_notified` — forward the identifiers to the coalescing store action. */
    onNotified: (sessionId: string, participantId: string) => void;
    /** `user_question` — projection hint (M5-B); optional until that lands. */
    onQuestion?: (questionId: string, sessionId: string, state: string) => void;
    /**
     * PLAN-0660 T5.18：`connected` —— 每次（含每次重连后）握手成功回调一次。
     *
     * 用户通道**不 replay**（`spec/session/user-channel.md` §4：断线期间的事件不补发），所以重连
     * 成功后必须由消费方**重拉投影**；否则"断线时被问的问题"要等到下一个事件才会出现。
     */
    onConnected?: () => void;
    /**
     * BL-335：撞上"订阅者上限"（`429 USER_CHANNEL_FULL`）时回调一次，然后**停止重连**
     * —— 上限是持续态，按 1s/2s/4s… 无限重试只会持续占用配额、且在用户看来像"网络抖动"。
     */
    onSubscriberLimit?: (code: string, detail: string | null) => void;
    /**
     * PLAN-0660 T5.18（审计 P1）：`401` —— Bearer token 失效。
     *
     * 默认复用 `chatTransport` 的登出语义（清 token / 用户 / 工作区上下文后跳 `/login`），与聊天
     * SSE 同源。401 是**终态**：清态之后不再重连，否则只是拿同一个坏 token 反复打服务端。
     */
    onUnauthorized?: () => void;
    /** Test seams. */
    fetchImpl?: typeof fetch;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
}

export interface UserChannelSse {
    start: () => void;
    dispose: () => void;
    /** Visible for tests: how many consecutive reconnects were scheduled. */
    attempts: () => number;
}

export function createUserChannelSse(options: UserChannelSseOptions): UserChannelSse {
    const url = options.url ?? "/api/v1/user-events";
    const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const schedule =
        options.schedule ??
        ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    const cancel =
        options.cancel ??
        ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const initialBackoffMs = options.initialBackoffMs ?? 1_000;
    const maxBackoffMs = options.maxBackoffMs ?? 30_000;
    /**
     * 默认登出 = `chatTransport` 的同一实现（单一 401 语义）。
     *
     * 做成可注入的 seam，是为了让单测不必真的清 localStorage / 赋值 `window.location`。
     */
    const onUnauthorized = options.onUnauthorized ?? logoutOnUnauthorized;

    let disposed = false;
    let controller: AbortController | null = null;
    let timer: unknown = null;
    let attempts = 0;
    /**
     * 连接代号：每建立一条新连接 +1。
     *
     * `onConnected` 的语义是「重拉投影」（通道不 replay），所以它必须**每连接恰好一次** —— 不能
     * 靠"服务端只发一次 `connected`"这种外部巧合（重复帧会让投影请求翻倍，而缺帧会让重连后
     * 永不重拉）。这里按连接代号去重，判据在本地闭环。
     */
    let connectionSeq = 0;
    let announcedConnection = -1;

    function planReconnect(): void {
        if (disposed) return;
        attempts += 1;
        const delay = Math.min(initialBackoffMs * 2 ** (attempts - 1), maxBackoffMs);
        timer = schedule(() => {
            timer = null;
            void connect();
        }, delay);
    }

    function dispatch(frame: SseFrame): void {
        if (frame.event === "participant_notified") {
            const payload = safeJson(frame.data);
            const sessionId = stringField(payload, "sessionId");
            const participantId = stringField(payload, "participantId");
            if (sessionId && participantId) {
                options.onNotified(sessionId, participantId);
            }
            return;
        }
        if (frame.event === "user_question" && options.onQuestion) {
            const payload = safeJson(frame.data);
            const questionId = stringField(payload, "questionId");
            const sessionId = stringField(payload, "sessionId");
            const state = stringField(payload, "state");
            if (questionId && sessionId && state) {
                options.onQuestion(questionId, sessionId, state);
            }
            return;
        }
        if (frame.event === "connected") {
            if (announcedConnection !== connectionSeq) {
                announcedConnection = connectionSeq;
                options.onConnected?.();
            }
            return;
        }
        // Any unknown event: nothing to do (unknown names are never guessed).
    }

    async function connect(): Promise<void> {
        if (disposed) return;
        const token = options.getToken();
        if (!token) {
            planReconnect();
            return;
        }
        controller = new AbortController();
        try {
            const response = await fetchImpl(url, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "text/event-stream",
                },
                signal: controller.signal,
            });
            if (!response.ok || !response.body) {
                // PLAN-0660 T5.18（审计 P1）：401 先于 429 判定 —— Bearer 失效是终态，认证都不通时
                // "订阅者上限"没有意义。旧实现没有 401 分支，会拿同一个过期 token 无限退避重连：
                // 用户既不会被登出，也永远连不上，看起来只是"通道一直在抖"。
                if (response.status === 401) {
                    disposed = true;
                    controller?.abort();
                    controller = null;
                    logger.warn("user_channel_sse_unauthorized", {});
                    onUnauthorized();
                    return;
                }
                // BL-335：429 + 订阅者上限码 ⇒ 明确告诉用户"这条通道停了、要关标签页"，且不再重连。
                // 其它失败保持既有退避重连（网络抖动属可恢复）。
                const limit = await readSubscriberLimit(response);
                if (limit) {
                    disposed = true;
                    logger.warn("user_channel_sse_subscriber_limit", {
                        code: limit.code,
                        detail: limit.detail,
                    });
                    options.onSubscriberLimit?.(limit.code, limit.detail);
                    return;
                }
                planReconnect();
                return;
            }
            attempts = 0;
            // 新连接：`connected` 的去重代号随之推进（见 `dispatch` 与 `connectionSeq`）。
            connectionSeq += 1;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const parse = createSseFrameParser();
            for (;;) {
                const { done, value } = await reader.read();
                if (disposed) return;
                if (done) break;
                for (const frame of parse(decoder.decode(value, { stream: true }))) {
                    if (disposed) return;
                    dispatch(frame);
                }
            }
            planReconnect();
        } catch (failure) {
            if (disposed) return;
            // The spec wants a reconnect loop, not a silent swallow: record why before backing off.
            logger.warn("user_channel_sse_disconnected", {
                reason: failure instanceof Error ? failure.message : String(failure),
            });
            planReconnect();
        }
    }

    return {
        start(): void {
            if (disposed) return;
            void connect();
        },
        dispose(): void {
            disposed = true;
            if (timer !== null) {
                cancel(timer);
                timer = null;
            }
            controller?.abort();
            controller = null;
        },
        attempts(): number {
            return attempts;
        },
    };
}

/**
 * BL-335：读出 429 的 problem code，只认"订阅者上限"（其它 429 交回既有重连路径）。
 *
 * ⚠️ 调用方拿到上限后必须**停止重连**，不要"优化"回退避重试：上限是**持续态**（同一用户/工作区的
 * 并发订阅数），退避重试每 1s/2s/4s… 都会再撞一次同一个已满通道 —— 持续占配额，且用户侧只看到
 * "页面不刷新"。该约束由 `__tests__/useUserChannelSSE.spec.ts` 的两条用例钉住
 * （上限 ⇒ 零重连；普通 503 ⇒ 仍退避）。
 */
async function readSubscriberLimit(
    response: Response,
): Promise<{ code: string; detail: string | null } | null> {
    if (response.status !== 429) return null;
    let problem: Record<string, unknown> | null = null;
    try {
        problem = (await response.clone().json()) as Record<string, unknown>;
    } catch {
        return null;
    }
    const code = typeof problem?.code === "string" ? problem.code : null;
    if (!code || !(SSE_SUBSCRIBER_LIMIT_CODES as readonly string[]).includes(code)) return null;
    return { code, detail: typeof problem?.detail === "string" ? problem.detail : null };
}

function safeJson(raw: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function stringField(payload: Record<string, unknown> | null, field: string): string | null {
    const value = payload?.[field];
    return typeof value === "string" && value.length > 0 ? value : null;
}
