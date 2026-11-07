<script setup lang="ts">
/**
 * PLAN-0688: shared visual shell for the dedicated tool cards.
 *
 * It owns only the ProcessRow presentation (status icon/tone/label, duration,
 * actor, expandable body) so the three cards differ in their data rendering,
 * not in status vocabulary. Data parsing and routing stay in ToolCallHost.vue.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Bot, CheckCircle, Clock, LoaderCircle, XCircle } from "@lucide/vue";
import type { Component } from "vue";
import type { ToolCall } from "../../../../types";
import ProcessRow from "./ProcessRow.vue";
import type { ProcessRowActor } from "./ProcessRow.vue";

const props = defineProps<{
    toolCall: ToolCall;
    summary?: string;
    actor?: ProcessRowActor;
    card: "command" | "patch" | "read";
}>();

const expanded = defineModel<boolean>("expanded", { default: false });
const { t } = useI18n();

const statusIcons: Record<string, Component> = {
    pending: Clock,
    running: LoaderCircle,
    completed: CheckCircle,
    failed: XCircle,
    cancelled: XCircle,
    approved: CheckCircle,
    rejected: XCircle,
};

const statusColors: Record<string, string> = {
    pending: "text-yellow-500",
    running: "text-blue-500",
    completed: "text-green-500",
    failed: "text-red-500",
    cancelled: "text-muted-foreground",
    approved: "text-green-500",
    rejected: "text-red-500",
};

const statusIcon = computed(() => statusIcons[props.toolCall.status] ?? Bot);
const statusTone = computed(() => statusColors[props.toolCall.status] ?? "text-muted-foreground");
const statusLabel = computed(() => t(`chat.toolStatus.${props.toolCall.status}`));

const duration = computed(() => {
    if (!props.toolCall.startedAt || !props.toolCall.completedAt) return null;
    const ms =
        new Date(props.toolCall.completedAt).getTime() -
        new Date(props.toolCall.startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
});
</script>

<template>
    <ProcessRow
        kind="tool"
        :icon="statusIcon"
        :tone="statusTone"
        :label="toolCall.name"
        :summary="summary"
        :meta="duration ?? undefined"
        :status="statusLabel"
        :failed="toolCall.status === 'failed'"
        :actor="actor"
        expandable
        testid="tool-card"
        toggle-testid="tool-card-toggle"
        :data-tool-card="card"
        v-model:expanded="expanded"
    >
        <slot />
    </ProcessRow>
</template>
