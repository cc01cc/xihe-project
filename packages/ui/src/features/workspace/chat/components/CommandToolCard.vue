<script setup lang="ts">
/**
 * PLAN-0688: dedicated card for `execute_command`.
 *
 * The host has already validated the argument/result shape, so this component
 * only projects the parsed view. Command output is split into stdout/stderr
 * blocks; the two streams are never merged.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../../../../types";
import type { ProcessRowActor } from "./ProcessRow.vue";
import ToolApprovalActions from "./ToolApprovalActions.vue";
import ToolCallVisual from "./toolCallVisual.vue";
import ToolCardError from "./ToolCardError.vue";
import ToolRawOutput from "./ToolRawOutput.vue";
import { useCharPreview } from "./toolCardPreview";

export interface CommandResultView {
    stdout: string;
    stderr: string;
    exit_code: number;
    success: boolean;
    artifact_id?: string;
    stdout_truncated?: boolean;
    stderr_truncated?: boolean;
}

export interface CommandCardView {
    command: string;
    args: string[];
    result: CommandResultView | null;
}

const props = defineProps<{
    toolCall: ToolCall;
    actor?: ProcessRowActor;
    view: CommandCardView;
}>();

const emit = defineEmits<{ approve: [id: string]; reject: [id: string] }>();
const { t } = useI18n();

const summary = computed(() => {
    const firstLine = props.view.command.trim().split("\n")[0]?.slice(0, 60) ?? "";
    return firstLine || props.view.args.join(" ");
});

const stdout = computed(() => props.view.result?.stdout ?? "");
const stderr = computed(() => props.view.result?.stderr ?? "");
const { preview: stdoutPreview, truncated: stdoutTextTruncated } = useCharPreview(stdout);
const { preview: stderrPreview, truncated: stderrTextTruncated } = useCharPreview(stderr);
const stdoutTruncated = computed(
    () => Boolean(props.view.result?.stdout_truncated) || stdoutTextTruncated.value,
);
const stderrTruncated = computed(
    () => Boolean(props.view.result?.stderr_truncated) || stderrTextTruncated.value,
);
const rawResult = computed(() =>
    typeof props.toolCall.result === "string" ? props.toolCall.result : null,
);
</script>

<template>
    <ToolCallVisual card="command" :tool-call="toolCall" :summary="summary" :actor="actor">
        <div class="space-y-2">
            <ToolCardError v-if="toolCall.error" :error="toolCall.error" testid="command-error" />

            <div v-if="view.result" class="space-y-1.5" data-testid="command-result">
                <div class="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                    <span>
                        {{ t("chat.toolCard.exitCode") }}:
                        <span
                            class="tabular-nums"
                            :class="view.result.exit_code === 0 ? '' : 'text-destructive'"
                            >{{ view.result.exit_code }}</span
                        >
                    </span>
                    <span :class="view.result.success ? 'text-green-500' : 'text-destructive'">{{
                        view.result.success
                            ? t("chat.toolCard.success")
                            : t("chat.toolCard.failure")
                    }}</span>
                    <span
                        v-if="view.result.artifact_id"
                        class="max-w-full truncate"
                        :title="view.result.artifact_id"
                        >{{ t("chat.toolCard.artifactRetained") }}:
                        {{ view.result.artifact_id }}</span
                    >
                </div>

                <div v-if="stdout || !stderr" class="font-mono text-muted-foreground">
                    <div class="mb-1 font-medium text-foreground">
                        {{ t("chat.toolCard.stdout") }}
                    </div>
                    <pre
                        class="rounded bg-muted/30 p-2 whitespace-pre-wrap break-all"
                        data-testid="command-stdout"
                        >{{ stdoutPreview || t("chat.toolCard.noOutput") }}</pre>
                    <p v-if="stdoutTruncated" class="mt-1 text-muted-foreground">
                        {{ t("chat.toolCard.truncated") }}
                    </p>
                </div>

                <div v-if="stderr" class="font-mono text-muted-foreground">
                    <div class="mb-1 font-medium text-foreground">
                        {{ t("chat.toolCard.stderr") }}
                    </div>
                    <pre
                        class="rounded bg-muted/30 p-2 whitespace-pre-wrap break-all"
                        data-testid="command-stderr"
                        >{{ stderrPreview }}</pre>
                    <p v-if="stderrTruncated" class="mt-1 text-muted-foreground">
                        {{ t("chat.toolCard.truncated") }}
                    </p>
                </div>
            </div>

            <div v-else-if="!toolCall.error" class="text-muted-foreground">
                {{ t("chat.toolCard.noOutput") }}
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
