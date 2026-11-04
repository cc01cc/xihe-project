import { expect } from "@playwright/test";
import { CP_URL } from "./journey";

/**
 * 会话级 SSE 订阅保活（产品门，非测试技巧）。
 *
 * `POST /api/v1/chat` 在落库前先校验 `SseEmitterManager.hasEmitter(sessionId)`
 * （`ChatController:553`），没有活跃订阅直接 `409 SSE_SUBSCRIPTION_REQUIRED`
 * （DEV-014 / inventory）。所以**只用 API 发送的 spec 必须先建立订阅**。
 *
 * 为什么不用 `APIRequestContext`：它会缓冲整个响应体，而 `/events` 是长连接
 * （`heartbeat` 15s，`done` 只结束 run 不关连接），`request.get` 永远不返回。
 * 因此这里用 Node 原生 `fetch` 拿流，交给后台 reader 持续抽干。
 *
 * 返回值是幂等 disposer：`afterAll` 里调用，断开订阅（CP 侧 `onCompletion`
 * 回收 emitter），避免把已结束的 spec 的半开连接留给下一个用例。
 */
export async function openSessionSse(
    sessionId: string,
    token: string,
    extraHeaders: Record<string, string> = {},
): Promise<() => void> {
    const controller = new AbortController();
    const response = await fetch(
        `${CP_URL}/api/v1/events?sessionId=${encodeURIComponent(sessionId)}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "text/event-stream",
                ...extraHeaders,
            },
            signal: controller.signal,
        },
    );
    // 失败消息只带状态码：读 body 会把流消费掉，成功路径就拿不到事件了。
    expect(response.status, `SSE subscription failed: HTTP ${response.status}`).toBe(200);

    const reader = response.body?.getReader();
    let closed = false;
    void (async () => {
        try {
            while (!closed) {
                const chunk = await reader?.read();
                if (!chunk || chunk.done) break;
            }
        } catch {
            // disposer 主动 abort（或服务端正常挂断）：没有可上报的失败。
        }
    })();

    return () => {
        closed = true;
        controller.abort();
        if (reader) void reader.cancel().catch(() => {});
    };
}
