<script lang="ts" setup>
/**
 * BL-335 · SSE 订阅上限横幅。
 *
 * 触发条件：工作区事件流 `429 WORKSPACE_EVENT_SUBSCRIBERS_LIMIT` 或用户通道 `429 USER_CHANNEL_FULL`
 * （见 `composables/sseSubscriberLimit.ts`）。语义是**持续态**：这条横幅一直留着，直到对应通道
 * 重连成功（`useWorkspaceSSE` 的 open 成功 / 用户通道重连）才撤掉；不做成 4 秒 toast。
 *
 * 无障碍：`role="status"`（读屏会在不抢焦点的情况下播报），文案给"已停止刷新 + 怎么恢复"两段，
 * 不给错误码——错误码只进 logger 与 `data-reason`（诊断用）。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { TriangleAlertIcon } from "@lucide/vue";
import { useSseSubscriberLimit } from "../composables/sseSubscriberLimit";

const { t } = useI18n();
const { isActive, codes } = useSseSubscriberLimit();
const reason = computed(() => [...codes.value].join(","));
</script>

<template>
    <div
        v-if="isActive"
        data-testid="sse-subscriber-limit-notice"
        :data-reason="reason"
        role="status"
        aria-live="polite"
        class="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
        <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p class="min-w-0">
            <span class="font-medium">{{ t("workspace.sseSubscriberLimitTitle") }}</span>
            <span class="ml-1">{{ t("workspace.sseSubscriberLimitHint") }}</span>
        </p>
    </div>
</template>
