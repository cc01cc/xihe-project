// timeout-exempt: 30s 静默 + toast 渲染余量（PLAN-0709，单例放宽到 45s/40s）
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { resolve } from "node:path";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import {
    ACTION_TIMEOUT_MS,
    EXPECT_TIMEOUT_MS,
} from "../timeouts";

const SESSION_ID = "liveness-session";

async function installLivenessSSE(page: Page) {
    await page.addInitScript(() => {
        let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
        const encode = (value: string) => new TextEncoder().encode(value);
        const sse = (name: string, data: unknown) =>
            `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        (window as unknown as Record<string, unknown>).__pushLivenessEvent = (
            name: string,
            data: unknown,
        ) => {
            controllerRef?.enqueue(encode(sse(name, data)));
        };
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const requestUrl =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : input.url;
            if (requestUrl.includes("/api/v1/events")) {
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controllerRef = controller;
                        controller.enqueue(encode("retry: 1000\n\n"));
                    },
                });
                return new Response(body, {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                });
            }
            if (
                requestUrl.includes("/api/v1/chat") &&
                !requestUrl.includes("/api/v1/chat/") &&
                (init?.method ?? "GET") === "POST"
            ) {
                const payload =
                    typeof init?.body === "string"
                        ? (JSON.parse(init.body) as { branchId?: string })
                        : {};
                if (!payload.branchId) {
                    return new Response(
                        JSON.stringify({ code: "INVALID_REQUEST", detail: "branchId is required" }),
                        {
                            status: 400,
                            headers: { "Content-Type": "application/problem+json" },
                        },
                    );
                }
                return new Response(JSON.stringify({ status: "accepted" }), {
                    status: 202,
                    headers: { "Content-Type": "application/json" },
                });
            }
            return originalFetch(input, init);
        };
    });
}

async function push(page: Page, name: string, data: unknown) {
    await page.evaluate(
        ([eventName, payload]) => {
            (window as unknown as Record<string, unknown>).__pushLivenessEvent!(
                eventName as string,
                payload,
            );
        },
        [name, data] as const,
    );
}

async function startRun(page: Page) {
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await page.locator("textarea").fill("run a long task");
    await page.locator("textarea").press("Enter");
    await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    await push(page, "token", { content: "working" });
    await expect(page.locator("text=working")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
}

const evidenceDir = resolve(process.cwd(), "../../../.local/plan-0323");
const messageError = (page: Page) => page.locator('[data-testid="message-error"]');

test.describe("SSE liveness timer (S-1)", () => {
    test.beforeEach(async ({ page }) => {
        await page.clock.install();
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Liveness" }] });
        await installLivenessSSE(page);
    });

    test("heartbeats keep a long silent tool gap alive", async ({ page }) => {
        await startRun(page);

        for (let i = 0; i < 4; i += 1) {
            await page.clock.fastForward(20_000);
            await push(page, "heartbeat", { type: "heartbeat" });
        }
        await page.clock.fastForward(20_000);

        await expect(messageError(page)).toHaveCount(0);
        await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
        await page.screenshot({ path: resolve(evidenceDir, "s1-liveness-heartbeats.png") });
    });

    test("silence after content triggers AGENT_TIMEOUT", async ({ page }) => {
        await startRun(page);

        await page.clock.fastForward(31_000);

        const banner = messageError(page);
        await expect(banner).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(banner).toContainText("AGENT_TIMEOUT");
        // BL-328 家族（toast 竞争）：同一时刻可能还有**另一条不同来源**的 toast（provider 自动绑定
        // 成功，`chat.providerAutoBound`）。两条语义不同、共用同一个 sonner 容器且没有去重键 ⇒
        // 正确做法是**按类型/文案锁定目标 toast**，而不是让 strict 模式去猜（判据：error 类型只有 1 条）。
        const timeoutToast = page
            .locator("[data-sonner-toast]")
            .filter({ hasText: "AGENT_TIMEOUT" });
        await expect(timeoutToast).toHaveCount(1);
        await expect(timeoutToast).toContainText("AGENT_TIMEOUT");
        // Let enter animations settle under the fake clock before capturing evidence.
        await page.clock.fastForward(500);
        await page.screenshot({ path: resolve(evidenceDir, "s1-liveness-timeout.png") });
    });

    test("silence before the first token also reports AGENT_TIMEOUT", async ({ page }) => {
        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await page.locator("textarea").fill("quick question");
        await page.locator("textarea").press("Enter");
        await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });

        await page.clock.fastForward(31_000);

        // No assistant message exists yet, so the user-visible surface is the toast.
        // BL-328 家族：按 `data-type="error"` 锁定（见上一条用例的说明）。
        const toast = page.locator("[data-sonner-toast]").filter({ hasText: "AGENT_TIMEOUT" });
        await expect(toast).toHaveCount(1);
        await expect(toast).toContainText("AGENT_TIMEOUT", { timeout: EXPECT_TIMEOUT_MS });
        // Let enter animations settle under the fake clock before capturing evidence.
        await page.clock.fastForward(500);
        await page.screenshot({ path: resolve(evidenceDir, "s1-liveness-pre-content.png") });
    });
});

test.describe("SSE liveness timer (S-1, real time)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Liveness" }] });
        await installLivenessSSE(page);
    });

    test("pre-content silence shows a visible AGENT_TIMEOUT toast in real time", async ({
        page,
    }) => {
        test.setTimeout(45_000); // timeout-exempt: 30s 静默 + toast 渲染余量
        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await page.locator("textarea").fill("quick question");
        await page.locator("textarea").press("Enter");
        await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });

        // BL-328 家族：先按**文案**锁定目标 toast（同一时刻可能还有 provider 自动绑定那条），
        // 再等它出现——顺序不能反：此时 30s 静默还没到，先断数量必然数到 0。
        const toast = page.locator("[data-sonner-toast]").filter({ hasText: "AGENT_TIMEOUT" });
        // timeout-exempt: 产品 STREAM_TIMEOUT_MS=30000，toast 必晚于 30s；测试总预算同值会先超时。
        await expect(toast).toContainText("AGENT_TIMEOUT", { timeout: 40_000 });
        await expect(toast).toHaveCount(1);
        // PLAN-0325: the toast must be actually visible inside the viewport
        // (the pre-fix defect placed it below the fold: rect.y == viewport height).
        await expect(toast).toBeInViewport();
        await page.screenshot({
            path: resolve(evidenceDir, "s1-liveness-pre-content-realtime.png"),
        });
    });
});
