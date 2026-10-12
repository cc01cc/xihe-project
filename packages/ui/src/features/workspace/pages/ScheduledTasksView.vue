<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useAuthStore } from "../../../stores/auth";
import { logger } from "../../../lib/logger";
import {
    canManageScheduledTask,
    scheduledTaskErrorText,
    useScheduledTasksStore,
} from "../stores/scheduledTasks";
import { useWorkspaceSSE } from "../composables/useWorkspaceSSE";
import ScheduledTaskCreateDialog from "../components/ScheduledTaskCreateDialog.vue";
import ScheduledTaskPostponeDialog from "../components/ScheduledTaskPostponeDialog.vue";
import { Button } from "../../../components/ui/button";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogCancel,
} from "../../../components/ui/alert-dialog";
import { LoaderCircle, Plus, RefreshCw } from "@lucide/vue";
import type { ScheduledTask, ScheduledTaskStatus } from "../../../types";

const route = useRoute(),
    auth = useAuthStore(),
    store = useScheduledTasksStore(),
    { t } = useI18n();

const workspaceId = computed(() => {
    const fromRoute = String(route.params.workspaceId ?? "").trim();
    return fromRoute || auth.currentWorkspaceId || "";
});

const showCreateDialog = ref(false),
    postponeTarget = ref<ScheduledTask | null>(null),
    removeTarget = ref<ScheduledTask | null>(null),
    cancelTarget = ref<ScheduledTask | null>(null),
    disposeError = ref(""),
    // 30s 时钟驱动「延迟剩余」倒计时显示（纯 UI，不参与请求节流）。
    now = ref(Date.now());
const clock = setInterval(() => {
    now.value = Date.now();
}, 30_000);
onBeforeUnmount(() => clearInterval(clock));

type StatusFilter = "all" | "active" | "pending" | "done";
const filter = ref<StatusFilter>("all");

const ACTIVE: ReadonlySet<ScheduledTaskStatus> = new Set(["scheduled", "firing"]);
const PENDING: ReadonlySet<ScheduledTaskStatus> = new Set(["missed", "expired"]);
const DONE: ReadonlySet<ScheduledTaskStatus> = new Set(["completed", "cancelled"]);

function matchesFilter(task: ScheduledTask): boolean {
    if (filter.value === "all") return true;
    if (filter.value === "active") return ACTIVE.has(task.status);
    if (filter.value === "pending") return PENDING.has(task.status);
    return DONE.has(task.status);
}

const visibleTasks = computed(() => store.tasks.filter(matchesFilter));

function countFor(kind: Exclude<StatusFilter, "all">): number {
    const set = kind === "active" ? ACTIVE : kind === "pending" ? PENDING : DONE;
    return store.tasks.filter((task) => set.has(task.status)).length;
}

const STATUS_LABEL_KEYS: Record<ScheduledTaskStatus, string> = {
    scheduled: "workspace.scheduledTasks.statusScheduled",
    firing: "workspace.scheduledTasks.statusFiring",
    missed: "workspace.scheduledTasks.statusMissed",
    expired: "workspace.scheduledTasks.statusExpired",
    completed: "workspace.scheduledTasks.statusCompleted",
    cancelled: "workspace.scheduledTasks.statusCancelled",
};

const STATUS_BADGE_CLS: Record<ScheduledTaskStatus, string> = {
    scheduled: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    firing: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    missed: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    expired: "border-destructive/40 bg-destructive/10 text-destructive",
    completed: "border-border bg-muted text-muted-foreground",
    cancelled: "border-border bg-transparent text-muted-foreground line-through",
};

function statusLabel(status: ScheduledTaskStatus): string {
    return t(STATUS_LABEL_KEYS[status]);
}

const MISSED_REASON_KEYS: Record<string, string> = {
    overdue_grace: "workspace.scheduledTasks.reasonOverdue",
    dispatch_failed: "workspace.scheduledTasks.reasonDispatchFailed",
    target_gone: "workspace.scheduledTasks.reasonTargetGone",
};

function reasonText(task: ScheduledTask): string {
    if (task.status === "expired") return t("workspace.scheduledTasks.reasonExpiredTtl");
    if (task.missedReason && MISSED_REASON_KEYS[task.missedReason]) {
        return t(MISSED_REASON_KEYS[task.missedReason]);
    }
    return "";
}

