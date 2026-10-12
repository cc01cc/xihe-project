<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { ApiError } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { useSessionStore } from "../../../stores/session";
import { scheduledTaskErrorText, useScheduledTasksStore } from "../stores/scheduledTasks";
import Dialog from "../../../components/ui/dialog/Dialog.vue";
import DialogContent from "../../../components/ui/dialog/DialogContent.vue";
import DialogHeader from "../../../components/ui/dialog/DialogHeader.vue";
import DialogTitle from "../../../components/ui/dialog/DialogTitle.vue";
import DialogDescription from "../../../components/ui/dialog/DialogDescription.vue";
import DialogFooter from "../../../components/ui/dialog/DialogFooter.vue";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { LoaderCircle } from "@lucide/vue";
import type { ScheduledTaskCreateRequest, ScheduledTaskTargetKind } from "../../../types";

const props = withDefaults(
    defineProps<{
        open: boolean;
        workspaceId: string;
    }>(),
    { open: false },
);

const emit = defineEmits<{
    close: [];
    created: [];
}>();

const { t } = useI18n(),
    store = useScheduledTasksStore(),
    sessionStore = useSessionStore();

type TriggerMode = "cron" | "delay";
type DelayUnit = "minutes" | "hours" | "days";

const mode = ref<TriggerMode>("cron"),
    cronExpr = ref(""),
    timezone = ref(""),
    delayAmount = ref(5),
    delayUnit = ref<DelayUnit>("minutes"),
    targetKind = ref<ScheduledTaskTargetKind>("session_wakeup"),
    targetSessionId = ref(""),
    prompt = ref(""),
    command = ref(""),
    argsText = ref(""),
    cwd = ref(""),
    submitting = ref(false),
    fieldError = ref(""),
    formError = ref("");

const DELAY_UNIT_MS: Record<DelayUnit, number> = {
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000,
};

const TTL_MS = 7 * 86_400_000;

const sessions = computed(() =>
    sessionStore.sessions.filter(
        (session) => !session.workspaceId || session.workspaceId === props.workspaceId,
    ),
);

watch(
    () => props.open,
    (open) => {
        if (!open) return;
        mode.value = "cron";
        cronExpr.value = "";
        timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        delayAmount.value = 5;
        delayUnit.value = "minutes";
        targetKind.value = "session_wakeup";
        targetSessionId.value = sessionStore.currentSessionId ?? "";
        prompt.value = "";
        command.value = "";
        argsText.value = "";
        cwd.value = "";
        fieldError.value = "";
        formError.value = "";
        if (sessionStore.sessions.length === 0) {
            void sessionStore.loadSessions().catch((cause: unknown) => {
                logger.warn("Failed to load sessions for scheduled task create", cause);
            });
        }
    },
    // 挂载时可能已经 open（路由直达或父组件直接传 true），初始化必须立即执行。
    { immediate: true },
);

function validate(): string {
    if (mode.value === "cron") {
        if (!cronExpr.value.trim()) return t("workspace.scheduledTasks.cronRequired");
        if (cronExpr.value.trim().split(/\s+/).length !== 5) {
            return t("workspace.scheduledTasks.errInvalidCronExpr");
        }
        if (!timezone.value.trim()) return t("workspace.scheduledTasks.timezoneRequired");
    } else {
        if (!Number.isFinite(delayAmount.value) || delayAmount.value <= 0) {
            return t("workspace.scheduledTasks.delayAmountInvalid");
        }
        if (delayAmount.value * DELAY_UNIT_MS[delayUnit.value] > TTL_MS) {
            return t("workspace.scheduledTasks.delayExceedsTtl");
        }
    }
    if (targetKind.value === "session_wakeup") {
        if (!targetSessionId.value) return t("workspace.scheduledTasks.sessionRequired");
        if (!prompt.value.trim()) return t("workspace.scheduledTasks.promptRequired");
    } else if (!command.value.trim()) {
        return t("workspace.scheduledTasks.commandRequired");
    }
    return "";
}

