<script setup lang="ts">
/**
 * task-993: dedicated card for the four native browser tools.
 *
 * The Runtime already bounds the snapshot text (8 000 chars) and inlines only a small
 * JPEG preview for screenshots; this card does not re-truncate or re-encode anything.
 * Page text is untrusted input — the card shows it verbatim and never treats it as UI copy.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../../../../types";
import type { ProcessRowActor } from "./ProcessRow.vue";
import ProcessRow from "./ProcessRow.vue";
import ToolApprovalActions from "./ToolApprovalActions.vue";
import ToolCardError from "./ToolCardError.vue";
import ToolRawOutput from "./ToolRawOutput.vue";
import { formatToolDuration, toolStatusIcon, toolStatusTone } from "./toolCallStatus";

export type BrowserViewKind = "navigate" | "snapshot" | "click" | "screenshot";

export interface BrowserCardView {
    kind: BrowserViewKind;
    url: string;
    title: string;
    target: string;
    text: string;
    truncated: boolean;
    refs: number | null;
    previewDataUrl: string;
    artifactPath: string;
    bytes: number | null;
}

const props = defineProps<{
    toolCall: ToolCall;
    actor?: ProcessRowActor;
    view: BrowserCardView;
}>();

const emit = defineEmits<{ approve: [id: string]; reject: [id: string] }>();
const { t } = useI18n();

const statusIcon = computed(() => toolStatusIcon(props.toolCall.status));
const statusTone = computed(() => toolStatusTone(props.toolCall.status));
const statusLabel = computed(() => t(`chat.toolStatus.${props.toolCall.status}`));
const duration = computed(() =>
    formatToolDuration(props.toolCall.startedAt, props.toolCall.completedAt),
);
const summary = computed(() => {
    const view = props.view;
    if (view.kind === "navigate" || view.kind === "snapshot") {
        return view.title ? `${view.url} — ${view.title}` : view.url;
    }
    if (view.kind === "click") return view.target;
    return view.artifactPath;
});
const rawResult = computed(() =>
    typeof props.toolCall.result === "string" ? props.toolCall.result : null,
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
        data-tool-card="browser"
    >
        <div class="space-y-2">
            <ToolCardError v-if="toolCall.error" :error="toolCall.error" testid="browser-error" />

            <div
                v-if="view.url"
                class="flex flex-wrap gap-x-3 gap-y-1 font-mono text-muted-foreground"
                data-testid="browser-meta"
            >
                <span class="break-all">{{ view.url }}</span>
                <span v-if="view.refs !== null">refs: {{ view.refs }}</span>
            </div>

            <div
                v-if="view.kind === 'snapshot' && view.text"
                class="font-mono text-muted-foreground"
            >
                <pre
                    class="max-h-80 overflow-auto rounded bg-muted/30 p-2 whitespace-pre-wrap break-all"
                    data-testid="browser-snapshot-text"
                    >{{ view.text }}</pre>
                <p v-if="view.truncated" class="mt-1">
                    {{ t("chat.toolCard.truncated") }} ·
                    {{ t("chat.toolCard.previewOnly") }}
                </p>
            </div>

            <div v-if="view.kind === 'screenshot'" class="space-y-1" data-testid="browser-shot">
                <img
                    v-if="view.previewDataUrl"
                    :src="view.previewDataUrl"
                    :alt="summary"
                    class="max-h-72 rounded border"
                />
                <p class="break-all font-mono text-muted-foreground">{{ view.artifactPath }}</p>
                <p v-if="view.bytes !== null" class="tabular-nums text-muted-foreground">
                    {{ view.bytes }} bytes
                </p>
            </div>

            <div
                v-else-if="view.kind !== 'snapshot' && !toolCall.error"
                class="text-muted-foreground"
            >
                {{ t("chat.toolCard.noOutput") }}
            </div>

            <ToolRawOutput
                :arguments-text="toolCall.arguments"
                :result-text="rawResult"
                :show-result="rawResult !== null"
            />

            <ToolApprovalActions
                v-if="toolCall.status === 'pending'"
                :tool-call-id="toolCall.id"
                @approve="emit('approve', $event)"
                @reject="emit('reject', $event)"
            />
        </div>
    </ProcessRow>
</template>
