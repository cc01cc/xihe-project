/**
 * BL-335 · SSE 订阅上限（429）的用户可见状态。
 *
 * 为什么要这个模块：CP 已有两个"订阅者上限"的 429 —— 工作区事件流
 * `WORKSPACE_EVENT_SUBSCRIBERS_LIMIT`（`WorkspaceEventManager`，每工作区 8 条）与用户通道
 * `USER_CHANNEL_FULL`（`UserChannelSseManager`）。指引是"关掉不用的标签页"，但 UI 之前把 code
 * 丢掉、只留一句 `Error.message`，页面上**没有任何提示** ⇒ 用户只看到"数据不再刷新了"。
 *
 * 语义：上限是**持续态**（不是一次性错误），所以用模块级状态 + 壳级横幅（`role="status"`）
 * 呈现，而不是 4 秒后消失的 toast；重新连上（open 成功）时由对应通道 `clear` 掉。
 *
 * 只认这两个 code：其它 429（模型配额、审批限流…）各有自己的提示面，不在这里兜。
 */
import { computed, readonly, ref } from "vue";

export const SSE_SUBSCRIBER_LIMIT_CODES = [
    "WORKSPACE_EVENT_SUBSCRIBERS_LIMIT",
    "USER_CHANNEL_FULL",
] as const;

export type SseSubscriberLimitCode = (typeof SSE_SUBSCRIBER_LIMIT_CODES)[number];

const activeCodes = ref<ReadonlySet<string>>(new Set());

function isLimitCode(code: string | null | undefined): code is SseSubscriberLimitCode {
    return (
        typeof code === "string" && (SSE_SUBSCRIBER_LIMIT_CODES as readonly string[]).includes(code)
    );
}

/** 通道报告"撞上订阅上限"。非上限 code 一律忽略（不吞别人的错误语义）。 */
export function reportSseSubscriberLimit(code: string | null | undefined): void {
    if (!isLimitCode(code)) return;
    if (activeCodes.value.has(code)) return;
    const next = new Set(activeCodes.value);
    next.add(code);
    activeCodes.value = next;
}

/** 通道恢复（重连成功 / 组件卸载）时清掉对应 code；不传 code 则全清。 */
export function clearSseSubscriberLimit(code?: string | null): void {
    if (code !== undefined && code !== null) {
        if (!activeCodes.value.has(code)) return;
        const next = new Set(activeCodes.value);
        next.delete(code);
        activeCodes.value = next;
        return;
    }
    if (activeCodes.value.size === 0) return;
    activeCodes.value = new Set();
}

/** 只读视图：横幅按 `isActive` 渲染，`codes` 供日志/诊断。 */
export function useSseSubscriberLimit() {
    const isActive = computed(() => activeCodes.value.size > 0);
    return { isActive, codes: readonly(activeCodes) };
}

/** 测试 seam：用例之间必须互不影响（模块级状态最容易被串味）。 */
export function __resetSseSubscriberLimitForTests(): void {
    activeCodes.value = new Set();
}
