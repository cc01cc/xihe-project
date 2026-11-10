import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
    participantRoster,
    stubSessionProjectionsForAllSessions,
    type SessionProjectionOptions,
} from "./session-projections";
import { installWorkspaceEventStream } from "./context-events";

export interface MockSSEStream {
    tokens: string[];
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cost?: number;
        source: string;
    };
    retryTokens?: string[];
    /**
     * PLAN-0659 T1.2：给本流的每个事件盖 `participantId`（多主体线程证据用）。wire 契约里
     * 每条事件都带产出主体（openapi.yaml 的 M1b-3）；夹具不盖这个字段时 UI **正确地**不渲染
     * 身份行 —— 所以「谁产出的」必须由夹具显式给，UI 不猜。
     */
    participantId?: string;
    /** PLAN-0659 T1.2：token 之后补一个 `tool_call`（过程行/工具卡的 actor 徽标证据）。 */
    toolCall?: { tool: string; toolCallId?: string; arguments?: unknown };
    errorAfterTokens?: {
        code: string;
        detail: string;
        retryable?: boolean;
        /** PLAN-0492: exhausted run-budget dimension relayed by the CP. */
        dimension?: "turns" | "elapsed" | "tokens";
        outcome?: string;
    };
    delayMs?: number;
    holdOpen?: boolean;
}

export interface MockAuthOptions {
    sse?: MockSSEStream;
    /**
     * PLAN-0639 M2: extra workspace fields merged into both workspace seeds
     * (localStorage + sessionStorage), e.g. `roots` for the grouped file tree.
     * Fields the caller does not set keep the existing fixture values.
     */
    workspace?: Record<string, unknown>;
    /**
     * BL-318：四类会话投影默认挂（形状照抄真实 CP 响应）。传 `false` 关掉，用于极少数要断言
     * "投影不可用"降级路径的用例；传对象可覆盖参与者花名册 / capabilities。
     */
    projections?: SessionProjectionOptions | false;
    /**
     * PLAN-0752 M4：`/settings/data`、凭据面板这类**有 atom** 的页现在按能力投影决定是否挂载主体
     * （`SettingsPermissionGate` 的 `atom-denied` 只留 403 卡片，不渲染控件）。夹具用户默认**零能力**，
     * 所以「导出/导入按钮在」「保留期清理控件在」这类用例必须显式授予能力，否则看到的是 403 视图
     * ——那是另一条用例（权限门）该断言的东西，不该让功能用例替它红。
     */
    capabilities?: Record<string, boolean>;
    /**
     * task-100：工作区事件流（`GET /api/v1/workspaces/{id}/events`）的桩形态。
     * - `"stream"`（默认）：in-page `window.fetch` 覆盖返回**永不关闭**的流
     *   （`installWorkspaceEventStream`）。真实 CP 就是长连接，有限体会让客户端恒速重连
     *   —— task-98 实测 101 次 / 30 s。
     * - `"off"`：不装 in-page 桩，请求照旧走 `page.route`（网络层）。**只有两类 spec 需要**：
     *   ① 自己用 `page.route` 给这条 URL 回非 200（如 429 上限提示）—— in-page 桩会抢在前面把
     *   它盖掉；② 靠 `page.on("request")` 观察这条 URL 是否被请求。这类 spec 里会保留旧口径的
     *   有限体（含它的重连 churn），属**已知代价**，不是回退。
     */
    workspaceEvents?: "stream" | "off";
}

export interface MockSessionRecord {
    id: string;
    title: string;
    agentPrincipalId?: string | null;
    createdAt?: string;
    updatedAt?: string;
    workspaceId?: string;
}

export interface MockSessionOptions {
    sessions?: MockSessionRecord[];
    workspaceId?: string;
    messages?: Record<string, Array<Record<string, unknown>>>;
    createSession?: boolean;
    /**
     * BL-318：四类会话投影（derived-state / follow-ups / commands / participants）**默认挂**，
     * 因为它们不桩就是真 404 + console error（夹具缺口，会让 "0 console error" 门禁假红）。
     * - 传对象 = 覆盖参与者花名册 / capabilities；
     * - 传 `false` = 不挂（极少数要断言"投影不可用"降级路径的用例）；
     * - 想只覆盖其中一条：在本函数**之后**再 `page.route`（后注册优先）或 `route.fallback()`。
     */
    projections?: SessionProjectionOptions | false;
}

