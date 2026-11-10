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

export async function installWorkspaceEventStream(page: Page): Promise<void> {
    const scenario = resolveWorkspaceStreamScenario();
    if (scenario.kind !== "hold" && !warnedScenario) {
        warnedScenario = true;
        // 让「整批跑在测量场景上」这件事自己喊出来，而不是留在 shell 历史里
        console.warn(
            `[fixture] XH_FIXTURE_SSE_SCENARIO=${process.env.XH_FIXTURE_SSE_SCENARIO} ⇒ 工作区事件流按该场景主动关流（仅测量用）`,
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
                                                workspaceId: "workspace-1",
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
