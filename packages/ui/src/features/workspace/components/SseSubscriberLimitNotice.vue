<script lang="ts" setup>
/**
 * SSE 订阅/连接状态横幅。
 *
 * BL-335（t56）：原始形态只表达 `limit`（429 订阅上限）。**状态机仍归
 * `composables/sseSubscriberLimit.ts`，本组件不改它**：不传 `state` 时行为与之前完全一致
 * （读模块级 `isActive`），传 `state` 时由调用方决定三态之一。
 *
 * PLAN-0676 T2 增补：同一组件承载 `limit` / `disconnected` / `reconnecting` 三态——
 * 因为三者对用户是同一件事"实时更新这条链路出问题了"，分成三个横幅会让页面上下叠两条。
 *
 * 无障碍：`role="status"` + `aria-live="polite"`（读屏不抢焦点地播报）；错误码只进 logger 与
 * 根节点 `data-reason`（诊断用），文案里不出现裸 code。
 *
 * 诊断唯一性（PLAN-0676 verify V8 的强化门）：全仓只有本组件带 `data-reason`，`rg -l
 * 'data-reason="'` 的计数必须为 1。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { TriangleAlertIcon, RefreshCwIcon } from "@lucide/vue";
import { useSseSubscriberLimit } from "../composables/sseSubscriberLimit";

export type SseNoticeState = "limit" | "disconnected" | "reconnecting";

const props = defineProps<{
    /** 三态；缺省（不传）时退回 BL-335 的模块级 `limit` 判定。 */
    state?: SseNoticeState;
    /** problem code（诊断用，进 `data-reason`，不进文案）。 */
    code?: string;
    /** 可选：文案里点名哪个工作区（多工作区场景）。 */
    workspaceName?: string;
    onRetry?: () => void;
    onOpenHelp?: () => void;
}>();

const { t } = useI18n();
const { isActive, codes } = useSseSubscriberLimit();

const visible = computed(() => (props.state ? true : isActive.value));
const reason = computed(() => (props.code ?? [...codes.value].join(",")) || "unknown");
const resolvedState = computed<SseNoticeState>(
    () => props.state ?? (isActive.value ? "limit" : "disconnected"),
);

const title = computed(() => {
    if (resolvedState.value === "limit") return t("workspace.sseSubscriberLimitTitle");
    if (resolvedState.value === "reconnecting") return t("workspace.sseReconnectingTitle");
    return t("workspace.sseDisconnectedTitle");
});

const hint = computed(() => {
    if (resolvedState.value === "limit") return t("workspace.sseSubscriberLimitHint");
    if (resolvedState.value === "reconnecting") return t("workspace.sseReconnectingHint");
    return t("workspace.sseDisconnectedHint");
});
</script>

<template>
    <div
        v-if="visible"
        data-testid="sse-subscriber-limit-notice"
        :data-state="resolvedState"
        :data-reason="reason"
        role="status"
        aria-live="polite"
        class="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
        <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p class="min-w-0 flex-1">
            <span class="font-medium">{{ title }}</span>
            <span v-if="workspaceName" class="ml-1 font-medium">{{ workspaceName }}</span>
            <span class="ml-1">{{ hint }}</span>
        </p>
        <button
            v-if="resolvedState !== 'reconnecting' && onRetry"
            type="button"
            data-testid="sse-notice-retry"
            class="inline-flex shrink-0 items-center gap-1 rounded border border-amber-600/40 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
            @click="onRetry?.()"
        >
            <RefreshCwIcon class="size-3" aria-hidden="true" />
            {{ t("workspace.sseNoticeRetry") }}
        </button>
        <button
            v-if="onOpenHelp"
            type="button"
            data-testid="sse-notice-help"
            class="shrink-0 text-xs underline underline-offset-2 hover:no-underline"
            @click="onOpenHelp?.()"
        >
            {{ t("workspace.sseNoticeHelp") }}
        </button>
    </div>
</template>
