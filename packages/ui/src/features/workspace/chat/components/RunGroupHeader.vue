<script setup lang="ts">
/**
 * PLAN-0659 T1.1：session 线程里的 **run 头**（单行）。
 *
 * 一条 run 头 + 其下缩进的该 run 内容（缩进由 `MessageList` 的容器负责）。失败/取消的 run
 * 由 `MessageList` 默认折叠到"只剩这行"，用户不必重看失败过程。
 *
 * 刻意保持中性：只有 failed/cancelled 才染红（注意力预算：danger 只染危险元素）；其余状态
 * 用 muted 文字。`runShortCode` 仅展示，身份一律用 `data-run-id` 全文（见 `runView.ts`）。
 */
import { computed } from "vue";
import { ChevronRight } from "@lucide/vue";
import { runStateLabelKey, runStateTier } from "../runStateView";
import { formatRunDuration, runShortCode } from "../runView";
import { useI18n } from "vue-i18n";

const props = defineProps<{
    runId: string;
    /** wire 状态（`ChatRunResponse["status"] | "interrupted" | undefined`）。 */
    status?: string | null;
    terminalOutcome?: string | null;
    createdAt?: string | null;
    terminalAt?: string | null;
    principalName?: string;
    collapsed: boolean;
}>();

defineEmits<{ toggle: [] }>();

const { t } = useI18n();

const shortCode = computed(() => runShortCode(props.runId));
const duration = computed(() => formatRunDuration(props.createdAt, props.terminalAt));
const failed = computed(
    () =>
        props.status === "failed" ||
        props.status === "cancelled" ||
        props.terminalOutcome === "error" ||
        props.terminalOutcome === "cancelled",
);
const statusLabel = computed(() => {
    const key = props.status ? runStateLabelKey(props.status) : null;
    if (key) return t(key);
    return props.status ?? "";
});
const tier = computed(() => runStateTier(props.status ?? undefined));
</script>

<template>
    <div
        class="mt-2 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
        data-testid="run-header"
        :data-run-id="runId"
        :data-run-status="status ?? undefined"
        :data-run-tier="tier ?? undefined"
        :data-failed="failed ? 'true' : undefined"
    >
        <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-foreground"
            :aria-expanded="!collapsed"
            :aria-label="t('chat.runHeader.toggle', { run: shortCode })"
            data-testid="run-header-toggle"
            @click="$emit('toggle')"
        >
            <ChevronRight
                class="size-3 shrink-0 transition-transform"
                :class="collapsed ? '' : 'rotate-90'"
                aria-hidden="true"
            />
            <span class="shrink-0 font-mono" data-testid="run-header-run-id"
                >run-{{ shortCode }}</span
            >
            <span
                v-if="principalName"
                class="min-w-0 truncate text-foreground/80"
                data-testid="run-header-principal"
                >{{ principalName }}</span
            >
            <span class="ml-auto flex shrink-0 items-center gap-2">
                <span v-if="duration" class="tabular-nums" data-testid="run-header-duration">{{
                    duration
                }}</span>
                <span
                    v-if="statusLabel"
                    class="shrink-0"
                    :class="failed ? 'text-destructive' : ''"
                    data-testid="run-header-status"
                    >{{ statusLabel }}</span
                >
            </span>
        </button>
    </div>
</template>
