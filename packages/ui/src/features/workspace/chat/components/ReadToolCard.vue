<script setup lang="ts">
/**
 * PLAN-0688: dedicated card for `read_file` / `read_file_range`.
 *
 * `read_file` returns plain text, while `read_file_range` returns a JSON
 * object. The range content already carries `N | ` line prefixes, so this card
 * never adds its own numbering.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../../../../types";
import type { ProcessRowActor } from "./ProcessRow.vue";
import ToolApprovalActions from "./ToolApprovalActions.vue";
import ToolCallVisual from "./toolCallVisual.vue";
import ToolCardError from "./ToolCardError.vue";
import ToolRawOutput from "./ToolRawOutput.vue";
import { useLinePreview } from "./toolCardPreview";

export interface ReadCardView {
    mode: "full" | "range";
    path: string;
    content: string;
    totalLines: number | null;
    isBinary: boolean;
    offset: number | null;
    limit: number | null;
    hasResult: boolean;
}

const props = defineProps<{
    toolCall: ToolCall;
    actor?: ProcessRowActor;
    view: ReadCardView;
}>();

const emit = defineEmits<{ approve: [id: string]; reject: [id: string] }>();
const { t } = useI18n();

const rangeLabel = computed(() => {
    const view = props.view;
    if (
        view.mode !== "range" ||
        !view.hasResult ||
        view.isBinary ||
        !view.totalLines ||
        view.totalLines <= 0
    ) {
        return "";
    }
    const start = Math.max(1, view.offset ?? 1);
    if (start > view.totalLines) return "";
    const limit = view.limit ?? view.totalLines;
    if (limit <= 0) return "";
    const end = Math.min(view.totalLines, start + limit - 1);
    return `L${start}–${end}`;
});

const summary = computed(() => {
    const path = props.view.path;
    return rangeLabel.value ? `${path} · ${rangeLabel.value}` : path;
});

const { preview: contentPreview, truncated: contentTruncated } = useLinePreview(
    computed(() => props.view.content),
);

const previewLineCount = computed(() => {
    const content = props.view.content;
    return content ? content.split("\n").length : 0;
});

const rawResult = computed(() =>
    typeof props.toolCall.result === "string" ? props.toolCall.result : null,
);
</script>

<template>
    <ToolCallVisual card="read" :tool-call="toolCall" :summary="summary" :actor="actor">
        <div class="space-y-2">
            <ToolCardError v-if="toolCall.error" :error="toolCall.error" testid="read-error" />

            <div
                v-if="view.hasResult"
                class="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground"
                data-testid="read-meta"
            >
                <span v-if="view.mode === 'range' && view.totalLines !== null">
                    {{ t("chat.toolCard.totalLines") }}:
                    <span class="tabular-nums">{{ view.totalLines }}</span>
                </span>
                <span v-else-if="!view.isBinary">
                    {{ t("chat.toolCard.previewLines", { count: previewLineCount }) }}
                </span>
                <span v-if="view.isBinary">{{ t("chat.toolCard.binaryPreview") }}</span>
            </div>

            <div v-if="view.isBinary" class="font-mono text-muted-foreground">
                <p>{{ t("chat.toolCard.binaryPreview") }}</p>
                <p class="mt-1 tabular-nums">{{ view.content.length }} base64 chars</p>
            </div>

            <div v-else-if="view.hasResult && view.content" class="font-mono text-muted-foreground">
                <pre
                    class="max-h-80 overflow-auto rounded bg-muted/30 p-2 whitespace-pre-wrap break-all"
                    data-testid="read-content"
                    >{{ contentPreview }}</pre>
                <p v-if="contentTruncated" class="mt-1">
                    {{ t("chat.toolCard.truncated") }} · {{ t("chat.toolCard.previewOnly") }}
                </p>
            </div>

            <div v-else-if="!toolCall.error" class="text-muted-foreground">
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
    </ToolCallVisual>
</template>