/** task-100：`XH_FIXTURE_WORKSPACE_EVENTS=off` 只在首次生效时喊一次，避免刷屏。 */
let warnedLegacyWorkspaceEvents = false;
/** task-100：`XH_FIXTURE_MONITOR=sse` 同样只喊一次。 */
let warnedLegacyMonitor = false;

const MOCK_ROOT_BRANCH_ID = "00000000-0000-4000-8000-000000000001";
/** Default bound Agent principal for fixture Sessions (see `setupMockSessions`). */
const MOCK_BOUND_PRINCIPAL_ID = "00000000-0000-4000-8000-0000000000a1";
type MockBranch = {
    branchId: string;
    parentBranchId: string | null;
    forkPointMessageId: string | null;
    forkPointRunId: string | null;
    createdAt: string;
};

/**
 * `SessionMonitorResponse` 的最小合法体（形状照抄 `screenshots.spec.ts` 的同一桩）。
 * `history` / `readiness` 是产品渲染的必需投影（`SessionMonitorPanel` 读 `data.history.recent`），
 * 给 `{}` 会在面板里抛 "reading 'recent'"。
 */
function sessionMonitorResponse(): Record<string, unknown> {
    const now = new Date().toISOString();
    return {
        generatedAt: now,
        session: {
            id: "test-session",
            title: "Mock Session",
            agentPrincipalId: null,
            modelProvider: null,
            modelName: null,
            providerConnectionId: null,
            connectionRevision: null,
            createdAt: now,
            updatedAt: now,
        },
        activity: [],
        history: { windowSize: 20, counts: {}, recent: [] },
        readiness: {
            connection: null,
            agent: {
                status: "unknown",
                llmReady: "unknown",
                verifiedAt: null,
                configRevision: "0",
            },
            lastObservedRun: null,
        },
        transport: { attemptCount: 0, failedCount: 0, partialCount: 0 },
    };
}

