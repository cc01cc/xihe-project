<script setup lang="ts">
/**
 * PLAN-0631 M1-C / BL-406：run 终态芯片（`partial` / `cancelled`）。
 *
 * 文案只从 `runStateLabelKey`（D31-01）取，不新增状态名、不新增色值：`partial` 复用仓库既有
 * amber 警告色阶，`cancelled` 用中性 border/muted 表面（区分靠图标 + 文案，从不只靠颜色）。
 *
 * BL-406 把芯片从「只在消息行尾」提成可复用组件：消息行尾（`MessageItem`）与折叠 run 的
 * 摘要壳（`MessageList`）渲染同一份 DOM（同 testid / 同 `data-run-outcome` / 同文案），
 * 所以默认折叠时也能看见终态，而不是展开后才存在。
 *
 * ARIA：`aria-label` + `title`，不用 `role="status"` —— 状态已经发生，live region 会在每次
 * 历史加载时重播。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { CircleAlert, XCircle } from "@lucide/vue";
import { runStateLabelKey, type TerminalMarker } from "../runStateView";

const props = defineProps<{ outcome: TerminalMarker }>();

const { t } = useI18n();

const label = computed(() => {
    const key = runStateLabelKey(props.outcome);
    return key ? t(key) : "";
});
</script>

<template>
    <span
        data-testid="message-terminated"
        :data-run-outcome="outcome"
        class="mt-0.5 flex w-fit items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs leading-none"
        :class="
            outcome === 'partial'
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                : 'border-border bg-muted text-foreground'
        "
        :aria-label="label"
        :title="label"
    >
        <CircleAlert v-if="outcome === 'partial'" class="size-3" aria-hidden="true" />
        <XCircle v-else class="size-3" aria-hidden="true" />
        {{ label }}
    </span>
</template>
