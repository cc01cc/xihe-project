import { expect } from "vitest";

/**
 * task-49：vendor `DialogContent`/`AlertDialogContent` **不产** `aria-modal` —— reka-ui 的
 * `dist/Dialog/DialogContentImpl.js` 只设 `aria-labelledby` / `aria-describedby`（[源码]）。
 * 本仓既有做法是**调用点显式补** `aria-modal="true"`（BaseModal / AttachmentPreviewDialog /
 * ResourcesLayout / SessionList 四处先例）。
 *
 * <p>为什么必须有它：`aria-modal` 是「弹层之外的内容对 AT 惰性」的**显式声明**。缺了它，
 * 读屏器仍按普通文档遍历 —— 用户能听到、Tab 到背景里的按钮，而视觉上那些按钮被遮罩挡住。
 * 焦点陷阱（reka 的 FocusScope）只管键盘，不管 AT 的浏览光标，两者不能互相替代。</p>
 *
 * <p>三件事一起钉，缺一条都不算修好：</p>
 * <ol>
 *   <li>`role` ∈ {dialog, alertdialog}（同一个弹层不允许两套角色）</li>
 *   <li>`aria-modal === "true"`（本卡要补的那条）</li>
 *   <li>可访问名来自标题元素：`aria-labelledby` 指向的元素文本 = 期望标题
 *       （补了 aria-modal 但弹层无名，读屏器只会念“dialog”，等于换了个哑巴）</li>
 * </ol>
 *
 * @param testid 弹层内容元素的 `data-testid`（teleport 到 `document.body`，不能用 wrapper 查）
 * @param role 期望角色
 * @param title 期望的可访问名（= 标题元素文本）
 */
export function expectModalDialog(
    testid: string,
    role: "dialog" | "alertdialog",
    title: string,
): void {
    const el = document.body.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
    expect(el, `弹层 ${testid} 要挂在 body 上`).toBeTruthy();
    expect(el!.getAttribute("role")).toBe(role);
    expect(el!.getAttribute("aria-modal")).toBe("true");
    const labelledBy = el!.getAttribute("aria-labelledby");
    expect(labelledBy, `${testid} 要有 aria-labelledby`).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent?.trim()).toBe(title);
}