export async function setupMockAuth(page: Page, options: MockAuthOptions = {}) {
    // task-100：工作区事件流必须是**长连接**。旧桩用 `route.fulfill` 给有限体，响应立刻结束 ⇒
    // 客户端 clean_close + 恒速重连（task-98 实测 101 次 / 30 s）。Playwright 没有流式 fulfill，
    // 所以这条流由 in-page `window.fetch` 覆盖提供（见 `installWorkspaceEventStream`）。
    if (process.env.XH_FIXTURE_WORKSPACE_EVENTS === "off" && !warnedLegacyWorkspaceEvents) {
        // 显式喊一声：不喊的话，shell 里残留的这个变量会让整批 spec 悄悄跑在**旧夹具**上，
        // 而报告里看不出任何区别 —— 那就是另一种假绿。
        warnedLegacyWorkspaceEvents = true;
        console.warn(
            "[fixture] XH_FIXTURE_WORKSPACE_EVENTS=off ⇒ 工作区事件流退回 task-100 之前的有限体桩" +
                "（仅 before/after 对照测量用；产品行为不变）",
        );
    }
    // `XH_FIXTURE_WORKSPACE_EVENTS=off` 是**测量用的对照开关**（task-100）：它把这条流退回
    // task-100 之前的有限体口径，从而可以在**同一次窗口、同一条命令、同一棵树**上跑出 before
    // 读数。没有它，before 只能用另一棵树/另一把尺量，前后不可比。产品代码不读这个变量。
    const workspaceEvents =
        options.workspaceEvents ??
        (process.env.XH_FIXTURE_WORKSPACE_EVENTS === "off" ? "off" : "stream");
    if (workspaceEvents === "stream") {
        await installWorkspaceEventStream(page);
    }
    const branchesBySession = new Map<string, MockBranch[]>();
    const branchResponses = new Map<
        string,
        {
            requestHash: string;
            response: { branchId: string; parentBranchId: string; forkPointMessageId: string };
        }
    >();
    await page.addInitScript(
        ({ workspaceOverrides, capabilities }) => {
            localStorage.setItem("xihe-token", "mock-token");
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({
                    id: "user-1",
                    email: "test@xihe.local",
                    name: "Test User",
                    ...(capabilities ? { capabilities } : {}),
                }),
            );
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: "workspace-1",
                    name: "Mock Workspace",
                    ownerId: "user-1",
                    ...workspaceOverrides,
                }),
            );
            // PLAN-0559 per-tab context is authoritative; migrateLegacyWorkspace drops
            // role fields, so seed sessionStorage directly with the post-login shape
            // (PLAN-0560 workspace settings rely on workspaceRole).
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: "workspace-1",
                    name: "Mock Workspace",
                    workspaceRole: "OWNER",
                    ownerId: "user-1",
                    ...workspaceOverrides,
                }),
            );
        },
        { workspaceOverrides: options.workspace ?? {}, capabilities: options.capabilities },
    );

    if (options.sse) {
        await page.addInitScript(
            ({
                tokens,
                retryTokens,
                errorAfterTokens,
                delayMs,
                optionsUsage,
                holdOpen,
                participantId,
                toolCall,
            }) => {
                const originalFetch = window.fetch.bind(window);
                let streamController: ReadableStreamDefaultController<Uint8Array> | null = null,
                    streamClosed = false;
                let streamReady = false,
                    streamEmitted = false,
                    shouldFail = Boolean(errorAfterTokens);
                /** `runId` of the latest `202 ChatRunResponse`, used to correlate SSE events. */
                let currentRunId: string | undefined;

                const encode = (value: string) => new TextEncoder().encode(value);
                const event = (name: string, data: unknown) =>
                    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
                /**
                 * PLAN-0659 T1.2：装配可选的事件信封字段 —— `runId`（CP 的每条事件都带，UI 用它
                 * 把 token 与 tool_call 归到同一个 run 的同一个气泡）与 `participantId`（产出主体，
                 * wire 契约 M1b-3）。夹具不带 `runId` 时 tool_call 会另起一个气泡（假失败）。
                 */
                const withParticipant = (data: Record<string, unknown>) => ({
                    ...(currentRunId ? { runId: currentRunId } : {}),
                    ...data,
                    ...(participantId ? { participantId } : {}),
                });

                const emit = async () => {
                    if (!streamController || streamClosed || streamEmitted) return;
                    streamEmitted = true;
                    try {
                        const responseTokens = shouldFail ? tokens : (retryTokens ?? tokens);
                        for (const token of responseTokens) {
                            if (delayMs > 0)
                                await new Promise((resolve) => setTimeout(resolve, delayMs));
                            if (!streamController || streamClosed) return;
                            streamController.enqueue(
                                encode(event("token", withParticipant({ content: token }))),
                            );
                        }
                        if (!streamClosed && toolCall) {
                            streamController.enqueue(
                                encode(
                                    event(
                                        "tool_call",
                                        withParticipant({
                                            tool: toolCall.tool,
                                            ...(toolCall.toolCallId
                                                ? { toolCallId: toolCall.toolCallId }
                                                : {}),
                                            arguments: toolCall.arguments ?? {},
                                            ...(currentRunId ? { run_id: currentRunId } : {}),
                                        }),
                                    ),
                                ),
                            );
                        }
                        if (shouldFail && errorAfterTokens) {
                            // The stream is correlated by `runId` (the one the `202` ChatRunResponse
                            // handed back). An `error` event without it cannot be attached to the
                            // assistant message, so no `message-error` banner is rendered.
                            streamController.enqueue(
                                encode(
                                    event("error", {
                                        ...errorAfterTokens,
                                        ...(currentRunId ? { runId: currentRunId } : {}),
                                    }),
                                ),
                            );
                            shouldFail = false;
                            streamEmitted = false;
                            return;
                        }
                        if (!streamClosed && optionsUsage) {
                            streamController.enqueue(encode(event("usage", optionsUsage)));
                        }
                        if (holdOpen) return;
                        if (!streamClosed) {
                            streamController.enqueue(encode(event("done", {})));
                            streamController.close();
                            streamClosed = true;
                        }
                    } catch {
                        streamClosed = true;
                    }
                };

                window.fetch = async (input, init) => {
                    const requestUrl =
                        typeof input === "string"
                            ? input
                            : input instanceof Request
                              ? input.url
                              : input.url;
                    if (requestUrl.includes("/api/v1/events")) {
                        streamClosed = false;
                        streamReady = false;
                        streamEmitted = false;
                        const body = new ReadableStream<Uint8Array>({
                            start(controller) {
                                streamController = controller;
                                controller.enqueue(encode("retry: 1000\n\n"));
                                if (streamReady) void emit();
                            },
                            cancel() {
                                streamClosed = true;
                                streamController = null;
                            },
                        });
                        return new Response(body, {
                            status: 200,
                            headers: { "Content-Type": "text/event-stream" },
                        });
                    }

                    if (
                        requestUrl.includes("/api/v1/chat") &&
                        (init?.method ?? (input instanceof Request ? input.method : "GET")) ===
                            "POST"
                    ) {
                        const response = await originalFetch(input, init);
                        currentRunId = await response
                            .clone()
                            .json()
                            .then((payload: { runId?: string }) => payload?.runId)
                            .catch(() => undefined);
                        streamReady = true;
                        void emit();
                        return response;
                    }

                    return originalFetch(input, init);
                };
            },
            {
                tokens: options.sse.tokens,
                optionsUsage: options.sse.usage,
                retryTokens: options.sse.retryTokens,
                errorAfterTokens: options.sse.errorAfterTokens,
                delayMs: options.sse.delayMs ?? 0,
                holdOpen: options.sse.holdOpen ?? false,
                participantId: options.sse.participantId,
                toolCall: options.sse.toolCall,
            },
        );
    }

    if (!options.sse) {
        await page.route("**/api/v1/events**", async (route) => {
            await route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            });
        });
    }

    await page.route("**/api/v1/chat", async (route) => {
        const body = route.request().postDataJSON() as {
            branchId?: string;
            sessionId?: string;
        } | null;
        if (!body?.branchId) {
            await route.fulfill({
                status: 400,
                contentType: "application/problem+json",
                body: JSON.stringify({ code: "INVALID_REQUEST", detail: "branchId is required" }),
            });
            return;
        }
        // `POST /api/v1/chat` answers `202` with the full `ChatRunResponse`
        // (`origin`/`status`/`sessionId`/`runId` are required by the OpenAPI schema). The old
        // `{status:"accepted"}` body carried no `runId`, so the composer never recorded the run:
        // the assistant bubble could not be correlated with the SSE stream, and an `error` event
        // had nothing to attach to — the `message-error` banner never appeared.
        await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
                origin: "user_submission",
                status: "accepted",
                sessionId: body.sessionId ?? "mock-session",
                runId: randomUUID(),
                messageId: randomUUID(),
            }),
        });
    });

    await page.route("**/api/v1/models", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ models: {} }),
        });
    });

    await page.route("**/api/v1/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/api/v1/workspaces/") && url.includes("/events")) {
            if (workspaceEvents === "off") {
                // 该 spec 明确要自己在网络层处理这条 URL（自有 429 桩 / 观察 request 事件）。
                // 保留 task-100 之前的有限体口径 —— 代价是这个 spec 内仍有重连 churn。
                await route.fulfill({
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                    body: "retry: 1000\n\n",
                });
                return;
            }
            // 正常情况下**到不了这里** —— `installWorkspaceEventStream`（setupMockAuth 开头挂的
            // in-page fetch 覆盖）已经把这条 URL 截住并返回永不关闭的流。
            // 这里刻意返回 501 而不是任何有限体：finite body 会立刻结束响应，把 task-98 的
            // 101 次/30 s 重连风暴原样复活；而**静默**返回一个"看起来能用"的东西，会让
            // 又一次夹具回归无人发现。狼狈一点，可查一点。
            await route.fulfill({
                status: 501,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    code: "FIXTURE_UNREACHABLE",
                    detail: "workspace event stream must be served by installWorkspaceEventStream (in-page fetch)",
                }),
            });
            return;
        }
        // `GET /chat/sessions/{id}/monitor` 是 **JSON** 聚合读（`openapi.yaml:2152-2156`，
        // `SessionMonitorResponse`），不是 SSE。旧桩按 `text/event-stream` 服务它，产品的
        // `api.getSessionMonitor` 按 JSON 读 ⇒ `session monitor fetch failed: Unexpected token
        // 'r', "retry: 1000 "`（task-98/§12）。契约站产品这边，所以修的是桩。
        // 保留 stub 的理由照旧（PLAN-0577）：不桩就逃到 dev proxy，真 CP 回 401，产品会把
        // mock 会话登出。
        if (url.includes("/api/v1/chat/sessions/") && url.includes("/monitor")) {
            if (process.env.XH_FIXTURE_MONITOR === "sse") {
                // 测量用对照（task-100）：把 monitor 退回 task-100 之前的 `text/event-stream` 口径，
                // 用来量 `session monitor fetch failed` 的 before 值。产品代码不读这个变量。
                if (!warnedLegacyMonitor) {
                    warnedLegacyMonitor = true;
                    console.warn(
                        "[fixture] XH_FIXTURE_MONITOR=sse ⇒ monitor 端点退回 SSE 桩（仅 before/after 对照测量用）",
                    );
                }
                await route.fulfill({
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                    body: "retry: 1000\n\n",
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(sessionMonitorResponse()),
            });
            return;
        }
        // Only the endpoints that have their own route above may fall through; matching on
        // "contains /chat" also swallowed every `/api/v1/chat/runs/{id}/…` sub-resource
        // (guidance, recovery, cancel) and let it escape to the dev proxy, which answers
        // ECONNREFUSED — the run then looked broken for reasons that had nothing to do with
        // the code under test.
        const pathname = new URL(url).pathname;
        if (
            pathname === "/api/v1/events" ||
            pathname === "/api/v1/chat" ||
            pathname === "/api/v1/models"
        ) {
            return route.fallback();
        }
        const branchRoute = url.match(/\/api\/v1\/sessions\/([^/?]+)\/branches(?:\?|$)/);
        if (branchRoute) {
            const sessionId = branchRoute[1],
                method = route.request().method();
            if (method === "GET") {
                const items = branchesBySession.get(sessionId) ?? [
                    {
                        branchId: MOCK_ROOT_BRANCH_ID,
                        parentBranchId: null,
                        forkPointMessageId: null,
                        forkPointRunId: null,
                        createdAt: "2026-09-29T00:00:00.000Z",
                    },
                ];
                branchesBySession.set(sessionId, items);
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ sessionId, items }),
                });
                return;
            }
            if (method === "POST") {
                const body = route.request().postDataJSON() as {
                    sourceBranchId?: string;
                    anchorMessageId?: string;
                };
                if (
                    !body.sourceBranchId ||
                    !body.anchorMessageId ||
                    !route.request().headers()["idempotency-key"]
                ) {
                    await route.fulfill({
                        status: 400,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            code: "INVALID_REQUEST",
                            detail: "branch request is incomplete",
                        }),
                    });
                    return;
                }
                const key = `${sessionId}:${route.request().headers()["idempotency-key"]}`;
                const requestHash = `${body.sourceBranchId}:${body.anchorMessageId}`,
                    prior = branchResponses.get(key);
                if (prior && prior.requestHash !== requestHash) {
                    await route.fulfill({
                        status: 409,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            code: "IDEMPOTENCY_KEY_CONFLICT",
                            detail: "branch key conflict",
                        }),
                    });
                    return;
                }
                const response = prior?.response ?? {
                    branchId: randomUUID(),
                    parentBranchId: body.sourceBranchId,
                    forkPointMessageId: body.anchorMessageId,
                };
                branchResponses.set(key, { requestHash, response });
                const items = branchesBySession.get(sessionId) ?? [
                    {
                        branchId: MOCK_ROOT_BRANCH_ID,
                        parentBranchId: null,
                        forkPointMessageId: null,
                        forkPointRunId: null,
                        createdAt: "2026-09-29T00:00:00.000Z",
                    },
                ];
                if (!items.some((item) => item.branchId === response.branchId)) {
                    items.push({
                        branchId: response.branchId,
                        parentBranchId: response.parentBranchId,
                        forkPointMessageId: response.forkPointMessageId,
                        forkPointRunId: null,
                        createdAt: new Date().toISOString(),
                    });
                }
                branchesBySession.set(sessionId, items);
                await route.fulfill({
                    status: 201,
                    contentType: "application/json",
                    body: JSON.stringify(response),
                });
                return;
            }
        }
        const workspaceMatch = url.match(/\/api\/v1\/workspaces\/([^/?]+)$/);
        if (workspaceMatch?.[1] === "current" && route.request().method() === "GET") {
            await route.fulfill({
                status: 404,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    code: "WORKSPACE_NOT_FOUND",
                    detail: "No active workspace",
                }),
            });
            return;
        }
        if (
            workspaceMatch &&
            workspaceMatch[1] !== "current" &&
            route.request().method() === "GET"
        ) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: workspaceMatch[1],
                    name: "Mock Workspace",
                    status: "ready",
                }),
            });
            return;
        }
        const sessionMatch = url.match(/\/api\/v1\/sessions\/([^/?]+)/);
        if (sessionMatch && route.request().method() === "GET") {
            if (url.includes("/messages")) {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([]),
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: sessionMatch[1],
                    title: "Mock Session",
                    workspaceId: "workspace-1",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    archived: false,
                    // Same reason as `setupMockSessions`: a real Session is created bound to an
                    // Agent principal, and a null one routes the composer into the binding
                    // dialog instead of sending.
                    agentPrincipalId: MOCK_BOUND_PRINCIPAL_ID,
                }),
            });
            return;
        }
        if (url.match(/\/api\/v1\/sessions(?:\?.*)?$/) && route.request().method() === "GET") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessions: [] }),
            });
            return;
        }
        if (url.includes("/api/v1/policy/mode") && route.request().method() === "GET") {
            const sessionId = new URL(url).searchParams.get("sessionId") ?? "mock-session";
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessionId, mode: "manual", sessionRules: 0 }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({}),
        });
    });

    // BL-318：`setupMockAuth` 是**每条 mock 用例都会调**的入口，所以会话侧投影与工作区智能体清单
    // 必须在这里也有默认值 —— 只在 `setupMockSessions` 挂的话，只调 `setupMockAuth` 的 spec
    // （如 `chat.spec.ts` 的 beforeeach）仍会拿到兜底的 `200 {}`，UI 解析 `activeChildren.map` /
    // `agents.map` 直接 TypeError，被判成"夹具噪声红"。
    //
    // 形状来源同 `session-projections.ts` 头注释（2026-11-05 对 stack-1 真实 CP 记录）：
    //   GET /api/v1/workspaces/{id}/agents → { agents: [{ principalId, name, templateId,
    //        templateName, createdAt, permissionsSnapshot[], bound, hooks, contextPolicy, disabled }] }
    await page.route("**/api/v1/workspaces/*/agents", async (route) => {
        if (route.request().method() !== "GET") {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ agents: [] }),
        });
    });

    // BL-318：`/settings/monitoring` 读 `versionInfo.modules.cp.version`，不桩就是 `200 {}` ⇒
    // `Cannot read properties of undefined (reading 'cp')` 未捕获 pageerror（`full-ui-acceptance`
    // 的保护路由矩阵实测）。形状照抄真实 CP（2026-11-05 stack-1 `GET /api/v1/version`）。
    await page.route("**/api/v1/version", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                stackId: "stack-1",
                releaseChannel: "dev",
                startedAt: "2026-11-05T00:00:00.000Z",
                commit: null,
                modules: {
                    cp: { version: "0.1.0", commit: null },
                    agent: { version: "0.1.0", commit: null, framework: "langgraph" },
                    runtime: { version: "0.1.0", commit: null },
                },
            }),
        });
    });

    if (options.projections !== false) {
        await stubSessionProjectionsForAllSessions(page, {
            participants: participantRoster({ agentPrincipalId: MOCK_BOUND_PRINCIPAL_ID }),
            ...(options.projections ?? {}),
        });
    }

    // BL-318：会话 run 列表与委派预算投影的默认桩（不桩就是 `**/api/v1/**` 的 `200 {}`，
    // UI 侧 `runs.runs` 不是可迭代对象直接 TypeError：`plan0659-delegation-dag` 实测
    // `Failed to load durable child wait links {runs.runs is not iterable}`）。
    // 形状照抄真实 CP（2026-11-05 stack-1）：
    //   GET /api/v1/chat/sessions/{id}/runs → { sessionId, page, size, runs[] }
    //   GET /api/v1/sessions/{id}/delegation-usage → { rootSessionId, usedSessions, maxCount,
    //        currentDepth, maxDepth, principalId, principalName, policySource, disabled }
    // 注意用 **regex** 而不是 glob：glob 要匹配整个 URL，带 `?page=0&size=100` 的请求用
    // `…/runs` 结尾的 glob 是匹配不上的（实测 `runs.runs is not iterable` 依旧出现）。
    await page.route(/\/api\/v1\/chat\/sessions\/[^/]+\/runs(?:\?.*)?$/, async (route) => {
        const url = new URL(route.request().url());
        const sessionId = url.pathname.split("/").filter(Boolean).slice(-2, -1)[0] ?? "";
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId,
                page: Number(url.searchParams.get("page") ?? 0),
                size: Number(url.searchParams.get("size") ?? 20),
                runs: [],
            }),
        });
    });
    await page.route(/\/api\/v1\/sessions\/[^/]+\/delegation-usage(?:\?.*)?$/, async (route) => {
        const rootSessionId =
            new URL(route.request().url()).pathname.split("/").filter(Boolean).slice(-2, -1)[0] ??
            "";
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                rootSessionId,
                usedSessions: 0,
                maxCount: 8,
                currentDepth: 0,
                maxDepth: 3,
                principalId: MOCK_BOUND_PRINCIPAL_ID,
                principalName: "Mock Agent",
                policySource: "code-defaults",
                disabled: false,
            }),
        });
    });
}

