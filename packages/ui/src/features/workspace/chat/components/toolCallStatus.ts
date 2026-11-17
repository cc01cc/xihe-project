/**
 * PLAN-0688 T1.3: shared status vocabulary and duration formatting for tool-call
 * cards. The dedicated cards consume it through `toolCallVisual.vue`; the generic
 * fallback consumes it directly, so a wire-status/tone change is one edit, not
 * one copy per card.
 */
import { Bot, CheckCircle, Clock, LoaderCircle, XCircle } from "@lucide/vue";
import type { Component } from "vue";

const statusIcons: Record<string, Component> = {
    pending: Clock,
    running: LoaderCircle,
    completed: CheckCircle,
    failed: XCircle,
    cancelled: XCircle,
    approved: CheckCircle,
    rejected: XCircle,
};

/**
 * task-86（2026-11-17）：色阶按「本行卡片真实最差底面」取值，不是按名义美观。
 *
 * 判据底面 = ProcessRow 所在容器的合成底面（`bg-muted/20` 叠在助手气泡 `bg-muted` 上）。
 * 判据 = WCAG 2.2 SC 1.4.3 正文 4.5:1（DEV-011:196）。
 *
 * **本注释不复制读数**（`D-1767`：一个数若没有会跟着它改的机器判据，就该改成指针）。
 * 取值依据见证据包 `internal/A03-xihe/evidence/2026-11-17-ui-contrast-probe/`：
 * 其 §「逐层 over() 合成」给了合成口径与 token 级校准，复算按同一口径即可。
 * 要核对本文件这几档的实际比值，跑该口径的探针读 `badCount` / `worst`，不要抄这里。
 *
 * 只下沉明度、不动色相与色名族：语义（pending 琥珀 / done 绿 / failed 红 / running 蓝）不变。
 */
const statusTones: Record<string, string> = {
    // dark 档是**必需**的一对，不是顺手补的：浅色档在暗底上必然掉下来（实测掉到 2.x，
    // 读数按上面证据包的口径复算，此处不复制）。两档用同一判据，只是底面换成 dark 主题，
    // 即同一个「逐层 over()」口径跑两遍。
    pending: "text-amber-800 dark:text-amber-300",
    running: "text-blue-700 dark:text-blue-300",
    completed: "text-green-800 dark:text-green-300",
    failed: "text-red-700 dark:text-red-300",
    cancelled: "text-muted-foreground",
    approved: "text-green-800 dark:text-green-300",
    rejected: "text-red-700 dark:text-red-300",
};

export function toolStatusIcon(status: string): Component {
    return statusIcons[status] ?? Bot;
}

export function toolStatusTone(status: string): string {
    return statusTones[status] ?? "text-muted-foreground";
}

export function formatToolDuration(startedAt?: string, completedAt?: string): string | null {
    if (!startedAt || !completedAt) return null;
    const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
