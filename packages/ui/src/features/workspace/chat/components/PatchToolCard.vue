<script setup lang="ts">
/**
 * PLAN-0688: dedicated card for `apply_patch`.
 *
 * The runtime returns `changed` plus a `diff` string. The diff is projected in
 * a scrollable block and classified only by line prefix (no hunk parser, no
 * line numbers, no green/red colouring).
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../../../../types";
import type { ProcessRowActor } from "./ProcessRow.vue";
import ToolApprovalActions from "./ToolApprovalActions.vue";
import ToolCallVisual from "./toolCallVisual.vue";
import ToolCardError from "./ToolCardError.vue";
import ToolRawOutput from "./ToolRawOutput.vue";

export interface PatchArgView {
    path: string;
    expectedHash: string;
    hunks: unknown[];
}

export interface PatchResultView {
    changed: string[];
    diff: string;
    newHashes?: Record<string, string>;
}

export interface PatchCardView {
    patches: PatchArgView[];
    result: PatchResultView | null;
}

const props = defineProps<{
    toolCall: ToolCall;
    actor?: ProcessRowActor;
    view: PatchCardView;
}>();

const emit = defineEmits<{ approve: [id: string]; reject: [id: string] }>();
const { t } = useI18n();

const summary = computed(() => {
    const firstChanged = props.view.result?.changed[0];
    if (firstChanged) {
        return `${t("chat.toolCard.changedFiles", { count: props.view.result!.changed.length })} · ${firstChanged}`;
    }
    const firstPatch = props.view.patches[0]?.path;
    if (firstPatch) {
        return `${t("chat.toolCard.patchesPending", { count: props.view.patches.length })} · ${firstPatch}`;
    }
    return "";
});

const diffLines = computed(() => (props.view.result?.diff ?? "").split("\n"));
const rawResult = computed(() =>
    typeof props.toolCall.result === "string" ? props.toolCall.result : null,
);

function diffLineClass(line: string): string {
    if (line.startsWith("--- a/") || line.startsWith("+++ b/")) return "text-muted-foreground";
    if (line.startsWith("[diff truncated]")) return "text-muted-foreground";
    if (line.startsWith("+") && !line.startsWith("+++")) return "bg-muted/20";
    return "";
}
</script>

<template>
    <ToolCallVisual card="patch" :tool-call="toolCall" :summary="summary" :actor="actor">
        <div class="space-y-2">
            <ToolCardError v-if="toolCall.error" :error="toolCall.error" testid="patch-error" />

            <div v-if="view.result" class="space-y-1.5" data-testid="patch-result">
                <div class="font-mono text-muted-foreground">
                    <div class="mb-1 font-medium text-foreground">
                        {{ t("chat.toolCard.changedFiles", { count: view.result.changed.length }) }}
                    </div>
                    <ul v-if="view.result.changed.length" class="space-y-0.5">
                        <li
                            v-for="path in view.result.changed"
                            :key="path"
                            class="break-all"
                            data-testid="patch-changed-file"
                        >
                            {{ path }}
                        </li>
                    </ul>
                    <p v-else>{{ t("chat.toolCard.noOutput") }}</p>
                </div>

                <div class="font-mono text-muted-foreground">
                    <div class="mb-1 font-medium text-foreground">
                        {{ t("chat.toolCard.diffPreview") }}
                    </div>
                    <div
                        class="max-h-80 overflow-auto rounded bg-muted/30 p-2 whitespace-pre-wrap break-all"
                        data-testid="patch-diff"
                    >
                        <div
                            v-for="(line, index) in diffLines"
                            :key="index"
                            :class="diffLineClass(line)"
                        >
                            {{ line || " " }}
                        </div>
                    </div>
                    <p class="mt-1">{{ t("chat.toolCard.diffNote") }}</p>
                </div>
            </div>

            <div
                v-else-if="view.patches.length"
                class="font-mono text-muted-foreground"
                data-testid="patch-pending"
            >
                <div class="mb-1 font-medium text-foreground">
                    {{ t("chat.toolCard.patchesPending", { count: view.patches.length }) }}
                </div>
                <ul class="space-y-0.5">
                    <li
                        v-for="patch in view.patches"
                        :key="patch.path"
                        class="break-all"
                        data-testid="patch-pending-file"
                    >
                        {{ patch.path }}
                    </li>
                </ul>
            </div>

            <ToolRawOutput
                :arguments-text="toolCall.arguments"
                :result-text="rawResult"
                :show-result="Boolean(rawResult)"
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