export async function setupMockSessions(page: Page, options: MockSessionOptions = {}) {
    const now = new Date().toISOString();
    const sessions = (options.sessions ?? []).map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt ?? now,
        updatedAt: session.updatedAt ?? session.createdAt ?? now,
        workspaceId: session.workspaceId ?? options.workspaceId ?? "workspace-1",
        modelProvider: null,
        modelName: null,
        archived: false,
        // `MockSessionRecord.agentPrincipalId` used to be dropped here, so a fixture could
        // not model a Session that already has a bound Agent — the UI then detoured every
        // send into the principal-binding dialog (removed by PLAN-0689 B3) and no `/chat`
        // POST was ever made (2026-11-03 mock-lane: approval `switching away…` could never
        // see the stop button). A bound principal is the normal state: `POST /sessions`
        // requires it.
        //
        // Default (not just pass-through): a Session that already has a bound Agent is the
        // *normal* server state — `POST /sessions` rejects a principal-null Session. The old
        // pre-first-send placeholder that opened the binding dialog (ChatPanel.handleSend →
        // `workspace-agent-principal-select`) was removed by PLAN-0689 B3; the field is still
        // carried by the current session view. A fixture that omitted it therefore never
        // reached the send path it was testing: no `/chat` POST, no user bubble, no stop
        // button. Callers that wanted the old placeholder (binding-dialog flows) passed
        // `agentPrincipalId: null` explicitly.
        agentPrincipalId:
            "agentPrincipalId" in session
                ? (session.agentPrincipalId ?? null)
                : MOCK_BOUND_PRINCIPAL_ID,
    }));
    const createRootBranch = (createdAt: string): MockBranch[] => [
        {
            branchId: MOCK_ROOT_BRANCH_ID,
            parentBranchId: null,
            forkPointMessageId: null,
            forkPointRunId: null,
            createdAt,
        },
    ];
    const messages = options.messages ?? {};
    const branches = new Map<string, MockBranch[]>(
        sessions.map((session) => [session.id, createRootBranch(now)]),
    );

    // PLAN-0608 C′: the UI now creates sessions on the workspace-addressed path
    // (`POST /api/v1/workspaces/{workspaceId}/sessions`). Registering only the
    // legacy glob made every `createSession: true` stub silently fall through to
    // the `**/api/v1/**` catch-all, which answers `200 {}` — a *silent* failure
    // that reads as success to the spec. Match both surfaces by regex instead.
    const matchesSessionCreate = (url: string) =>
        /\/(?:api\/v1\/sessions|api\/v1\/workspaces\/[^/]+\/sessions)$/.test(new URL(url).pathname);

    await page.route(matchesSessionCreate, async (route) => {
        if (route.request().method() === "GET") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessions }),
            });
            return;
        }
        if (route.request().method() === "POST" && options.createSession) {
            const body = route.request().postDataJSON() as {
                title?: string;
                agentPrincipalId?: string;
            } | null;
            const created = {
                id: `mock-session-${Date.now()}`,
                title: body?.title ?? "New Chat",
                agentPrincipalId: body?.agentPrincipalId ?? null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                workspaceId: "workspace-1",
                modelProvider: null,
                modelName: null,
                archived: false,
            };
            sessions.unshift(created);
            branches.set(created.id, createRootBranch(created.createdAt));
            await route.fulfill({
                status: 201,
                contentType: "application/json",
                body: JSON.stringify(created),
            });
            return;
        }
        await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ code: "SESSION_CREATION_DISABLED" }),
        });
    });

    // C1（2026-11-04 合入）：composer 发送前会先 `POST /sessions/{id}/bind-defaults`，
    // 只有端点回带 `providerConnectionId` 才会真正发送；否则弹「绑定引导」并把消息挂起
    // （ChatPanel.handleSend → guardProviderBinding）。统一在此补齐夹具，否则所有
    // 「发送后断言」的 mock 用例都会在发送前被拦下（mock lane 基线红）。
    await page.route("**/api/v1/sessions/*/bind-defaults", async (route) => {
        const sessionId =
            new URL(route.request().url()).pathname.split("/").filter(Boolean).at(-2) ??
            sessions[0]?.id ??
            "mock-session";
        const base = sessions.find((item) => item.id === sessionId) ?? sessions[0];
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                id: base?.id ?? sessionId,
                title: base?.title ?? "Mock Session",
                workspaceId: base?.workspaceId ?? "workspace-1",
                agentPrincipalId: base?.agentPrincipalId ?? MOCK_BOUND_PRINCIPAL_ID,
                createdAt: base?.createdAt ?? now,
                updatedAt: base?.updatedAt ?? now,
                archived: false,
                providerConnectionId: "conn-mock-default",
                connectionRevision: 1,
                modelProvider: "openai",
                modelName: "fake-openai",
            }),
        });
    });

    await page.route("**/api/v1/sessions/**", async (route) => {
        const url = new URL(route.request().url()),
            parts = url.pathname.split("/").filter(Boolean);
        // bind-defaults 有专用桩（注册在本路由之前）：fallback 交给它，避免被这里的
        // 通用分支吃掉（Playwright 后注册优先，fallback 会回退到更早的 handler）。
        if (parts.at(-1) === "bind-defaults") {
            await route.fallback();
            return;
        }
        const sessionId = parts.at(-1) === "messages" ? parts.at(-2) : parts.at(-1);
        if (!sessionId) {
            await route.fulfill({
                status: 404,
                contentType: "application/json",
                body: JSON.stringify({}),
            });
            return;
        }
        if (parts.at(-1) === "branches") {
            if (route.request().method() === "GET") {
                // Sessions addressed directly by URL are not always declared in
                // `options.sessions`; mirror the auth-level fallback so branch
                // selection and sends do not dead-end on an empty list.
                const items = branches.get(sessionId) ?? createRootBranch(now);
                branches.set(sessionId, items);
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ sessionId, items }),
                });
                return;
            }
            if (route.request().method() === "POST") {
                const body = route.request().postDataJSON() as {
                    sourceBranchId?: string;
                    anchorMessageId?: string;
                } | null;
                const key = route.request().headers()["idempotency-key"];
                if (!body?.sourceBranchId || !body.anchorMessageId || !key) {
                    await route.fulfill({
                        status: 400,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            code: "INVALID_REQUEST",
                            detail: "branch request is incomplete",
                        }),
                    });
                    return;
                }
                const branchId = randomUUID();
                const response = {
                    branchId,
                    parentBranchId: body.sourceBranchId,
                    forkPointMessageId: body.anchorMessageId,
                };
                const items = branches.get(sessionId) ?? createRootBranch(now);
                items.push({
                    branchId,
                    parentBranchId: body.sourceBranchId,
                    forkPointMessageId: body.anchorMessageId,
                    forkPointRunId: null,
                    createdAt: new Date().toISOString(),
                });
                branches.set(sessionId, items);
                await route.fulfill({
                    status: 201,
                    contentType: "application/json",
                    body: JSON.stringify(response),
                });
                return;
            }
        }
        if (parts.at(-1) === "messages" && route.request().method() === "GET") {
            // 分页请求（`?before=`）必须交给调用方注册的窄路由 —— 否则通配兜底会把
            // 「加载更早」的响应替换成首屏数据，prepend 结果被覆盖（实测 scrollHeight
            // 从 88530 崩回 698 重载）。通配只应答**首屏**（无 before）。
            if (!new URL(route.request().url()).searchParams.has("before")) {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(messages[sessionId] ?? []),
                });
                return;
            }
        }
        const session = sessions.find((item) => item.id === sessionId);
        if (route.request().method() === "GET" && session) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(session),
            });
            return;
        }
        await route.fulfill({
            status: session ? 200 : 404,
            contentType: "application/json",
            body: JSON.stringify(session ?? {}),
        });
    });

    // BL-318：四类会话投影默认桩。注册在本函数**最后**——Playwright 后注册者优先，所以它们会
    // 盖过上面的 `**/api/v1/sessions/**` 兜底；未知后缀仍按上面的规则落 404（本段只匹配这四条
    // 固定后缀，不做通配 200）。
    // BL-318 取证用临时开关：默认 true。跑"先红"对照时置 false（关掉公共投影桩，露出真 404 噪声）。
    if (options.projections !== false && process.env.XIHE_MOCK_PROJECTIONS !== "0") {
        await stubSessionProjectionsForAllSessions(page, {
            participants: participantRoster({ agentPrincipalId: MOCK_BOUND_PRINCIPAL_ID }),
            ...(options.projections ?? {}),
        });
    }
}