function buildRequest(): ScheduledTaskCreateRequest {
    const base: ScheduledTaskCreateRequest =
        mode.value === "cron"
            ? {
                  triggerKind: "cron",
                  cronExpr: cronExpr.value.trim(),
                  timezone: timezone.value.trim(),
                  targetKind: targetKind.value,
              }
            : {
                  triggerKind: "delay_once",
                  timezone: timezone.value.trim() || "UTC",
                  targetKind: targetKind.value,
                  at: new Date(
                      Date.now() + delayAmount.value * DELAY_UNIT_MS[delayUnit.value],
                  ).toISOString(),
              };
    if (targetKind.value === "session_wakeup") {
        base.targetSessionId = targetSessionId.value;
        base.prompt = prompt.value;
    } else {
        const args = argsText.value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        base.payload = {
            command: command.value.trim(),
            ...(args.length > 0 ? { args } : {}),
            ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
        };
    }
    return base;
}

async function handleSubmit() {
    if (submitting.value || !props.workspaceId) return;
    fieldError.value = "";
    formError.value = "";
    const validation = validate();
    if (validation) {
        fieldError.value = validation;
        return;
    }
    submitting.value = true;
    try {
        await store.createTask(props.workspaceId, buildRequest());
        toast.success(t("workspace.scheduledTasks.created"));
        emit("created");
        emit("close");
    } catch (cause) {
        logger.warn("Create scheduled task failed", cause);
        const code = cause instanceof ApiError ? cause.problem.code : null;
        const text = scheduledTaskErrorText(t, cause);
        if (code === "INVALID_CRON_EXPR" || code === "INVALID_TIMEZONE") fieldError.value = text;
        else formError.value = text;
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
        <DialogContent
            class="max-h-[85vh] overflow-y-auto sm:max-w-lg"
            data-testid="scheduled-task-create-dialog"
        >
            <DialogHeader>
                <DialogTitle>{{ t("workspace.scheduledTasks.createTitle") }}</DialogTitle>
                <DialogDescription>
                    {{ t("workspace.scheduledTasks.createSubtitle") }}
                </DialogDescription>
            </DialogHeader>

            <div class="grid gap-4 py-2">
                <div class="flex gap-1 rounded-md border p-1" data-testid="st-create-mode">
                    <button
                        type="button"
                        class="flex-1 rounded px-3 py-1.5 text-sm"
                        :class="
                            mode === 'cron'
                                ? 'bg-accent font-medium'
                                : 'text-muted-foreground hover:bg-accent/50'
                        "
                        data-testid="st-create-mode-cron"
                        @click="mode = 'cron'"
                    >
                        {{ t("workspace.scheduledTasks.modeCron") }}
                    </button>
                    <button
                        type="button"
                        class="flex-1 rounded px-3 py-1.5 text-sm"
                        :class="
                            mode === 'delay'
                                ? 'bg-accent font-medium'
                                : 'text-muted-foreground hover:bg-accent/50'
                        "
                        data-testid="st-create-mode-delay"
                        @click="mode = 'delay'"
                    >
                        {{ t("workspace.scheduledTasks.modeDelay") }}
                    </button>
                </div>

                <template v-if="mode === 'cron'">
                    <div class="grid gap-2">
                        <label class="text-sm font-medium" for="st-cron-expr">
                            {{ t("workspace.scheduledTasks.cronLabel") }}
                        </label>
                        <Input
                            id="st-cron-expr"
                            v-model="cronExpr"
                            data-testid="st-create-cron-expr"
                            placeholder="0 9 * * *"
                        />
                        <p class="text-xs text-muted-foreground">
                            {{ t("workspace.scheduledTasks.cronHint") }}
                        </p>
                    </div>
                    <div class="grid gap-2">
                        <label class="text-sm font-medium" for="st-timezone">
                            {{ t("workspace.scheduledTasks.timezoneLabel") }}
                        </label>
                        <Input
                            id="st-timezone"
                            v-model="timezone"
                            data-testid="st-create-timezone"
                        />
                        <p class="text-xs text-muted-foreground">
                            {{ t("workspace.scheduledTasks.timezoneHint") }}
                        </p>
                    </div>
                </template>

                <template v-else>
                    <div class="grid gap-2">
                        <label class="text-sm font-medium" for="st-delay-amount">
                            {{ t("workspace.scheduledTasks.delayAmountLabel") }}
                        </label>
                        <div class="flex gap-2">
                            <Input
                                id="st-delay-amount"
                                v-model.number="delayAmount"
                                type="number"
                                min="1"
                                class="w-28"
                                data-testid="st-create-delay-amount"
                            />
                            <select
                                v-model="delayUnit"
                                class="rounded-md border border-input bg-background px-3 py-2 text-sm"
                                data-testid="st-create-delay-unit"
                            >
                                <option value="minutes">
                                    {{ t("workspace.scheduledTasks.delayUnitMinutes") }}
                                </option>
                                <option value="hours">
                                    {{ t("workspace.scheduledTasks.delayUnitHours") }}
                                </option>
                                <option value="days">
                                    {{ t("workspace.scheduledTasks.delayUnitDays") }}
                                </option>
                            </select>
                        </div>
                        <p class="text-xs text-muted-foreground">
                            {{ t("workspace.scheduledTasks.delayHint") }}
                        </p>
                    </div>
                </template>

                <div class="grid gap-2">
                    <label class="text-sm font-medium" for="st-target-kind">
                        {{ t("workspace.scheduledTasks.targetLabel") }}
                    </label>
                    <select
                        id="st-target-kind"
                        v-model="targetKind"
                        class="rounded-md border border-input bg-background px-3 py-2 text-sm"
                        data-testid="st-create-target-kind"
                    >
                        <option value="session_wakeup">
                            {{ t("workspace.scheduledTasks.targetSessionOption") }}
                        </option>
                        <option value="job_dispatch">
                            {{ t("workspace.scheduledTasks.targetJobOption") }}
                        </option>
                    </select>
                </div>

                <template v-if="targetKind === 'session_wakeup'">
                    <div class="grid gap-2">
                        <label class="text-sm font-medium" for="st-session">
                            {{ t("workspace.scheduledTasks.sessionSelectLabel") }}
                        </label>
                        <select
                            id="st-session"
                            v-model="targetSessionId"
                            class="rounded-md border border-input bg-background px-3 py-2 text-sm"
                            data-testid="st-create-session"
                        >
                            <option value="" disabled>
                                {{ t("workspace.scheduledTasks.sessionPlaceholder") }}
                            </option>
                            <option
                                v-for="session in sessions"
                                :key="session.id"
                                :value="session.id"
                            >
                                {{ session.title }}
                            </option>
                        </select>
                        <p
                            v-if="sessions.length === 0"
                            class="text-xs text-muted-foreground"
                            data-testid="st-create-session-empty"
                        >
                            {{ t("workspace.scheduledTasks.sessionEmpty") }}
                        </p>
                    </div>
                    <div class="grid gap-2">
                        <label class="text-sm font-medium" for="st-prompt">
                            {{ t("workspace.scheduledTasks.promptLabel") }}
                        </label>
                        <Textarea
                            id="st-prompt"
                            v-model="prompt"
                            rows="3"
                            data-testid="st-create-prompt"
                            :placeholder="t('workspace.scheduledTasks.promptPlaceholder')"
                        />
                    </div>
                </template>

                <template v-else>
                    <div class="grid gap-2">
                        <label class="text-sm font-medium" for="st-command">
                            {{ t("workspace.scheduledTasks.commandLabel") }}
                        </label>
                        <Input
                            id="st-command"
                            v-model="command"
                            data-testid="st-create-command"
                            :placeholder="t('workspace.scheduledTasks.commandPlaceholder')"
                        />
                    </div>
                    <div class="grid gap-2">
                        <label class="text-sm font-medium" for="st-args">
                            {{ t("workspace.scheduledTasks.argsLabel") }}
                        </label>
                        <Textarea
                            id="st-args"
                            v-model="argsText"
                            rows="2"
                            data-testid="st-create-args"
                        />
                    </div>
                    <div class="grid gap-2">
                        <label class="text-sm font-medium" for="st-cwd">
                            {{ t("workspace.scheduledTasks.cwdLabel") }}
                        </label>
                        <Input id="st-cwd" v-model="cwd" data-testid="st-create-cwd" />
                    </div>
                </template>

                <p
                    v-if="fieldError"
                    class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                    data-testid="st-create-field-error"
                >
                    {{ fieldError }}
                </p>
                <p
                    v-if="formError"
                    class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                    data-testid="st-create-form-error"
                >
                    {{ formError }}
                </p>
            </div>

            <DialogFooter>
                <Button variant="outline" data-testid="st-create-cancel" @click="emit('close')">
                    {{ t("common.cancel") }}
                </Button>
                <Button
                    :disabled="submitting"
                    data-testid="st-create-submit"
                    @click="() => void handleSubmit()"
                >
                    <LoaderCircle
                        v-if="submitting"
                        class="mr-1 inline-block size-3 animate-spin"
                        aria-hidden="true"
                    />
                    {{
                        submitting
                            ? t("workspace.scheduledTasks.creating")
                            : t("workspace.scheduledTasks.submitCreate")
                    }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
