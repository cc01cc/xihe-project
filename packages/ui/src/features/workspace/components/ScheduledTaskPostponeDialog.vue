<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { scheduledTaskErrorText, useScheduledTasksStore } from "../stores/scheduledTasks";
import { logger } from "../../../lib/logger";
import Dialog from "../../../components/ui/dialog/Dialog.vue";
import DialogContent from "../../../components/ui/dialog/DialogContent.vue";
import DialogHeader from "../../../components/ui/dialog/DialogHeader.vue";
import DialogTitle from "../../../components/ui/dialog/DialogTitle.vue";
import DialogDescription from "../../../components/ui/dialog/DialogDescription.vue";
import DialogFooter from "../../../components/ui/dialog/DialogFooter.vue";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
    FieldControl,
    FieldDescription,
    FieldError,
    FieldLabel,
    FieldRoot,
    FormRoot,
} from "reka-ui";
import { LoaderCircle } from "@lucide/vue";
import type { ScheduledTask } from "../../../types";

const props = withDefaults(
    defineProps<{
        open: boolean;
        workspaceId: string;
        task: ScheduledTask | null;
    }>(),
    { open: false, task: null },
);

const emit = defineEmits<{
    close: [];
    postponed: [];
}>();

const { t } = useI18n(),
    store = useScheduledTasksStore();

/** datetime-local 值（本地时区墙钟）→ ISO-8601 UTC。 */
function localInputToUtcIso(value: string): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
}

const at = ref(""),
    submitting = ref(false),
    /**
     * PLAN-0753 M2: server-side error keyed by the field name. `FormRoot` hands it to
     * `FieldError` until the user edits that field — the same contract reka documents
     * for server errors, so no hand-rolled error paragraph survives.
     */
    serverErrors = ref<Record<string, string | string[]>>({});

const taskLabel = computed(
    () => props.task?.prompt?.slice(0, 60) || props.task?.cronExpr || props.task?.id || "",
);

watch(
    () => props.open,
    (open) => {
        at.value = "";
        serverErrors.value = {};
        submitting.value = false;
        if (!open) return;
        // 默认建议 1 小时后，datetime-local 需要 YYYY-MM-DDTHH:mm 墙钟格式。
        const suggestion = new Date(Date.now() + 3_600_000);
        const pad = (n: number) => String(n).padStart(2, "0");
        at.value = `${suggestion.getFullYear()}-${pad(suggestion.getMonth() + 1)}-${pad(suggestion.getDate())}T${pad(suggestion.getHours())}:${pad(suggestion.getMinutes())}`;
    },
    { immediate: true },
);

/**
 * PLAN-0753 M2: field-level rule fed to reka `FieldRoot`. Returns `null` when
 * valid, or the message `FieldError` renders. Keeping it a pure function of the
 * value (no `t()` inside the render path) is what lets the rule be unit-tested
 * without mounting i18n — the message key is resolved here, once.
 *
 * `FieldValidateFn` hands us `unknown` (the control may be a non-text widget), so the
 * string narrowing lives here rather than at every call site.
 */
function validateAt(value: unknown): string | null {
    const raw = typeof value === "string" ? value : "";
    const iso = localInputToUtcIso(raw);
    if (!iso || new Date(iso).getTime() <= Date.now()) {
        return t("workspace.scheduledTasks.postponeInvalidFuture");
    }
    const expiresAt = props.task?.expiresAt;
    if (expiresAt && new Date(iso).getTime() > new Date(expiresAt).getTime()) {
        return t("workspace.scheduledTasks.postponeExceedsTtl");
    }
    return null;
}

async function handleSubmit() {
    const task = props.task;
    if (submitting.value || !task || !props.workspaceId) return;
    // reka `FormRoot` runs every field's `validate` before `formSubmit`; reaching
    // here means the field passed, so the only remaining failure mode is the API.
    serverErrors.value = {};
    submitting.value = true;
    try {
        await store.postponeTask(props.workspaceId, task, localInputToUtcIso(at.value)!);
        toast.success(t("workspace.scheduledTasks.postponeDone"));
        emit("postponed");
        emit("close");
    } catch (cause) {
        logger.warn("Postpone scheduled task failed", cause);
        // Server errors stay keyed by field name — reka clears the entry when the
        // user edits that field, which is the behaviour the old paragraph hand-rolled.
        serverErrors.value = { at: scheduledTaskErrorText(t, cause) };
    } finally {
        submitting.value = false;
    }
}

function handleOpenChange(open: boolean) {
    if (!open) emit("close");
}
</script>

<template>
    <Dialog :open="open" @update:open="handleOpenChange">
        <DialogContent data-testid="scheduled-task-postpone-dialog">
            <FormRoot :errors="serverErrors" @form-submit="handleSubmit">
                <DialogHeader>
                    <DialogTitle>{{ t("workspace.scheduledTasks.postponeTitle") }}</DialogTitle>
                    <DialogDescription>
                        {{ t("workspace.scheduledTasks.postponeDescription") }}
                        <span class="font-medium text-foreground">{{ taskLabel }}</span>
                    </DialogDescription>
                </DialogHeader>

                <div class="grid gap-2 py-2">
                    <FieldRoot name="at" class="grid gap-2" :validate="validateAt" required>
                        <FieldLabel class="text-sm font-medium">
                            {{ t("workspace.scheduledTasks.postponeTimeLabel") }}
                        </FieldLabel>
                        <FieldControl as-child>
                            <Input
                                v-model="at"
                                type="datetime-local"
                                data-testid="st-postpone-at"
                            />
                        </FieldControl>
                        <FieldDescription class="text-xs text-muted-foreground">
                            {{ t("workspace.scheduledTasks.postponeHint") }}
                        </FieldDescription>
                        <FieldError
                            class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                            data-testid="st-postpone-error"
                        />
                    </FieldRoot>
                </div>

                <DialogFooter>
                    <Button type="button" variant="outline" @click="emit('close')">{{
                        t("common.cancel")
                    }}</Button>
                    <Button type="submit" :disabled="submitting" data-testid="st-postpone-submit">
                        <LoaderCircle
                            v-if="submitting"
                            class="mr-1 inline-block size-3 animate-spin"
                            aria-hidden="true"
                        />
                        {{ t("workspace.scheduledTasks.postponeSubmit") }}
                    </Button>
                </DialogFooter>
            </FormRoot>
        </DialogContent>
    </Dialog>
</template>
