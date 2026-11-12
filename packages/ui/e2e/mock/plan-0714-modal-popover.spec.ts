import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";

// BL-518 / PLAN-0714：BaseModal backdrop z-60 曾遮住 Popover z-50；本用例走真实
// BaseModal + Popover（DEV-only /preview.html 的真实组件页），证明弹窗内选项可点。
//
// 自证型（页面自洽，标记只写在下面的用例标题上，避免同一用例被计两次）：被测页面是 preview 稿面本身，结尾断言的
// 「已选择：层级正确」由该页面自己的源码产出（`src/preview/sections/ModalOverlaySection.vue:12`）
// ⇒ 产品文案/IA 改了它也绿，只证明"弹窗内选项点得动、选中值回填到稿面"。按 `packages/ui/e2e/README.md`
// 的分母口径，本用例**不计入**「产品文案/IA 覆盖」。
test("[mock-self] Modal 内 Popover 的选项可点击", async ({ page }) => {
    await setupMockAuth(page);
    await page.goto("/preview.html");

    await page.getByTestId("preview-open-modal").click();
    await expect(page.getByTestId("modal-content")).toBeVisible();
    await page.getByTestId("preview-popover-trigger").click();
    await expect(page.getByTestId("preview-popover-content")).toBeVisible();
    await page.getByTestId("preview-popover-item").click();

    await expect(page.getByTestId("preview-picked")).toHaveText("已选择：层级正确");
});
