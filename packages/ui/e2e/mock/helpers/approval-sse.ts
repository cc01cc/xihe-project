/**
 * task-185 / F4：审批长连接 SSE 桩安装器 —— **从 approval.spec.ts 逐字平移**（唯一调用点改 import 此 helper）。
 *
 * 为什么提取：它是原 spec 的局部函数，任何想写审批用例的剧本（如 RSI 七步 S6）都得抄一份
 * ⇒ 第二套实现 = 违反 mock 车道「单一实现」纪律。提取后 approval.spec 与 RSI 剧本共用一份。
 *
 * 职责（平移未改）：
 * ① 拦截 `/api/v1/events` 建长连接 SSE（`approval_request` 具名事件，`retry: 1000` 保活）；
 * ② 拦截 `POST /api/v1/chat`：无 `branchId` 回 400 INVALID_REQUEST，有则 202 accepted；
 * ③ 挂 `window.__pushApprovalEvent` 入队 + drain（配合 helpers/approval-registry.ts 的 pushMockApproval）。
 *
 * 必须在 `page.goto` 之前调用（addInitScript）。与 `installContextEventStream` 一样接管
 * `/api/v1/events` fetch，**不可与它在同页共存**。
 */
import type { Page } from "@playwright/test";

export interface ApprovalSSEIdentity {
    sessionId: string;
    runId: string;
}

export async function installApprovalSSE(page: Page, identity: ApprovalSSEIdentity) {
    await page.addInitScript(
        ({ sessionId, runId }: { sessionId: string; runId: string }) => {
            const pending: unknown[] = [];
            let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
            const encode = (value: string) => new TextEncoder().encode(value);
            const sse = (name: string, data: unknown) =>
                `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
            const drain = () => {
                if (!controllerRef) return;
                while (pending.length > 0) {
                    const item = pending.shift();
                    controllerRef.enqueue(encode(sse("approval_request", item)));
                }
            };
            (window as unknown as Record<string, unknown>).__pushApprovalEvent = (
                payload: unknown,
            ) => {
                pending.push(payload);
                drain();
            };
            const originalFetch = window.fetch.bind(window);
            window.fetch = async (input, init) => {
                const requestUrl =
                    typeof input === "string"
                        ? input
                        : input instanceof Request
                          ? input.url
                          : // 平移时修正：原分支对 URL 类型取 .url（TS2339，基线在册的旧错；运行时该死分支传 URL 会得 undefined）。
                            //   URL 的正确取值是 .href。无任何现有用例以 URL 对象调 fetch（均 string/Request），行为面不变。
                            input.href;
                if (requestUrl.includes("/api/v1/events")) {
                    const body = new ReadableStream<Uint8Array>({
                        start(controller) {
                            controllerRef = controller;
                            controller.enqueue(encode("retry: 1000\n\n"));
                            queueMicrotask(drain);
                        },
                    });
                    return new Response(body, {
                        status: 200,
                        headers: { "Content-Type": "text/event-stream" },
                    });
                }
                if (
                    requestUrl.includes("/api/v1/chat") &&
                    !requestUrl.includes("/api/v1/chat/approvals/") &&
                    (init?.method ?? "GET") === "POST"
                ) {
                    const payload =
                        typeof init?.body === "string"
                            ? (JSON.parse(init.body) as { branchId?: string })
                            : {};
                    if (!payload.branchId) {
                        return new Response(
                            JSON.stringify({
                                code: "INVALID_REQUEST",
                                detail: "branchId is required",
                            }),
                            {
                                status: 400,
                                headers: { "Content-Type": "application/problem+json" },
                            },
                        );
                    }
                    return new Response(JSON.stringify({ status: "accepted", sessionId, runId }), {
                        status: 202,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                return originalFetch(input, init);
            };
            void sessionId;
        },
        { sessionId: identity.sessionId, runId: identity.runId },
    );
}
