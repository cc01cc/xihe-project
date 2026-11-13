import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * task-427 P2（B 一致性）：连接弹窗 footer 的「验证并保存」「取消」此前没有 testid，
 * 消费者只能靠 button[type="submit"] 之类的结构选择器定位（task-284 spec :84 就是这么写的）。
 * ui-2 在 188e816b 补了 provider-connection-submit / provider-connection-cancel；
 * 本 spec 是这两个 testid 的第一个消费者 —— 没有消费者就等于没验过。
 *
 * <p>跑法（单 spec = L0，独立 --output 避免与他人产物互删）：XIHE_E2E_PROFILE=mock
 * XIHE_E2E_EXPECT_CHAIN=preview pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/task427-connection-dialog.spec.ts --workers=1 --output=H:/zeotmp/ui1-pw/task-427</p>
 *
 * <p>不调 setupMockAuth：它的 api/v1 通配兜底会盖掉 task-454 的真写面（同 task-284 的理由）。</p>
 */
const INSTANCE_URL = "/settings/instance/llm-provider";
const ROWS = 'article[data-testid^="provider-connection-"]';

async function openDialog(page: Page) {
    await page.goto(INSTANCE_URL);
    await expect(page.getByTestId("provider-hub")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await page.getByTestId("provider-hub-connect").click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.getByTestId("provider-picker-modal")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page.getByTestId("provider-picker-anthropic").click({ timeout: ACTION_TIMEOUT_MS });
    const modal = page.getByTestId("provider-connection-modal");
    await expect(modal).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    return modal;
}

test.describe("connection dialog footer testids (task-427 P2)", () => {
    test("两个 testid 存在且语义正确：取消是 button、提交是 submit", async ({ page }) => {
        const modal = await openDialog(page);
        const cancel = modal.getByTestId("provider-connection-cancel");
        const submit = modal.getByTestId("provider-connection-submit");
        await expect(cancel).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(submit).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(cancel).toHaveAttribute("type", "button");
        await expect(submit).toHaveAttribute("type", "submit");
    });

    test("点取消关闭弹窗，且列表行数不变", async ({ page }) => {
        const modal = await openDialog(page);
        const before = await page.locator(ROWS).count();
        await modal.getByTestId("provider-connection-cancel").click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("provider-connection-modal")).toHaveCount(0, {
            timeout: EXPECT_TIMEOUT_MS,
        });
        expect(await page.locator(ROWS).count()).toBe(before);
    });

    test("空表单点提交不会创建连接（提交按钮真的接在表单上）", async ({ page }) => {
        const modal = await openDialog(page);
        const before = await page.locator(ROWS).count();
        await modal.getByTestId("provider-connection-submit").click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("provider-connection-modal")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        expect(await page.locator(ROWS).count()).toBe(before);
    });
});
