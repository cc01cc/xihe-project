import { expect, type Locator, type Page } from "@playwright/test";

/**
 * BL-547 (task-175): reka-ui `Select` 交互形态辅助。
 *
 * 背景：`components/ui/select` 的触发器是 `SelectTrigger` = `<button role="combobox">`
 * （reka-ui 原语），不是原生 `<select>`。因此：
 *
 * - `locator.selectOption()` 直接以 "Not an input element" 失败（Playwright 只接受
 *   select/option 元素）；
 * - `expect(locator).toHaveValue()` 同样不适用（只看 input/textarea/select 的 value）。
 *
 * 统一修法 = 点触发器 → 点 portal 里的 `role="option"`；断言当前值读触发器的可见文本
 * （`SelectValue` 渲染的就是当前选中项标签，`placeholder` 时渲染占位文案）。
 *
 * 注意 portal：reka 把 `SelectContent` teleport 到 `body` 下，选项**不在**触发器父级里，
 * 所以选项一律从 `page` 上按 role 找。
 */

/** 点开 reka Select 并选中一项（按可见文本匹配选项）。 */
export async function chooseRekaOption(
    page: Page,
    trigger: Locator,
    optionName: string | RegExp,
): Promise<void> {
    await trigger.click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    await page.getByRole("option", { name: optionName }).click();
    // 收起才代表交互完成：随后的等待/断言都建立在这之后。
    await expect(listbox).toBeHidden();
}

/**
 * 断言 reka Select 的当前值 —— 用触发器可见文本代替 `toHaveValue`。
 * 传入 RegExp 可同时匹配中英两套标签（E2E 的 UI 语言由账号设置决定）。
 */
export async function expectRekaValue(trigger: Locator, text: string | RegExp): Promise<void> {
    await expect(trigger).toContainText(text);
}
