import { expect, type Locator, type Page } from "@playwright/test";
import { i18n } from "../../src/i18n";

/**
 * PLAN-0707：0698 把原生 `<select>` 换成 shadcn/reka `Select`（trigger 是 button，
 * 选项在 popup 的 `role="option"`，DOM 上没有 value 属性）。e2e 里原来的
 * `locator.selectOption()` / `toHaveValue()` 因此失效；本 helper 是唯一适配层。
 *
 * task-210（Lead 裁定 A，2026-11-15）：本表只登记 **wire 值 → i18n 键**，显示文案**运行时从语言包取**。
 * 原先存的是「wire 值 → 硬编码中文标签」的值副本，与 `src/i18n` 各存一份 ⇒ 文案一改副本就静默过期
 * （task-202 实证：本表写 `"windows-mxc": "windows-mxc"`，而产品早已渲染「Windows MXC 沙箱」=
 * `workspace.environmentExecutionMode.windowsMxc`）。**抄文案 = 造副本；认键 = 只有一份真源。**
 */
export const SELECT_LABEL_KEYS: Record<string, Record<string, string>> = {
    "approval-rule-layer": {
        workspace: "chat.approvalLayerWorkspace",
        user: "chat.approvalLayerUser",
    },
    "approval-classify-shape": {
        structured: "chat.approvalShapeStructured",
        interpreter: "chat.approvalShapeInterpreter",
        opaque: "chat.approvalShapeOpaque",
    },
    "session-policy-mode": { manual: "chat.approvalModeManual", auto: "chat.approvalModeAuto" },
    "settings-audit-status": { failed: "settings.auditStatusLabels.failed" },
    "settings-audit-type": { chat_run: "settings.auditTypeChatRun" },
    "ws-members-add-role": {
        EDITOR: "workspace.membersRoleEditor",
        VIEWER: "workspace.membersRoleViewer",
    },
    "workspace-execution-mode": {
        "windows-mxc": "workspace.environmentExecutionMode.windowsMxc",
        "windows-host": "workspace.executionModeHost",
    },
    "config-select-approval-policy-mode": {
        manual: "chat.approvalModeManual",
        auto: "chat.approvalModeAuto",
    },
    /** task-250 §4.6：logging 级别选项已人话化（`ConfigLayerPanels.vue:85-101` levelLabel）。 */
    "config-select-logging-levelCp": {
        TRACE: "settings.logLevelTrace",
        DEBUG: "settings.logLevelDebug",
        INFO: "settings.logLevelInfo",
        WARN: "settings.logLevelWarn",
        ERROR: "settings.logLevelError",
    },
};

/**
 * 取某个 i18n 键的文案：先当前 locale，缺失再回落 zh-CN；两者都没有则返回 `null`。
 *
 * <p>**test-only export，不属产品 API** —— 导出是为了让单测能直接打「键缺失」这条分支；
 * 不导出就只能靠「编一个不存在的 testid」间接覆盖，那等于写一条永远绿的断言（D-1281）。</p>
 */
export function copyForKey(key: string): string | null {
    const current = String(i18n.global.locale.value ?? i18n.global.locale);
    for (const locale of [current, "zh-CN"]) {
        let node: unknown = i18n.global.getLocaleMessage(locale);
        for (const segment of key.split(".")) {
            node = (node as Record<string, unknown> | undefined)?.[segment];
        }
        if (typeof node === "string" && node.length > 0) return node;
    }
    return null;
}

/**
 * wire 值 → 该下拉里用户能看到的文案（供 `selectByLocator` / `expectTriggerLabel` 用）。
 *
 * <p>两种回退都回**原值**、绝不换成别的文案（fail-visible：错就红，而不是静默通过）：
 * ① 未登记的 `(testId, value)`；② 登记了但语言包里没这个键。</p>
 */
export function selectLabelFor(testId: string, value: string): string {
    const key = SELECT_LABEL_KEYS[testId]?.[value];
    if (!key) return value;
    return copyForKey(key) ?? value;
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
    await trigger
        .page()
        .getByText(text, { exact: typeof text === "string" })
        .click();
}

/** 键盘选择：`index` 为 option 顺序（0 起）；用于 reka popup 被动画/浮层干扰的弹窗内下拉。 */
export async function selectByIndex(trigger: Locator, index: number): Promise<void> {
    await trigger.click();
    const page = trigger.page();
    // 弹窗内 Select（BaseModal focus trap）不能用鼠标点 portal 里的 option：会被 outside-click
    // 先关闭 popup。键盘事件走 listbox focus，不受 focus trap 影响。
    await page
        .getByRole("listbox")
        .waitFor({ state: "visible", timeout: 2_000 })
        .catch(() => {});
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
