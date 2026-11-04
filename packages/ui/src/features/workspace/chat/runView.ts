/**
 * PLAN-0659 T1.1：run 分组的**纯展示**派生。
 *
 * - `runShortCode` 只用于展示（run 头 6 位短码），**不是身份**：任何断言/逻辑都必须用全文
 *   `runId`（`data-run-id`），不要拿短码做比较或匹配（截断必然碰撞）。
 * - `formatRunDuration` 用 `SessionRunSummary.createdAt/terminalAt` 计算；没有 `terminalAt`
 *   （仍在途）返回空串 —— 运行中不显示耗时，避免靠定时器每秒重渲染。
 */
export function runShortCode(runId: string | null | undefined): string {
    const value = (runId ?? "").trim();
    if (!value) return "";
    // uuid 前缀已足够区分同屏 2-3 个 run；保留原始字母大小写（不做身份、不参与比较）。
    return value.replace(/-/g, "").slice(0, 6);
}

/** `createdAt → terminalAt` 的耗时（`3.4s` / `1m12s`）；缺任一端或非法时间 ⇒ 空串。 */
export function formatRunDuration(
    createdAt: string | null | undefined,
    terminalAt: string | null | undefined,
): string {
    if (!createdAt || !terminalAt) return "";
    const start = new Date(createdAt).getTime(),
        end = new Date(terminalAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
    const ms = end - start;
    if (ms < 60_000) {
        const seconds = ms / 1000;
        return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
    }
    const minutes = Math.floor(ms / 60_000),
        seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}
