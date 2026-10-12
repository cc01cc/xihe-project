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
    error = ref("");

const taskLabel = computed(
    () => props.task?.prompt?.slice(0, 60) || props.task?.cronExpr || props.task?.id || "",
);

watch(
    () => props.open,
    (open) => {
        at.value = "";
        error.value = "";
        submitting.value = false;
        if (!open) return;
        // 默认建议 1 小时后，datetime-local 需要 YYYY-MM-DDTHH:mm 墙钟格式。
        const suggestion = new Date(Date.now() + 3_600_000);
        const pad = (n: number) => String(n).padStart(2, "0");
        at.value = `${suggestion.getFullYear()}-${pad(suggestion.getMonth() + 1)}-${pad(suggestion.getDate())}T${pad(suggestion.getHours())}:${pad(suggestion.getMinutes())}`;
    },
    { immediate: true },
);

function validate(): string {
    const iso = localInputToUtcIso(at.value);
    if (!iso) return t("workspace.scheduledTasks.postponeInvalidFuture");
    const instant = new Date(iso);
    if (instant.getTime() <= Date.now()) return t("workspace.scheduledTasks.postponeInvalidFuture");
    const expiresAt = props.task?.expiresAt;
    if (expiresAt && instant.getTime() > new Date(expiresAt).getTime()) {
        return t("workspace.scheduledTasks.postponeExceedsTtl");
    }
    return "";
}

async function handleSubmit() {
    const task = props.task;
    if (submitting.value || !task || !props.workspaceId) return;
    error.value = "";
    const validation = validate();
    if (validation) {
        error.value = validation;
        return;
    }
    submitting.value = true;
    try {
        await store.postponeTask(props.workspaceId, task, localInputToUtcIso(at.value)!);
        toast.success(t("workspace.scheduledTasks.postponeDone"));
        emit("postponed");
        emit("close");
    } catch (cause) {
        logger.warn("Postpone scheduled task failed", cause);
        error.value = scheduledTaskErrorText(t, cause);
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
            <DialogHeader>
                <DialogTitle>{{ t("workspace.scheduledTasks.postponeTitle") }}</DialogTitle>
                <DialogDescription>
                    {{ t("workspace.scheduledTasks.postponeDescription") }}
                    <span class="font-medium text-foreground">{{ taskLabel }}</span>
                </DialogDescription>
            </DialogHeader>

            <div class="grid gap-2 py-2">
                <label class="text-sm font-medium" for="st-postpone-at">
                    {{ t("workspace.scheduledTasks.postponeTimeLabel") }}
                </label>
                <Input
                    id="st-postpone-at"
                    v-model="at"
                    type="datetime-local"
                    data-testid="st-postpone-at"
                />
                <p class="text-xs text-muted-foreground">
                    {{ t("workspace.scheduledTasks.postponeHint") }}
                </p>
                <p
                    v-if="error"
                    class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                    data-testid="st-postpone-error"
                >
                    {{ error }}
                </p>
            </div>

            <DialogFooter>
                <Button variant="outline" @click="emit('close')">{{ t("common.cancel") }}</Button>
                <Button
                    :disabled="submitting"
                    data-testid="st-postpone-submit"
                    @click="() => void handleSubmit()"
                >
                    <LoaderCircle
                        v-if="submitting"
                        class="mr-1 inline-block size-3 animate-spin"
                        aria-hidden="true"
                    />
                    {{ t("workspace.scheduledTasks.postponeSubmit") }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
