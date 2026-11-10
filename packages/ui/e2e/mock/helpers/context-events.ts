import type { Page } from "@playwright/test";

export async function installContextEventStream(page: Page): Promise<void> {
    await page.addInitScript(() => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const encode = (value: string) => new TextEncoder().encode(value);
        const event = (name: string, data: unknown) =>
            `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        (window as unknown as Record<string, unknown>).__pushContextEvent = (
            name: string,
            data: unknown,
        ) => {
            controller?.enqueue(encode(event(name, data)));
        };
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : input.url;
            if (url.includes("/api/v1/events")) {
                const body = new ReadableStream<Uint8Array>({
                    start(next) {
                        controller = next;
                        next.enqueue(encode("retry: 1000\n\n"));
                    },
                    cancel() {
                        controller = null;
                    },
                });
                return new Response(body, {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                });
            }
            return originalFetch(input, init);
        };
    });
}

export async function pushContextEvent(page: Page, name: string, data: unknown): Promise<void> {
    await page.evaluate(
        ([eventName, payload]) => {
            (window as unknown as Record<string, unknown>).__pushContextEvent!(eventName, payload);
        },
        [name, data] as const,
    );
}

/**
 * 工作区事件流（`GET /api/v1/workspaces/{id}/events`）的**长连接**桩。
 *
 * 真实 CP 把这条流一直开着，只周期发 `heartbeat` 具名事件（`WorkspaceEventManager.java:206-217`）。
 * 旧桩用 `page.route(...).fulfill({ body: "retry: 1000\n\n" })`，而 `route.fulfill` **必定结束响应体**
 * ⇒ 客户端立刻 `clean_close`（`chatTransport.ts:199-207`）⇒ `scheduleReconnect`，`retryDelay(1)` =
 * 250–312 ms，且重连成功后 `reconnectAttempt` 归零（`:150-153`）⇒ **恒速重连**。task-98 实测
 * **101 次 / 30 s**（真实长连接基线是 0）。
 *
 * 有限体无法建模「流」（Playwright 没有流式 fulfill），所以这里改用 in-page `window.fetch` 覆盖
 * （与 `installContextEventStream` 同一手法），返回一个**永不关闭**的 `ReadableStream`。
 *
 * 注意：**不要**在这里先发 `retry: 1000\n\n`。SSE 解析器对空行无条件 dispatch 空消息
 * （`@microsoft/fetch-event-source/lib/esm/parse.js:66-68`），产品的 `JSON.parse(message.data)`
 * 就会记 `workspace_sse_invalid_json` —— 那是 task-101 的产品面，不该由夹具制造。
 * 因此这条流在第一个事件之前**一个字节都不发**。
 */
export async function installWorkspaceEventStream(page: Page): Promise<void> {
    await page.addInitScript(() => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const encode = (value: string) => new TextEncoder().encode(value);
        (window as unknown as Record<string, unknown>).__pushWorkspaceEvent = (
            name: string,
            data: unknown,
        ) => {
            controller?.enqueue(encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            // `input` 也可能是 `URL`（fetch 签名是 `RequestInfo | URL`），`String()` 覆盖这一支。
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : String(input);
            if (/\/api\/v1\/workspaces\/[^/]+\/events(\?|$)/.test(url)) {
                const body = new ReadableStream<Uint8Array>({
                    start(next) {
                        controller = next;
                    },
                    cancel() {
                        controller = null;
                    },
                });
                return new Response(body, {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                });
            }
            return originalFetch(input, init);
        };
    });
}

/** 往页面推一条工作区事件（`event: <name>` + JSON data）。预留钩子，当前没有用例依赖它。 */
export async function pushWorkspaceEvent(page: Page, name: string, data: unknown): Promise<void> {
    await page.evaluate(
        ([eventName, payload]) => {
            const w = window as unknown as {
                __pushWorkspaceEvent?: (name: string, data: unknown) => void;
            };
            w.__pushWorkspaceEvent?.(eventName, payload);
        },
        [name, data] as const,
    );
}
