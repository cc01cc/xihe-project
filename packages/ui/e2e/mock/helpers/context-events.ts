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
/**
 * task-101 ② 的测量场景（`XH_FIXTURE_SSE_SCENARIO`）。
 *
 * 存在的理由：R1 的判据是「**30 s 观测窗内连接数**」，而现成的 spec 只活 1.8–2.8 s ——
 * 没有固定分母就没法说「30 s 内多少次」。所以需要一个能被固定在某个场景里、
 * 反复以同样方式关流的夹具。
 *
 * 关键实现细节：**用 `controller.close()`（服务器正常结束），不是 `cancel()`** ——
 * 前者让响应体正常结束 ⇒ 库 `getBytes` resolve ⇒ 我们的 `onclose`（`reason: clean_close`）；
 * 后者只是客户端放弃读，走的不是同一条分支。造场景要造在正确的分支上。
 */
export type WorkspaceStreamScenario =
    | { kind: "hold" }
    | { kind: "closeSoon" }
    | { kind: "eventThenClose"; ms: number }
    | { kind: "closeAfter"; ms: number };

/** `event-then-close` 场景里「先发一条事件」与「关流」之间的间隔。 */
const EVENT_THEN_CLOSE_MS = 200;

let warnedScenario = false;

/**
 * 解析 `XH_FIXTURE_SSE_SCENARIO`。
 *
 * **未知值抛错，不静默退回 hold** —— 一个拼错的场景名如果悄悄跑成 hold，
 * 量出来的就是「1 次连接」，而那个数**看起来最正常**，最容易骗过自己。
 */
export function resolveWorkspaceStreamScenario(
    raw: string | undefined = process.env.XH_FIXTURE_SSE_SCENARIO,
): WorkspaceStreamScenario {
    if (raw === undefined || raw === "" || raw === "hold") return { kind: "hold" };
    if (raw === "close-soon") return { kind: "closeSoon" };
    if (raw === "event-then-close") return { kind: "eventThenClose", ms: EVENT_THEN_CLOSE_MS };
    const match = /^close-after:(\d+)$/.exec(raw);
    if (match) return { kind: "closeAfter", ms: Number(match[1]) };
    throw new Error(
        `[fixture] 未知 XH_FIXTURE_SSE_SCENARIO=${raw}（可选：hold | close-soon | event-then-close | close-after:<ms>）`,
    );
}

/** 给日志/断言用的场景名。 */
export function describeWorkspaceStreamScenario(scenario: WorkspaceStreamScenario): string {
    switch (scenario.kind) {
        case "hold":
            return "hold";
        case "closeSoon":
            return "close-soon";
        case "eventThenClose":
            return `event-then-close(${scenario.ms}ms)`;
        case "closeAfter":
            return `close-after:${scenario.ms}`;
    }
}

export async function installWorkspaceEventStream(
    page: Page,
    scenarioArg?: WorkspaceStreamScenario,
): Promise<void> {
    const scenario = scenarioArg ?? resolveWorkspaceStreamScenario();
    if (scenario.kind !== "hold" && !warnedScenario) {
        warnedScenario = true;
        // 让「这批跑在关流场景上」这件事自己喊出来，而不是留在 shell 历史里
        console.warn(
            `[fixture] 工作区事件流场景 = ${describeWorkspaceStreamScenario(scenario)} ⇒ 每条连接按该场景主动关流（测量/重连用例专用）`,
        );
    }
    await page.addInitScript((scenarioArg: WorkspaceStreamScenario) => {
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
                // 服务器侧「正常结束响应体」⇒ 客户端走 onclose(clean_close)。
                // 用 cancel() 不是同一条分支：那只是客户端放弃读。
                const closeStream = () => {
                    controller?.close();
                    controller = null;
                };
                const body = new ReadableStream<Uint8Array>({
                    start(next) {
                        controller = next;
                        if (scenarioArg.kind === "closeSoon") {
                            queueMicrotask(closeStream);
                        } else if (scenarioArg.kind === "eventThenClose") {
                            setTimeout(() => {
                                controller?.enqueue(
                                    encode(
                                        "event: heartbeat\ndata: " +
                                            JSON.stringify({
                                                workspaceId: "11111111-1111-4111-8111-111111111111",
                                                sequence: 1,
                                                type: "heartbeat",
                                            }) +
                                            "\n\n",
                                    ),
                                );
                                closeStream();
                            }, scenarioArg.ms);
                        } else if (scenarioArg.kind === "closeAfter") {
                            setTimeout(closeStream, scenarioArg.ms);
                        }
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
    }, scenario);
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


/**
 * 会话聊天流（`GET /api/v1/events?sessionId=…`，见 `useSSE.ts:821`）的**长连接**桩 —— task-62。
 *
 * <p><b>为什么需要它</b>：mock 车道原来的默认桩是 `page.route("**\/api/v1/events**")` 回
 * `"retry: 5000\n\n"` 的**有限体**。`route.fulfill` 必定结束响应体 ⇒ 客户端 `clean_close` ⇒
 * `isConnected=false` ⇒ `SSEStream.vue:310-314` 直接 `console.warn` 后 return ⇒
 * **`POST /api/v1/chat` 一次都不发**。于是「忘了在 `setupMockAuth` 传 `sse`」这件事，
 * 会让整条发送用例**静默变成一个空测试**：点发送、界面无反应、用例只要不断言 wire 就照样绿。</p>
 *
 * <p><b>只截 `sessionId=` 那一支</b>：`/api/v1/events` 同时被工作区上下文流用
 * （`?workspaceId=…`）。那条流已经有自己的桩（`installWorkspaceEventStream` 走
 * `/api/v1/workspaces/{id}/events`；上下文流由 `installContextEventStream` 负责），
 * 这里只接管「聊天流」，避免把别人的读面一起改掉。</p>
 *
 * <p><b>可覆盖</b>：调用方传 `sse: false`（或设 `XH_FIXTURE_CHAT_EVENTS=finite`）时**不装**
 * 本桩，退回旧的有限体口径 —— 需要断言「连接没建立」或靠 `page.on("request")` 观察这条 URL
 * 的 spec 必须显式选择旧口径（in-page `fetch` 覆盖不会在网络上留下 request 事件）。</p>
 */
export async function installChatSessionEventStream(page: Page): Promise<void> {
    await page.addInitScript(() => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const encode = (value: string) => new TextEncoder().encode(value);
        (window as unknown as Record<string, unknown>).__pushChatEvent = (
            name: string,
            data: unknown,
        ) => {
            controller?.enqueue(encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : String(input);
            // 只接管聊天流：带 sessionId 的那一支（上下文流是 workspaceId，另有桩）。
            if (url.includes("/api/v1/events") && url.includes("sessionId=")) {
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

/** 往页面推一条聊天流事件（`event: <name>` + JSON data）。留给需要逐帧驱动的用例。 */
export async function pushChatEvent(page: Page, name: string, data: unknown): Promise<void> {
    await page.evaluate(
        ([eventName, payload]) => {
            const w = window as unknown as {
                __pushChatEvent?: (name: string, data: unknown) => void;
            };
            w.__pushChatEvent?.(eventName, payload);
        },
        [name, data] as const,
    );
}
