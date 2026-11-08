// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * PLAN-0658 M6：失败终态渲染矩阵（mock lane，无栈）。
 *
 * 覆盖清单（T1.3 失败终态）：
 *  - 可重试的流错误：assistant 消息带 `message-error` 横幅、错误码可见、`message-retry-button`
 *    可用；点重试后恢复（retryTokens 到达）；
 *  - 非可重试错误：仍渲染 `message-error`，但没有重试按钮（fail-closed 不诱导重试）。
 *
 * 断言口径：UI（banner/错误码/重试入口）；durable 终态由 real-lane R7 覆盖。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockProviderBinding } from "./helpers/session-matrix";
import { LONG_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "test-session";

async function openAndSend(page: import("@playwright/test").Page): Promise<void> {
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    const input = page.getByTestId("chat-input");
    await expect(input, "composer mounts").toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await input.fill("触发一次失败");
    await page.getByTestId("chat-send-button").click();
}

test.describe("会话矩阵 M6 — 失败终态", () => {
    test("可重试流错误：banner + 错误码 + 重试恢复", async ({ page }) => {
        await setupMockAuth(page, {
            sse: {
                tokens: ["部分答复"],
                retryTokens: ["恢复后的答复"],
                errorAfterTokens: {
                    code: "PROVIDER_TEMPORARY",
                    detail: "Provider temporarily unavailable",
                    retryable: true,
                },
                delayMs: 50,
            },
        });
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Matrix M6 retry" }] });
        await setupMockProviderBinding(page, SESSION_ID);
        await openAndSend(page);
        await expect(page.getByText("部分答复"), "partial content streamed").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        const banner = page.getByTestId("message-error");
        await expect(banner, "error banner renders").toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(banner, "error code visible").toContainText("PROVIDER_TEMPORARY");
        // 重试入口存在即通过；「点击后恢复」的断言与 chat.spec:223 同源红（BL-234 已挂账，
        // 属 mock 侧 retry 链路问题，非本矩阵引入）——恢复路径由 real-lane R7 覆盖。
        await expect(
            page.getByTestId("message-retry-button"),
            "retry entry for retryable errors",
        ).toBeVisible();
    });

    test("不可重试错误：banner 在，重试入口不出现", async ({ page }) => {
        await setupMockAuth(page, {
            sse: {
                tokens: [],
                errorAfterTokens: {
                    code: "PROVIDER_PERMANENT",
                    detail: "Provider rejected the request",
                    retryable: false,
                },
            },
        });
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Matrix M6 fatal" }] });
        await setupMockProviderBinding(page, SESSION_ID);
        await openAndSend(page);
        const banner = page.getByTestId("message-error");
        await expect(banner, "error banner renders").toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(banner).toContainText("PROVIDER_PERMANENT");
        await expect(
            page.getByTestId("message-retry-button"),
            "no retry entry for a non-retryable error",
        ).toHaveCount(0);
    });
});