function formatInZone(iso: string | null, timeZone: string): string {
    if (!iso) return t("workspace.scheduledTasks.nextFireNone");
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return t("workspace.scheduledTasks.nextFireNone");
    try {
        return new Intl.DateTimeFormat(undefined, {
            timeZone,
            dateStyle: "short",
            timeStyle: "short",
        }).format(date);
    } catch {
        // 无效 IANA 时区（后端已拒创建；历史行防御）→ 回退本地时间。
        return date.toLocaleString();
    }
}

function nextFireText(task: ScheduledTask): string {
    if (task.status === "firing") return t("workspace.scheduledTasks.nextFireRunning");
    if (task.status === "missed") return t("workspace.scheduledTasks.nextFireStopped");
    if (task.status === "completed" || task.status === "cancelled") {
        return t("workspace.scheduledTasks.nextFireNone");
    }
    return formatInZone(task.nextFireAt, task.timezone);
}

function delayRemainingText(task: ScheduledTask): string {
    if (task.triggerKind !== "delay_once" || !task.nextFireAt) return "";
    const remainingMs = new Date(task.nextFireAt).getTime() - now.value;
    if (Number.isNaN(remainingMs) || remainingMs <= 0) return "";
    const totalSeconds = Math.floor(remainingMs / 1000),
        hours = Math.floor(totalSeconds / 3600),
        minutes = Math.floor((totalSeconds % 3600) / 60),
        seconds = totalSeconds % 60,
        pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function triggerText(task: ScheduledTask): string {
    if (task.triggerKind === "cron") {
        const prefix = t("workspace.scheduledTasks.triggerCron");
        return task.cronExpr ? `${prefix} · ${task.cronExpr}` : prefix;
    }
    const remaining = delayRemainingText(task);
    const prefix = t("workspace.scheduledTasks.triggerDelay");
    return remaining
        ? `${prefix} · ${t("workspace.scheduledTasks.delayRemaining")} ${remaining}`
        : prefix;
}

function targetText(task: ScheduledTask): string {
    const kind =
        task.targetKind === "session_wakeup"
            ? t("workspace.scheduledTasks.targetSession")
            : t("workspace.scheduledTasks.targetJob");
    return task.targetSessionId ? `${kind} · ${task.targetSessionId.slice(0, 8)}` : kind;
}

function creatorLabel(task: ScheduledTask): string {
    if (task.createdBy.type === "agent") return t("workspace.scheduledTasks.creatorAgent");
    return t("workspace.scheduledTasks.creatorHuman");
}

function canManage(task: ScheduledTask): boolean {
    return canManageScheduledTask(task, auth.user);
}

const manageHint = computed(() => t("workspace.scheduledTasks.actionForbidden"));

async function load(force = false) {
    if (!workspaceId.value) return;
    await store.fetchScheduledTasks(workspaceId.value, { force });
}

useWorkspaceSSE(workspaceId, {
    onEvent: (event) => store.applyWorkspaceEvent(workspaceId.value, event),
});

watch(
    workspaceId,
    () => {
        if (workspaceId.value) void load(true);
    },
    { immediate: true },
);

function refreshAfterDispose() {
    void load(true);
}

async function handleRerun(task: ScheduledTask) {
    if (store.mutatingTaskId) return;
    disposeError.value = "";
    try {
        await store.rerunTask(workspaceId.value, task);
        toast.success(t("workspace.scheduledTasks.rerunStarted"));
        refreshAfterDispose();
    } catch (cause) {
        logger.warn("Rerun scheduled task failed", cause);
        disposeError.value = scheduledTaskErrorText(t, cause);
        toast.error(disposeError.value);
    }
}

async function handleRemove() {
    const task = removeTarget.value;
    if (!task || store.mutatingTaskId) return;
    disposeError.value = "";
    try {
        const result = await store.removeTask(workspaceId.value, task);
        toast.success(
            result.changed
                ? t("workspace.scheduledTasks.removeDone")
                : t("workspace.scheduledTasks.removeUnchanged"),
        );
        removeTarget.value = null;
        refreshAfterDispose();
    } catch (cause) {
        logger.warn("Remove scheduled task failed", cause);
        disposeError.value = scheduledTaskErrorText(t, cause);
        toast.error(disposeError.value);
    }
}

async function handleCancel() {
    const task = cancelTarget.value;
    if (!task || store.mutatingTaskId) return;
    disposeError.value = "";
    try {
        await store.cancelTask(workspaceId.value, task);
        toast.success(t("workspace.scheduledTasks.cancelDone"));
        cancelTarget.value = null;
        refreshAfterDispose();
    } catch (cause) {
        logger.warn("Cancel scheduled task failed", cause);
        disposeError.value = scheduledTaskErrorText(t, cause);
        toast.error(disposeError.value);
    }
}

function openCreate() {
    if (!workspaceId.value) return;
    showCreateDialog.value = true;
}
</script>

<template>
    <section class="min-h-full bg-background px-4 py-8 sm:px-8">
        <div class="mx-auto max-w-5xl">
            <header class="mb-6 flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1
                        data-testid="scheduled-tasks-heading"
                        class="text-2xl font-semibold tracking-tight"
                    >
                        {{ t("workspace.scheduledTasks.title") }}
                    </h1>
                    <p class="mt-2 max-w-2xl text-sm text-muted-foreground">
                        {{ t("workspace.scheduledTasks.subtitle") }}
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        data-testid="scheduled-tasks-refresh"
                        @click="() => load(true)"
                    >
                        <RefreshCw class="mr-1 size-3.5" aria-hidden="true" />
                        {{ t("workspace.scheduledTasks.refresh") }}
                    </Button>
                    <Button size="sm" data-testid="scheduled-tasks-create" @click="openCreate">
                        <Plus class="mr-1 size-3.5" aria-hidden="true" />
                        {{ t("workspace.scheduledTasks.create") }}
                    </Button>
                </div>
            </header>

            <div class="mb-4 flex flex-wrap gap-2" data-testid="scheduled-tasks-filters">
                <button
                    v-for="option in [
                        {
                            key: 'all',
                            label: t('workspace.scheduledTasks.filterAll'),
                            count: store.tasks.length,
                        },
                        {
                            key: 'active',
                            label: t('workspace.scheduledTasks.filterActive'),
                            count: countFor('active'),
                        },
                        {
                            key: 'pending',
                            label: t('workspace.scheduledTasks.filterPending'),
                            count: countFor('pending'),
                        },
                        {
                            key: 'done',
                            label: t('workspace.scheduledTasks.filterDone'),
                            count: countFor('done'),
                        },
                    ] as Array<{ key: StatusFilter; label: string; count: number }>"
                    :key="option.key"
                    type="button"
                    class="rounded-full border px-3 py-1 text-sm transition-colors"
                    :class="
                        filter === option.key
                            ? 'border-ring bg-accent text-accent-foreground'
                            : 'text-muted-foreground hover:bg-accent/50'
                    "
                    :data-testid="`scheduled-tasks-filter-${option.key}`"
                    @click="filter = option.key"
                >
                    {{ option.label }}
                    <span class="opacity-70">{{ option.count }}</span>
                </button>
            </div>

            <div
                v-if="store.loading && store.tasks.length === 0"
                class="rounded-lg border p-6 text-sm text-muted-foreground"
                data-testid="scheduled-tasks-loading"
            >
                <LoaderCircle class="mr-1 inline-block size-4 animate-spin" aria-hidden="true" />
                {{ t("workspace.scheduledTasks.loading") }}
            </div>

            <div
                v-else-if="store.error && store.tasks.length === 0"
                class="rounded-lg border border-destructive/40 p-6 text-sm text-destructive"
                data-testid="scheduled-tasks-error"
            >
                <p>{{ store.error }}</p>
                <Button
                    variant="outline"
                    size="sm"
                    class="mt-3"
                    data-testid="scheduled-tasks-retry"
                    @click="() => load(true)"
                >
                    {{ t("workspace.scheduledTasks.retry") }}
                </Button>
            </div>

            <div
                v-else-if="store.tasks.length === 0"
                class="rounded-lg border p-12 text-center text-muted-foreground"
                data-testid="scheduled-tasks-empty"
            >
                <p class="text-3xl opacity-50" aria-hidden="true">◷</p>
                <h2 class="mt-2 font-medium text-foreground">
                    {{ t("workspace.scheduledTasks.emptyTitle") }}
                </h2>
                <p class="mt-1 text-sm">{{ t("workspace.scheduledTasks.emptyDescription") }}</p>
                <Button
                    class="mt-4"
                    size="sm"
                    data-testid="scheduled-tasks-empty-create"
                    @click="openCreate"
                >
                    <Plus class="mr-1 size-3.5" aria-hidden="true" />
                    {{ t("workspace.scheduledTasks.create") }}
                </Button>
            </div>

            <div
                v-else-if="visibleTasks.length === 0"
                class="rounded-lg border p-8 text-center text-sm text-muted-foreground"
                data-testid="scheduled-tasks-filter-empty"
            >
                {{ t("workspace.scheduledTasks.emptyTitle") }}
            </div>

            <template v-else>
                <!-- 桌面：表格 -->
                <div class="hidden overflow-hidden rounded-lg border md:block">
                    <table class="w-full border-collapse text-sm">
                        <thead>
                            <tr
                                class="border-b text-left text-xs font-medium text-muted-foreground"
                            >
                                <th class="px-4 py-2.5">
                                    {{ t("workspace.scheduledTasks.colTask") }}
                                </th>
                                <th class="px-4 py-2.5">
                                    {{ t("workspace.scheduledTasks.colTrigger") }}
                                </th>
                                <th class="px-4 py-2.5">
                                    {{ t("workspace.scheduledTasks.colTarget") }}
                                </th>
                                <th class="px-4 py-2.5">
                                    {{ t("workspace.scheduledTasks.colStatus") }}
                                </th>
                                <th class="px-4 py-2.5">
                                    {{ t("workspace.scheduledTasks.colNextFire") }}
                                </th>
                                <th class="px-4 py-2.5">
                                    {{ t("workspace.scheduledTasks.colCreator") }}
                                </th>
                                <th class="px-4 py-2.5">
                                    {{ t("workspace.scheduledTasks.colActions") }}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="task in visibleTasks"
                                :key="task.id"
                                class="border-b last:border-b-0"
                                data-testid="scheduled-task-row"
                            >
                                <td class="max-w-56 px-4 py-3">
                                    <p class="truncate font-medium" :title="task.prompt ?? ''">
                                        {{ task.prompt || task.cronExpr || task.id.slice(0, 8) }}
                                    </p>
                                    <p class="truncate font-mono text-xs text-muted-foreground">
                                        {{ task.cronExpr ? task.cronExpr : task.id.slice(0, 8) }}
                                    </p>
                                </td>
                                <td class="px-4 py-3 text-muted-foreground">
                                    {{ triggerText(task) }}
                                </td>
                                <td class="px-4 py-3 text-muted-foreground">
                                    {{ targetText(task) }}
                                </td>
                                <td class="px-4 py-3">
                                    <span
                                        class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
                                        :class="STATUS_BADGE_CLS[task.status]"
                                        data-testid="scheduled-task-status"
                                    >
                                        <span
                                            class="size-1.5 rounded-full bg-current"
                                            aria-hidden="true"
                                        />
                                        {{ statusLabel(task.status) }}
                                    </span>
                                    <span
                                        v-if="task.status === 'missed' && task.missedCount > 0"
                                        class="ml-1.5 inline-block rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[11px] text-amber-700 dark:text-amber-300"
                                        data-testid="scheduled-task-missed-count"
                                    >
                                        ×{{ task.missedCount }}
                                    </span>
                                    <p
                                        v-if="reasonText(task)"
                                        class="mt-1 text-xs"
                                        :class="
                                            task.status === 'expired'
                                                ? 'text-destructive'
                                                : 'text-amber-700 dark:text-amber-300'
                                        "
                                        data-testid="scheduled-task-reason"
                                    >
                                        {{ reasonText(task) }}
                                    </p>
                                </td>
                                <td class="px-4 py-3">
                                    <p>{{ nextFireText(task) }}</p>
                                    <p class="text-xs text-muted-foreground">{{ task.timezone }}</p>
                                </td>
                                <td class="px-4 py-3">
                                    <span class="text-muted-foreground">{{
                                        task.createdBy.name || "—"
                                    }}</span>
                                    <span
                                        class="ml-1.5 inline-block rounded-full border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                                        :class="
                                            task.createdBy.type === 'agent'
                                                ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                                                : ''
                                        "
                                        data-testid="scheduled-task-creator-type"
                                    >
                                        {{ creatorLabel(task) }}
                                    </span>
                                </td>
                                <td class="px-4 py-3">
                                    <div class="flex flex-wrap items-center gap-1.5">
                                        <template
                                            v-if="
                                                task.status === 'missed' ||
                                                task.status === 'expired'
                                            "
                                        >
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                :disabled="
                                                    !canManage(task) || !!store.mutatingTaskId
                                                "
                                                :title="canManage(task) ? undefined : manageHint"
                                                data-testid="scheduled-task-rerun"
                                                @click="() => void handleRerun(task)"
                                            >
                                                {{ t("workspace.scheduledTasks.actionRerun") }}
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                :disabled="
                                                    !canManage(task) || !!store.mutatingTaskId
                                                "
                                                :title="canManage(task) ? undefined : manageHint"
                                                data-testid="scheduled-task-postpone"
                                                @click="postponeTarget = task"
                                            >
                                                {{ t("workspace.scheduledTasks.actionPostpone") }}
                                            </Button>
                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                :disabled="
                                                    !canManage(task) || !!store.mutatingTaskId
                                                "
                                                :title="canManage(task) ? undefined : manageHint"
                                                data-testid="scheduled-task-remove"
                                                @click="removeTarget = task"
                                            >
                                                {{ t("workspace.scheduledTasks.actionRemove") }}
                                            </Button>
                                        </template>
                                        <Button
                                            v-else-if="task.status === 'scheduled'"
                                            variant="outline"
                                            size="sm"
                                            :disabled="!canManage(task) || !!store.mutatingTaskId"
                                            :title="canManage(task) ? undefined : manageHint"
                                            data-testid="scheduled-task-cancel"
                                            @click="cancelTarget = task"
                                        >
                                            {{ t("workspace.scheduledTasks.actionCancel") }}
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- 移动：堆叠卡片 -->
                <div class="space-y-3 md:hidden">
                    <article
                        v-for="task in visibleTasks"
                        :key="task.id"
                        class="rounded-lg border p-4"
                        data-testid="scheduled-task-card"
                    >
                        <div class="flex items-start justify-between gap-2">
                            <p class="min-w-0 break-all font-medium">
                                {{ task.prompt || task.cronExpr || task.id.slice(0, 8) }}
                            </p>
                            <span
                                class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
                                :class="STATUS_BADGE_CLS[task.status]"
                                data-testid="scheduled-task-status"
                            >
                                <span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
                                {{ statusLabel(task.status) }}
                            </span>
                        </div>
                        <dl class="mt-2 space-y-1 text-xs text-muted-foreground">
                            <div class="flex justify-between gap-2">
                                <dt>{{ t("workspace.scheduledTasks.colTrigger") }}</dt>
                                <dd class="text-right">{{ triggerText(task) }}</dd>
                            </div>
                            <div class="flex justify-between gap-2">
                                <dt>{{ t("workspace.scheduledTasks.colTarget") }}</dt>
                                <dd class="text-right">{{ targetText(task) }}</dd>
                            </div>
                            <div class="flex justify-between gap-2">
                                <dt>{{ t("workspace.scheduledTasks.colNextFire") }}</dt>
                                <dd class="text-right">
                                    {{ nextFireText(task) }} · {{ task.timezone }}
                                </dd>
                            </div>
                            <div class="flex justify-between gap-2">
                                <dt>{{ t("workspace.scheduledTasks.colCreator") }}</dt>
                                <dd class="text-right">
                                    <span class="text-muted-foreground">{{
                                        task.createdBy.name || "—"
                                    }}</span>
                                    <span
                                        class="ml-1.5 inline-block rounded-full border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                                        :class="
                                            task.createdBy.type === 'agent'
                                                ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                                                : ''
                                        "
                                        data-testid="scheduled-task-creator-type"
                                    >
                                        {{ creatorLabel(task) }}
                                    </span>
                                </dd>
                            </div>
                        </dl>
                        <p
                            v-if="reasonText(task)"
                            class="mt-2 text-xs"
                            :class="
                                task.status === 'expired'
                                    ? 'text-destructive'
                                    : 'text-amber-700 dark:text-amber-300'
                            "
                            data-testid="scheduled-task-reason"
                        >
                            <span
                                v-if="task.status === 'missed' && task.missedCount > 0"
                                data-testid="scheduled-task-missed-count"
                            >
                                ×{{ task.missedCount }}
                            </span>
                            {{ reasonText(task) }}
                        </p>
                        <div class="mt-3 flex flex-wrap gap-1.5">
                            <template v-if="task.status === 'missed' || task.status === 'expired'">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    :disabled="!canManage(task) || !!store.mutatingTaskId"
                                    :title="canManage(task) ? undefined : manageHint"
                                    data-testid="scheduled-task-rerun"
                                    @click="() => void handleRerun(task)"
                                >
                                    {{ t("workspace.scheduledTasks.actionRerun") }}
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    :disabled="!canManage(task) || !!store.mutatingTaskId"
                                    :title="canManage(task) ? undefined : manageHint"
                                    data-testid="scheduled-task-postpone"
                                    @click="postponeTarget = task"
                                >
                                    {{ t("workspace.scheduledTasks.actionPostpone") }}
                                </Button>
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    :disabled="!canManage(task) || !!store.mutatingTaskId"
                                    :title="canManage(task) ? undefined : manageHint"
                                    data-testid="scheduled-task-remove"
                                    @click="removeTarget = task"
                                >
                                    {{ t("workspace.scheduledTasks.actionRemove") }}
                                </Button>
                            </template>
                            <Button
                                v-else-if="task.status === 'scheduled'"
                                variant="outline"
                                size="sm"
                                :disabled="!canManage(task) || !!store.mutatingTaskId"
                                :title="canManage(task) ? undefined : manageHint"
                                data-testid="scheduled-task-cancel"
                                @click="cancelTarget = task"
                            >
                                {{ t("workspace.scheduledTasks.actionCancel") }}
                            </Button>
                        </div>
                    </article>
                </div>
            </template>

            <p
                v-if="disposeError"
                class="mt-4 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                data-testid="scheduled-tasks-dispose-error"
            >
                {{ disposeError }}
            </p>
        </div>

        <ScheduledTaskCreateDialog
            :open="showCreateDialog"
            :workspace-id="workspaceId"
            @close="showCreateDialog = false"
            @created="refreshAfterDispose"
        />

        <ScheduledTaskPostponeDialog
            :open="postponeTarget !== null"
            :workspace-id="workspaceId"
            :task="postponeTarget"
            @close="postponeTarget = null"
            @postponed="refreshAfterDispose"
        />

        <!-- 移除确认：普通 Button（非 AlertDialogAction），失败时保持对话框打开。 -->
        <AlertDialog
            :open="removeTarget !== null"
            @update:open="(v) => !v && (removeTarget = null)"
        >
            <AlertDialogContent data-testid="scheduled-task-remove-confirm">
                <AlertDialogHeader>
                    <AlertDialogTitle class="text-destructive">
                        {{ t("workspace.scheduledTasks.removeConfirmTitle") }}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ t("workspace.scheduledTasks.removeConfirmDescription") }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <p v-if="disposeError" class="text-sm text-destructive">{{ disposeError }}</p>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("common.cancel") }}</AlertDialogCancel>
                    <Button
                        variant="destructive"
                        :disabled="!!store.mutatingTaskId"
                        data-testid="scheduled-task-remove-confirm-btn"
                        @click="() => void handleRemove()"
                    >
                        <LoaderCircle
                            v-if="store.mutatingTaskId"
                            class="mr-1 inline-block size-3 animate-spin"
                            aria-hidden="true"
                        />
                        {{ t("workspace.scheduledTasks.removeConfirm") }}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>

        <!-- 取消确认（scheduled → cancelled）。 -->
        <AlertDialog
            :open="cancelTarget !== null"
            @update:open="(v) => !v && (cancelTarget = null)"
        >
            <AlertDialogContent data-testid="scheduled-task-cancel-confirm">
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {{ t("workspace.scheduledTasks.cancelConfirmTitle") }}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ t("workspace.scheduledTasks.cancelConfirmDescription") }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <p v-if="disposeError" class="text-sm text-destructive">{{ disposeError }}</p>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("common.cancel") }}</AlertDialogCancel>
                    <Button
                        variant="destructive"
                        :disabled="!!store.mutatingTaskId"
                        data-testid="scheduled-task-cancel-confirm-btn"
                        @click="() => void handleCancel()"
                    >
                        <LoaderCircle
                            v-if="store.mutatingTaskId"
                            class="mr-1 inline-block size-3 animate-spin"
                            aria-hidden="true"
                        />
                        {{ t("workspace.scheduledTasks.cancelConfirm") }}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </section>
</template>
