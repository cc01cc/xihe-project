/**
 * BL-335 · SSE 订阅上限（429）的用户可见状态。
 *
 * 为什么要这个模块：CP 已有两个"订阅者上限"的 429 —— 工作区事件流
 * `WORKSPACE_EVENT_SUBSCRIBERS_LIMIT`（`WorkspaceEventManager`，每工作区 8 条）与用户通道
 * `USER_CHANNEL_FULL`（`UserChannelSseManager`）。指引是"关掉不用的标签页"，但 UI 之前把 code
 * 丢掉、只留一句 `Error.message`，页面上**没有任何提示** ⇒ 用户只看到"数据不再刷新了"。
 *
 * 语义：上限是**持续态**（不是一次性错误），所以用模块级状态 + 壳级横幅（`role="status"`）
 * 呈现，而不是 4 秒后消失的 toast；重新连上（open 成功）时由**对应通道** `clear` 掉。
 *
 * 通道隔离（D-713/BL-335）：同一 code 可能同时出现在多个工作区/用户通道；A 通道重连成功
 * 只能清掉 A 自己的上限，否则 B 工作区的横幅会被无辜撤掉。状态因此按 `channel` 分组，
 * 不带 channel 的旧调用仍按"全局"语义兼容（`*` 分组）。
 *
 * 只认这两个 code：其它 429（模型配额、审批限流…）各有自己的提示面，不在这里兜。
 */
import { computed, readonly, ref } from "vue";

export const SSE_SUBSCRIBER_LIMIT_CODES = [
    "WORKSPACE_EVENT_SUBSCRIBERS_LIMIT",
    "USER_CHANNEL_FULL",
] as const;

export type SseSubscriberLimitCode = (typeof SSE_SUBSCRIBER_LIMIT_CODES)[number];

/** 不传 channel 的旧调用归到 `*` 分组（全局横幅），向后兼容。 */
const GLOBAL_CHANNEL = "*";

type ActiveByChannel = ReadonlyMap<string, ReadonlySet<string>>;

const activeByChannel = ref<ActiveByChannel>(new Map());

function isLimitCode(code: string | null | undefined): code is SseSubscriberLimitCode {
    return (
        typeof code === "string" && (SSE_SUBSCRIBER_LIMIT_CODES as readonly string[]).includes(code)
    );
}

/** 通道报告"撞上订阅上限"。非上限 code 一律忽略（不吞别人的错误语义）。 */
export function reportSseSubscriberLimit(
    code: string | null | undefined,
    channel: string = GLOBAL_CHANNEL,
): void {
    if (!isLimitCode(code)) return;
    const current = activeByChannel.value.get(channel);
    if (current?.has(code)) return;
    const next = new Map(activeByChannel.value);
    next.set(channel, new Set(current).add(code));
    activeByChannel.value = next;
}

/**
 * 通道恢复时清掉**该通道**的 code；不传 channel 则清掉所有通道的该 code（旧全局语义）。
 * `clearSseSubscriberLimit(undefined, channel)` 清掉整个通道（壳卸载）。
 */
export function clearSseSubscriberLimit(code?: string | null, channel?: string | null): void {
    const hasCode = code !== undefined && code !== null;
    const hasChannel = channel !== undefined && channel !== null;

    if (!hasCode && !hasChannel) {
        if (activeByChannel.value.size > 0) activeByChannel.value = new Map();
        return;
    }

    const next = new Map(activeByChannel.value);
    let changed = false;

    if (hasChannel) {
        const codes = next.get(channel);
        if (!codes) return;
        if (!hasCode) {
            next.delete(channel);
            changed = true;
        } else if (codes.has(code!)) {
            const updated = new Set(codes);
            updated.delete(code!);
            if (updated.size > 0) next.set(channel, updated);
            else next.delete(channel);
            changed = true;
        }
    } else {
        // 旧调用：只给 code、不给通道 ⇒ 从所有通道移除（保持历史语义）。
        for (const [existingChannel, codes] of next) {
            if (!codes.has(code!)) continue;
            const updated = new Set(codes);
            updated.delete(code!);
            if (updated.size > 0) next.set(existingChannel, updated);
            else next.delete(existingChannel);
            changed = true;
        }
    }

    if (changed) activeByChannel.value = next;
}

/**
 * 只读视图：横幅按 `isActive` 渲染；传入 channel 时只看该通道，不传则看全部通道（壳级横幅）。
 * `codes` 供日志/诊断，是跨通道聚合值。
 */
export function useSseSubscriberLimit(channel?: string | null) {
    const isActive = computed(() => {
        if (channel !== undefined && channel !== null) {
            return (activeByChannel.value.get(channel)?.size ?? 0) > 0;
        }
        return activeByChannel.value.size > 0;
    });
    const codes = computed<ReadonlySet<string>>(
        () =>
            new Set(
                [...activeByChannel.value.values()].flatMap((values) => [...values]) as string[],
            ),
    );
    return { isActive, codes: readonly(codes) };
}

/** 测试 seam：用例之间必须互不影响（模块级状态最容易被串味）。 */
export function __resetSseSubscriberLimitForTests(): void {
    activeByChannel.value = new Map();
}
