import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";

// BL-518 / PLAN-0714：BaseModal backdrop z-60 曾遮住 Popover z-50；本用例走真实
// BaseModal + Popover（DEV-only /preview.html 的真实组件页），证明弹窗内选项可点。
test("Modal 内 Popover 的选项可点击", async ({ page }) => {
    await setupMockAuth(page);
    await page.goto("/preview.html");

    await page.getByTestId("preview-open-modal").click();
    await expect(page.getByTestId("modal-content")).toBeVisible();
    await page.getByTestId("preview-popover-trigger").click();
    await expect(page.getByTestId("preview-popover-content")).toBeVisible();
    await page.getByTestId("preview-popover-item").click();

    await expect(page.getByTestId("preview-picked")).toHaveText("已选择：层级正确");
});
