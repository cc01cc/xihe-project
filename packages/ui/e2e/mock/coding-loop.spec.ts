import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

// BL-318：`cancel mock returns 409 for terminal run` 故意桩 409（验取消终态 run 的降级路径），
// 逐条放行 cancel 端点。
test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`/chat/runs/[^/]+/cancel`] });

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    RUN_ID_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST_ID_1 = "22222222-2222-4222-8222-222222222222",
    REQUEST_ID_2 = "33333333-3333-4333-8333-333333333333";

test.describe("PLAN-275: Safe Coding Loop E2E", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Coding Loop" }] });
    });

    test.describe("Policy gate: approval request event", () => {
        test.beforeEach(async ({ page }) => {
            await page.addInitScript(() => {
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
                    const url =
                        typeof input === "string"
                            ? input
                            : input instanceof Request
                              ? input.url
                              : input.url;
                    if (url.includes("/api/v1/events")) {
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
                    return originalFetch(input, init);
                };
            });
        });

        test("approval_request event triggers approval modal with tool info", async ({ page }) => {
            await page.goto(`/workspace/11111111-1111-4111-8111-111111111111/chat/${SESSION_ID}`);
            await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

            await page.evaluate(
                ({ requestId, runId, sessionId, workspaceId }) => {
                    (window as unknown as Record<string, unknown>).__pushApprovalEvent!({
                        requestId,
                        runId,
                        sessionId,
                        workspaceId,
                        tool: "write_file",
                        action: "write file",
                        details: "src/main.rs",
                        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                    });
                },
                {
                    requestId: REQUEST_ID_1,
                    runId: RUN_ID_1,
                    sessionId: SESSION_ID,
                    workspaceId: WORKSPACE_ID,
                },
            );

            const dialog = page.locator('[data-testid="modal-content"]');
            await expect(dialog).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
            await expect(dialog.locator("text=write file")).toBeVisible();
            await expect(dialog.locator("text=src/main.rs")).toBeVisible();
        });

        test("approval modal shows approve and reject buttons", async ({ page }) => {
            await page.goto(`/workspace/11111111-1111-4111-8111-111111111111/chat/${SESSION_ID}`);
            await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

            await page.evaluate(
                ({ requestId, runId, sessionId, workspaceId }) => {
                    (window as unknown as Record<string, unknown>).__pushApprovalEvent!({
                        requestId,
                        runId,
                        sessionId,
                        workspaceId,
                        tool: "edit_file",
                        action: "edit file",
                        details: "src/lib.rs",
                        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                    });
                },
                {
                    requestId: REQUEST_ID_2,
                    runId: RUN_ID_2,
                    sessionId: SESSION_ID,
                    workspaceId: WORKSPACE_ID,
                },
            );

            const dialog = page.locator('[data-testid="modal-content"]');
            await expect(dialog).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
            await expect(dialog.locator('[data-testid="approval-approve"]')).toBeEnabled();
            await expect(dialog.locator('[data-testid="approval-reject"]')).toBeEnabled();
        });
    });

    test.describe("DiffViewer", () => {
        // task-134：旧体用 page.evaluate 自己造一段 `data-testid="diff-viewer"/"diff-file"` 的 HTML
        // 再断言它可见 —— 断言对象是测试自己造的东西，产品改名（DiffViewer.vue:113 现为
        // `workspace-diff-viewer`）后它仍"绿"，属于假覆盖。真实覆盖见
        // e2e/real/full-ui-acceptance.spec.ts:793（编辑文件 → 「差异」→ workspace-diff-viewer 可见）。
        test("retires the self-injected diff fixture", async ({ page }) => {
            await page.goto(`/workspace/11111111-1111-4111-8111-111111111111/chat/${SESSION_ID}`);
            await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
            // 退休判据：页面里不再存在旧的自造夹具 testid（真要测差异走真实入口）。
            await expect(page.locator('[data-testid="diff-viewer"]')).toHaveCount(0);
            await expect(page.locator('[data-testid="diff-file"]')).toHaveCount(0);
        });
    });

    test.describe("Cancel endpoint contract", () => {
        test("cancel API mock returns correct response structure", async ({ page }) => {
            await page.route("**/api/v1/chat/runs/*/cancel", async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ status: "cancel_accepted", runId: RUN_ID_1 }),
                });
            });

            await page.goto(`/workspace/11111111-1111-4111-8111-111111111111/chat/${SESSION_ID}`);
            await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

            // Verify route is registered by making a fetch from page context
            // fixture-only: 路由已被本用例 page.route 拦截（见上），此 fetch 只验证 mock 契约本身，不触达真实后端
            const result = await page.evaluate(async (runId) => {
                const resp = await fetch(`/api/v1/chat/runs/${runId}/cancel`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ reason: "user_requested" }),
                });
                return { status: resp.status, body: await resp.json() };
            }, RUN_ID_1);
            expect(result.status).toBe(200);
            expect(result.body.status).toBe("cancel_accepted");
        });

        test("cancel mock returns 409 for terminal run", async ({ page }) => {
            await page.route("**/api/v1/chat/runs/*/cancel", async (route) => {
                await route.fulfill({
                    status: 409,
                    contentType: "application/json",
                    body: JSON.stringify({
                        type: "https://xihe.dev/problems/run-not-cancellable",
                        title: "Conflict",
                        status: 409,
                        code: "RUN_NOT_CANCELLABLE",
                        detail: "Run is in terminal state: succeeded",
                    }),
                });
            });

            await page.goto(`/workspace/11111111-1111-4111-8111-111111111111/chat/${SESSION_ID}`);
            await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

            // fixture-only: 该路由已被本用例 page.route 拦截（见上），此 fetch 只验证 409 mock 契约，不触达真实后端
            const result = await page.evaluate(async (runId) => {
                const resp = await fetch(`/api/v1/chat/runs/${runId}/cancel`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                });
                return { status: resp.status, body: await resp.json() };
            }, RUN_ID_1);
            expect(result.status).toBe(409);
            expect(result.body.code).toBe("RUN_NOT_CANCELLABLE");
        });
    });
});
