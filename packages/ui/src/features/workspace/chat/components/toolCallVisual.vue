<script setup lang="ts">
/**
 * PLAN-0688: shared visual shell for the dedicated tool cards.
 *
 * It owns the ProcessRow presentation (status icon/tone/label, duration, actor,
 * expandable body) and the expansion state, so the three cards differ in their
 * data rendering, not in status vocabulary. Status/duration mapping comes from
 * `toolCallStatus.ts`; data parsing and routing stay in ToolCallHost.vue.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../../../../types";
import ProcessRow from "./ProcessRow.vue";
import type { ProcessRowActor } from "./ProcessRow.vue";
import { formatToolDuration, toolStatusIcon, toolStatusTone } from "./toolCallStatus";

const props = defineProps<{
    toolCall: ToolCall;
    summary?: string;
    actor?: ProcessRowActor;
    card: "command" | "patch" | "read";
}>();

const expanded = defineModel<boolean>("expanded", { default: false });
const { t } = useI18n();

const statusIcon = computed(() => toolStatusIcon(props.toolCall.status));
const statusTone = computed(() => toolStatusTone(props.toolCall.status));
const statusLabel = computed(() => t(`chat.toolStatus.${props.toolCall.status}`));

const duration = computed(() =>
    formatToolDuration(props.toolCall.startedAt, props.toolCall.completedAt),
);
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
