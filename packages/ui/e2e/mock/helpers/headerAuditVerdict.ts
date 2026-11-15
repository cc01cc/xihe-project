/**
 * `task-208`（`D-1567` / `D-1570`）：**一行请求算不算「泄漏」**的纯判据。
 *
 * <p>为什么需要它：`task585-wsless-header-audit.spec.ts` 里两族断言原来口径不一 —— P1 家族已经用
 * 「`msSinceCtxWrite` 不等式」，而 picker 家族还是「带旧头的行一条都不许有」。后者会把**合法的在途
 * 请求**判成缺陷（`task-204` 实测那行 `msSinceCtxWrite = -384`：点击瞬间在途、比 ctx 写入早 384 ms）
 * ⇒ 断言从此长期红，等于把「测量缺口」和「真泄漏」混成一类。</p>
 *
 * <p>判据（三态，`D-1567`）：</p>
 * <ul>
 *   <li>`msSinceCtxWrite > 0` ⇒ ctx 已经切走仍带旧头 ⇒ **泄漏**；</li>
 *   <li>`msSinceCtxWrite < 0` ⇒ 请求在 ctx 写入前发出 ⇒ **合法在途**，不是缺陷；</li>
 *   <li>`msSinceCtxWrite === null` ⇒ **测量缺口**（探针没装上 / 没读到）⇒ **按泄漏处理（fail-closed）**：
 *       `unknown` 不许当清白，否则「没测」会被读成「没问题」（`task-204` 之前正是这样）。</li>
 * </ul>
 *
 * <p>这里只放纯函数、**不 import `@playwright/test`**：它要能被 `node:test` 单测直接拉起（秒级、无浏览器）。</p>
 */

/** 判据只依赖这一个字段，所以类型收窄到最小面（`AbRowAnnotated` 可结构赋值进来）。 */
export interface CtxTimelineRow {
    /** 请求发出时刻 − ctx 写入时刻（ms）。`null` = 没测到（测量缺口）。 */
    msSinceCtxWrite: number | null;
}

/** 这一行是否**必须被判为泄漏**（三态见文件头注释；`null` fail-closed）。 */
export function isLeakRow(row: CtxTimelineRow): boolean {
    return row.msSinceCtxWrite === null || row.msSinceCtxWrite > 0;
}
