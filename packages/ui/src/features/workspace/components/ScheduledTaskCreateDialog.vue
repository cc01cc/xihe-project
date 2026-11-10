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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import {
    FieldControl,
    FieldDescription,
    FieldError,
    FieldLabel,
    FieldRoot,
    FormRoot,
} from "reka-ui";
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
    /** PLAN-0753 M2: server-side errors keyed by field name (reka clears on edit). */
    serverErrors = ref<Record<string, string | string[]>>({});

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
        serverErrors.value = {};
        if (sessionStore.sessions.length === 0) {
            void sessionStore.loadSessions().catch((cause: unknown) => {
                logger.warn("Failed to load sessions for scheduled task create", cause);
            });
        }
    },
    // 挂载时可能已经 open（路由直达或父组件直接传 true），初始化必须立即执行。
    { immediate: true },
);

/** PLAN-0753 M2: field rules — each a pure function of the value, fed to a FieldRoot. */
function validateCron(value: unknown): string | null {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return t("workspace.scheduledTasks.cronRequired");
    if (raw.split(/\s+/).length !== 5) return t("workspace.scheduledTasks.errInvalidCronExpr");
    return null;
}
function validateTimezone(value: unknown): string | null {
    const raw = typeof value === "string" ? value.trim() : "";
    return raw ? null : t("workspace.scheduledTasks.timezoneRequired");
}
function validateDelayAmount(value: unknown): string | null {
    // FieldControl hands the raw string; Number() also accepts a pre-coerced number.
    const num = typeof value === "number" ? value : Number(String(value ?? "").trim());
    if (!Number.isFinite(num) || num <= 0) {
        return t("workspace.scheduledTasks.delayAmountInvalid");
    }
    if (num * DELAY_UNIT_MS[delayUnit.value] > TTL_MS) {
        return t("workspace.scheduledTasks.delayExceedsTtl");
    }
    return null;
}
function validateSession(value: unknown): string | null {
    const raw = typeof value === "string" ? value : "";
    return raw ? null : t("workspace.scheduledTasks.sessionRequired");
}
function validatePrompt(value: unknown): string | null {
    const raw = typeof value === "string" ? value.trim() : "";
    return raw ? null : t("workspace.scheduledTasks.promptRequired");
}
function validateCommand(value: unknown): string | null {
    const raw = typeof value === "string" ? value.trim() : "";
    return raw ? null : t("workspace.scheduledTasks.commandRequired");
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
    submitting.value = true;
    serverErrors.value = {};
    try {
        await store.createTask(props.workspaceId, buildRequest());
        toast.success(t("workspace.scheduledTasks.created"));
        emit("created");
        emit("close");
    } catch (cause) {
        logger.warn("Create scheduled task failed", cause);
        const code = cause instanceof ApiError ? cause.problem.code : null;
        const text = scheduledTaskErrorText(t, cause);
        // Field-shaped codes land on the field node; everything else is a form-level error.
        if (code === "INVALID_CRON_EXPR") serverErrors.value = { cronExpr: text };
        else if (code === "INVALID_TIMEZONE") serverErrors.value = { timezone: text };
        else serverErrors.value = { __form: text };
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

            <FormRoot class="grid gap-4 py-2" :errors="serverErrors" @form-submit="handleSubmit">
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
                    <FieldRoot name="cronExpr" class="grid gap-2" :validate="validateCron" required>
                        <FieldLabel class="text-sm font-medium">
                            {{ t("workspace.scheduledTasks.cronLabel") }}
                        </FieldLabel>
                        <FieldControl as-child>
                            <Input
                                v-model="cronExpr"
                                data-testid="st-create-cron-expr"
                                placeholder="0 9 * * *"
                            />
                        </FieldControl>
                        <FieldDescription class="text-xs text-muted-foreground">
                            {{ t("workspace.scheduledTasks.cronHint") }}
                        </FieldDescription>
                        <FieldError
                            class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                            data-testid="st-create-field-error"
                        />
                    </FieldRoot>
                    <FieldRoot
                        name="timezone"
                        class="grid gap-2"
                        :validate="validateTimezone"
                        required
                    >
                        <FieldLabel class="text-sm font-medium">
                            {{ t("workspace.scheduledTasks.timezoneLabel") }}
                        </FieldLabel>
                        <FieldControl as-child>
                            <Input v-model="timezone" data-testid="st-create-timezone" />
                        </FieldControl>
                        <FieldDescription class="text-xs text-muted-foreground">
                            {{ t("workspace.scheduledTasks.timezoneHint") }}
                        </FieldDescription>
                        <FieldError
                            class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                            data-testid="st-create-timezone-error"
                        />
                    </FieldRoot>
                </template>

                <template v-else>
                    <FieldRoot
                        name="delayAmount"
                        class="grid gap-2"
                        :validate="validateDelayAmount"
                        required
                    >
                        <FieldLabel class="text-sm font-medium">
                            {{ t("workspace.scheduledTasks.delayAmountLabel") }}
                        </FieldLabel>
                        <div class="flex gap-2">
                            <FieldControl
                                v-model="delayAmount"
                                as="input"
                                type="number"
                                min="1"
                                class="h-8 w-28 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                                data-testid="st-create-delay-amount"
                            />
                            <FieldRoot name="delayUnit" class="contents">
                                <Select v-model="delayUnit">
                                    <SelectTrigger
                                        class="rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        data-testid="st-create-delay-unit"
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="minutes">{{
                                            t("workspace.scheduledTasks.delayUnitMinutes")
                                        }}</SelectItem>
                                        <SelectItem value="hours">{{
                                            t("workspace.scheduledTasks.delayUnitHours")
                                        }}</SelectItem>
                                        <SelectItem value="days">{{
                                            t("workspace.scheduledTasks.delayUnitDays")
                                        }}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </FieldRoot>
                        </div>
                        <FieldDescription class="text-xs text-muted-foreground">
                            {{ t("workspace.scheduledTasks.delayHint") }}
                        </FieldDescription>
                        <FieldError
                            class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                            data-testid="st-create-field-error"
                        />
                    </FieldRoot>
                </template>

                <div class="grid gap-2">
                    <label class="text-sm font-medium" for="st-target-kind">
                        {{ t("workspace.scheduledTasks.targetLabel") }}
                    </label>
                    <Select v-model="targetKind">
                        <SelectTrigger
                            id="st-target-kind"
                            class="rounded-md border border-input bg-background px-3 py-2 text-sm"
                            data-testid="st-create-target-kind"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="session_wakeup">{{
                                t("workspace.scheduledTasks.targetSessionOption")
                            }}</SelectItem>
                            <SelectItem value="job_dispatch">{{
                                t("workspace.scheduledTasks.targetJobOption")
                            }}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <template v-if="targetKind === 'session_wakeup'">
                    <FieldRoot
                        name="targetSessionId"
                        class="grid gap-2"
                        :validate="validateSession"
                        required
                    >
                        <FieldLabel class="text-sm font-medium">
                            {{ t("workspace.scheduledTasks.sessionSelectLabel") }}
                        </FieldLabel>
                        <Select v-model="targetSessionId">
                            <SelectTrigger
                                class="rounded-md border border-input bg-background px-3 py-2 text-sm"
                                data-testid="st-create-session"
                            >
                                <SelectValue
                                    :placeholder="t('workspace.scheduledTasks.sessionPlaceholder')"
                                />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    v-for="session in sessions"
                                    :key="session.id"
                                    :value="session.id"
                                >
                                    {{ session.title }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <FieldDescription
                            v-if="sessions.length === 0"
                            class="text-xs text-muted-foreground"
                            data-testid="st-create-session-empty"
                        >
                            {{ t("workspace.scheduledTasks.sessionEmpty") }}
                        </FieldDescription>
                        <FieldError
                            class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                            data-testid="st-create-session-error"
                        />
                    </FieldRoot>
                    <FieldRoot name="prompt" class="grid gap-2" :validate="validatePrompt" required>
                        <FieldLabel class="text-sm font-medium">
                            {{ t("workspace.scheduledTasks.promptLabel") }}
                        </FieldLabel>
                        <FieldControl as-child>
                            <Textarea
                                v-model="prompt"
                                rows="3"
                                data-testid="st-create-prompt"
                                :placeholder="t('workspace.scheduledTasks.promptPlaceholder')"
                            />
                        </FieldControl>
                        <FieldError
                            class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                            data-testid="st-create-prompt-error"
                        />
                    </FieldRoot>
                </template>

                <template v-else>
                    <FieldRoot
                        name="command"
                        class="grid gap-2"
                        :validate="validateCommand"
                        required
                    >
                        <FieldLabel class="text-sm font-medium">
                            {{ t("workspace.scheduledTasks.commandLabel") }}
                        </FieldLabel>
                        <FieldControl as-child>
                            <Input
                                v-model="command"
                                data-testid="st-create-command"
                                :placeholder="t('workspace.scheduledTasks.commandPlaceholder')"
                            />
                        </FieldControl>
                        <FieldError
                            class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                            data-testid="st-create-command-error"
                        />
                    </FieldRoot>
                    <FieldRoot name="argsText" class="grid gap-2">
                        <FieldLabel class="text-sm font-medium">
                            {{ t("workspace.scheduledTasks.argsLabel") }}
                        </FieldLabel>
                        <FieldControl as-child>
                            <Textarea v-model="argsText" rows="2" data-testid="st-create-args" />
                        </FieldControl>
                    </FieldRoot>
                    <FieldRoot name="cwd" class="grid gap-2">
                        <FieldLabel class="text-sm font-medium">
                            {{ t("workspace.scheduledTasks.cwdLabel") }}
                        </FieldLabel>
                        <FieldControl as-child>
                            <Input v-model="cwd" data-testid="st-create-cwd" />
                        </FieldControl>
                    </FieldRoot>
                </template>

                <p
                    v-if="serverErrors.__form"
                    class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                    data-testid="st-create-form-error"
                >
                    {{ serverErrors.__form }}
                </p>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        data-testid="st-create-cancel"
                        @click="emit('close')"
                    >
                        {{ t("common.cancel") }}
                    </Button>
                    <Button type="submit" :disabled="submitting" data-testid="st-create-submit">
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
            </FormRoot>
        </DialogContent>
    </Dialog>
</template>
