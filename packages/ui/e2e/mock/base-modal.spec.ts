import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { BaseModalPage } from "../page-objects/BaseModalPage";
import { expectPlatformScreenshot } from "../helpers/visual";

test.describe("BaseModal", () => {
    // task-174：截图必须是用例**最后一步**，否则 `expectPlatformScreenshot` 在非 linux 平台
    // 的 skip 会把它之后的语句一起截断。原用例「开→截图→点背景→断言关闭」就是这样 —— 于是拆成
    // 「视觉用例（开→截图）」+「行为用例（开→点背景→断言关闭）」，注入步骤抽成共用前置。
    async function openInjectedModal(page: Page) {
        // BL-318：之前只塞 token、不桩接口 —— `/workspace` 首屏会打 `/workspaces`、
        // `/auth/me`、`/user-events` 等真实请求并吃 401（门禁接上后才暴露）。
        await setupMockAuth(page);
        await page.goto("/workspace");
        await page.waitForLoadState("load");

        // Open modal by injecting markup that mimics BaseModal.vue behavior
        await page.evaluate(() => {
            const host = document.createElement("div");
            host.id = "injected-modal-host";
            host.innerHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center" data-testid="modal-backdrop">
          <div class="fixed inset-0 bg-black/50" data-testid="modal-overlay"></div>
          <div class="relative z-10 w-full max-w-md rounded-xl border bg-card p-6 shadow-lg" data-testid="modal-content">
            <h2 class="text-lg font-semibold">Test Modal</h2>
            <p>Modal content</p>
          </div>
        </div>
      `;
            const overlay = host.querySelector('[data-testid="modal-overlay"]') as HTMLElement;
            overlay.addEventListener("click", () => host.remove());
            document.body.appendChild(host);
        });
    }

    test("renders the open modal (visual baseline)", async ({ page }) => {
        await openInjectedModal(page);
        // 视觉基线 `base-modal-open.png`：本条在 linux 上比对，其他平台记 skipped（task-174）。
        await expectPlatformScreenshot(page, "base-modal-open.png");
    });

    test("opens and closes via backdrop click", async ({ page }) => {
        await openInjectedModal(page);
        const modal = new BaseModalPage(page);

        // Click backdrop overlay (outside content) to close
        await modal.clickBackdrop();

        // Verify backdrop click closes (modal removed from DOM)
        await expect(modal.backdrop).not.toBeVisible();
    });
});
