<script setup lang="ts">
/**
 * PLAN-0670 M2c / BL-292 —— “本次回答基于被截断的历史”轻提示。
 *
 * 设计约束（Lead 2026-11-05）：
 * - 轻提示（muted 一行），不是弹窗、不是红条；
 * - 每个 run 单独展示（父组件按 runId 传入），多 run 同屏不串；
 * - 可关闭：父组件把关闭状态按 `sessionId:runId` 持久在 store 的内存集合里，
 *   虚拟滚动导致组件重挂载也不会重复弹出（“默认展示一次”）。
 */
import { useI18n } from "vue-i18n";
import type { AgentContextTruncation } from "../composables/useSSE";

const props = defineProps<{
    /** 缺省 = 该 run 未截断（组件渲染空，父组件无需额外 v-if / 非空断言）。 */
    truncation?: AgentContextTruncation;
}>();

const emit = defineEmits<{ dismiss: [] }>();

const { t } = useI18n();
</script>

<template>
    <div
        v-if="props.truncation"
        data-testid="context-truncation-notice"
        role="status"
        class="mt-1 flex items-center gap-2 px-1 text-[11px] text-muted-foreground"
    >
        <span class="min-w-0 truncate">
            {{
                t("chat.contextTruncationNotice", {
                    dropped: props.truncation.droppedMessages,
                    kept: props.truncation.keptMessages,
                })
            }}
        </span>
        <button
            type="button"
            data-testid="context-truncation-dismiss"
            :aria-label="t('chat.contextTruncationDismiss')"
            class="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
            @click="emit('dismiss')"
        >
            ×
        </button>
    </div>
</template>
