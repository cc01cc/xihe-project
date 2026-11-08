import { expect, type Locator, type Page } from "@playwright/test";

/**
 * PLAN-0707：0698 把原生 `<select>` 换成 shadcn/reka `Select`（trigger 是 button，
 * 选项在 popup 的 `role="option"`，DOM 上没有 value 属性）。e2e 里原来的
 * `locator.selectOption()` / `toHaveValue()` 因此失效；本 helper 是唯一适配层。
 *
 * value→显示文案集中在这里（按 trigger testid 分组）；没有映射时回退 value 本身，
 * 便于未列出的下拉先跑通，再补映射。
 */
export const SELECT_LABELS: Record<string, Record<string, string>> = {
    "approval-rule-layer": { workspace: "工作区层", user: "用户层" },
    "approval-classify-shape": {
        structured: "结构化",
        interpreter: "解释器型",
        opaque: "不透明",
    },
    "session-policy-mode": { manual: "手动审批", auto: "自动放行" },
    "settings-audit-status": { failed: "失败" },
    "settings-audit-type": { chat_run: "对话运行" },
    "ws-members-add-role": { EDITOR: "编辑", VIEWER: "只读" },
    "workspace-execution-mode": {
        "windows-mxc": "windows-mxc",
        "windows-host": "宿主执行（不受限制）",
    },
    "config-select-approval-policy-mode": { manual: "手动审批", auto: "自动放行" },
};

export function selectLabelFor(testId: string, value: string): string {
    return SELECT_LABELS[testId]?.[value] ?? value;
}

/** 点 trigger 打开 popup，再点可见文案匹配的 option。 */
export async function selectByLocator(trigger: Locator, label: string): Promise<void> {
    await trigger.click();
    await trigger.page().getByRole("option", { name: label }).click();
}

/** DOM click 兜底：绕过 reka popup 的 actionability/浮层遮挡，直接触发 item 的 click。 */
export async function selectByDomClick(trigger: Locator, label: string | RegExp): Promise<void> {
    await trigger.click();
    const page = trigger.page();
    const option = page.getByRole("option", { name: label }).first();
    await option.evaluate((el) => (el as HTMLElement).click());
}

/** 点 option 的可见文本（reka 的 role=option 在浮层内偶发 actionability 超时的兜底）。 */
export async function selectByText(trigger: Locator, text: string | RegExp): Promise<void> {
    await trigger.click();
    await trigger.page().getByText(text, { exact: typeof text === "string" }).click();
}

/** 键盘选择：`index` 为 option 顺序（0 起）；用于 reka popup 被动画/浮层干扰的弹窗内下拉。 */
export async function selectByIndex(trigger: Locator, index: number): Promise<void> {
    await trigger.click();
    const page = trigger.page();
    // 弹窗内 Select（BaseModal focus trap）不能用鼠标点 portal 里的 option：会被 outside-click
    // 先关闭 popup。键盘事件走 listbox focus，不受 focus trap 影响。
    await page.getByRole("listbox").waitFor({ state: "visible", timeout: 2_000 }).catch(() => {});
    // index = 从当前高亮项往下按几次；1 = 选中下一项（弹窗内 Select 的常用场景）。
    for (let i = 0; i < index; i += 1) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
}

/** testid 在 trigger 上时的快捷方式；value 走集中映射。 */
export async function selectByTestId(page: Page, testId: string, value: string): Promise<void> {
    await selectByLocator(page.getByTestId(testId), selectLabelFor(testId, value));
}

/** 读 trigger 的当前文案（替代 `toHaveValue`）。 */
export async function triggerLabel(page: Page, testId: string): Promise<string> {
    return (await page.getByTestId(testId).innerText()).trim();
}

export async function expectTriggerLabel(page: Page, testId: string, value: string): Promise<void> {
    await expect(page.getByTestId(testId)).toContainText(selectLabelFor(testId, value));
}
