<script setup lang="ts">
import { computed, onMounted, ref, watch, onBeforeUnmount, nextTick } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { api, ApiError, isExecutionModeSwitchProbeFailure } from "../../../composables/api";
import { useAuthStore } from "../../../stores/auth";
import { logger } from "../../../lib/logger";
import { humanizeErrorCode } from "../../../lib/errorMessages";
import { toast } from "vue-sonner";
import { LoaderCircle, RefreshCw } from "@lucide/vue";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type {
    WorkspaceJob,
    WorkspaceJobCancelReason,
    WorkspaceJobCleanupStatus,
    WorkspaceJobStatus,
} from "../../../types";

type Environment = Awaited<ReturnType<typeof api.getWorkspaceEnvironment>>;

const route = useRoute(),
    auth = useAuthStore(),
    { t } = useI18n(),
    environment = ref<Environment | null>(null),
    jobs = ref<WorkspaceJob[]>([]),
    loading = ref(false),
    error = ref(""),
    preparing = ref(false),
    prepareError = ref(""),
    selectedExecutionMode = ref<"docker" | "windows-mxc" | "windows-host">("docker"),
    changingExecutionMode = ref(false),
    pollTimer = ref<ReturnType<typeof setInterval> | null>(null),
    workspaceId = computed(() => {
        const fromRoute = String(route.params.workspaceId ?? "").trim();
        return fromRoute || auth.currentWorkspaceId || "";
    });

const STATUS_META: Record<string, { cls: string; recoveryKey: string }> = {
    ready: {
        cls: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
        recoveryKey: "workspace.environmentRecovery.ready",
    },
    materializing: {
        cls: "border-sky-500/40 text-sky-700 dark:text-sky-300",
        recoveryKey: "workspace.environmentRecovery.materializing",
    },
    // PLAN-0345: explicit 6-state entries — paused/stopped/destroying must not
    // fall into the unknown fallback (T3.1 UI assertion).
    paused: {
        cls: "border-sky-500/40 text-sky-700 dark:text-sky-300",
        recoveryKey: "workspace.environmentRecovery.paused",
    },
    stopped: {
        cls: "border-amber-500/40 text-amber-700 dark:text-amber-300",
        recoveryKey: "workspace.environmentRecovery.stopped",
    },
    destroying: {
        cls: "border-red-500/40 text-red-700 dark:text-red-300",
        recoveryKey: "workspace.environmentRecovery.destroying",
    },
    degraded: {
        cls: "border-amber-500/40 text-amber-700 dark:text-amber-300",
        recoveryKey: "workspace.environmentRecovery.degraded",
    },
    blocked: {
        cls: "border-red-500/40 text-red-700 dark:text-red-300",
        recoveryKey: "workspace.environmentRecovery.blocked",
    },
    stale: {
        cls: "border-amber-500/40 text-amber-700 dark:text-amber-300",
        recoveryKey: "workspace.environmentRecovery.stale",
    },
    unbound: {
        cls: "border-amber-500/40 text-amber-700 dark:text-amber-300",
        recoveryKey: "workspace.environmentRecovery.unbound",
    },
    pending: {
        cls: "border-amber-500/40 text-amber-700 dark:text-amber-300",
        recoveryKey: "workspace.environmentRecovery.pending",
    },
};

const statusMeta = computed(() => {
    const s = (environment.value?.status ?? "unknown").toLowerCase();
    return (
        STATUS_META[s] ?? {
            cls: "border-amber-500/40 text-amber-700 dark:text-amber-300",
            recoveryKey: "workspace.environmentRecovery.unknown",
        }
    );
});

const showPrepare = computed(() => {
    const s = (environment.value?.status ?? "").toLowerCase();
    return s === "unbound" || s === "pending" || s === "blocked";
});

// PLAN-0391: release is offered while the runtime holds resources.
const releasing = ref(false),
    releaseError = ref(""),
    releaseConfirmOpen = ref(false),
    showRelease = computed(() => {
        const s = (environment.value?.status ?? "").toLowerCase();
        return s === "ready" || s === "paused" || s === "stopped";
    }),
    activeJobCount = computed(() => environment.value?.runtime?.activeJobCount ?? 0);

function releaseReasonLabel(reason: string | null | undefined): string {
    switch (reason) {
        case "USER_RELEASED":
            return t("workspace.releaseReasonUserReleased");
        case "AUTO_EVICT":
            return t("workspace.releaseReasonAutoEvict");
        case "DESTROYED":
            return t("workspace.releaseReasonDestroyed");
        case "CLEANUP_FAILED":
            return t("workspace.releaseReasonCleanupFailed");
        case "RUNTIME_UNAVAILABLE":
            return t("workspace.releaseReasonUnavailable");
        default:
            return reason ?? "";
    }
}

function newIdempotencyKey(): string {
    const random = globalThis.crypto?.randomUUID?.();
    return random ?? `release-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function handleRelease() {
    const id = workspaceId.value;
    if (!id || releasing.value) return;
    releasing.value = true;
    releaseError.value = "";
    // Flip the button state before the first await (mock/E2E timing).
    await nextTick();
    try {
        await api.releaseWorkspaceRuntime(id, newIdempotencyKey());
        releaseConfirmOpen.value = false;
        toast.success(t("workspace.releaseSuccess"));
        await loadEnvironment();
    } catch (cause) {
        const code = cause instanceof ApiError ? cause.problem.code : null;
        logger.error("Release workspace runtime failed", cause);
        releaseError.value =
            code === "WORKSPACE_BUSY"
                ? t("workspace.releaseBusyError")
                : cause instanceof ApiError
                  ? cause.message
                  : t("workspace.releaseFailed");
        toast.error(releaseError.value);
    } finally {
        releasing.value = false;
    }
}

const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set([
    "succeeded",
    "cancelled",
    "timeout",
    "orphaned",
    "interrupted",
]);

/**
 * task-49：枚举展示文案走 i18n，且**在调用时求值**（`t()` 在这里是函数体，不是 setup 期常量 ——
 * 参考 `task-47` 的教训：把 `t()` 的返回值存进常量会让界面冻结在挂载时的语言）。
 *
 * 三张键表的**值域与 `docs/api/openapi.yaml` 的 `WorkspaceJob` 逐项一致**
 * （`status` yaml `:8055`、`cancelReason` `:8060`、`cleanupStatus` `:8065`）。
 * 用完整的 `Record<…>` 而不是 `Partial<…>`：契约加枚举值而这里没跟随时 `vue-tsc` 直接红，
 * 不必等人去比对 yaml。未知值一律回落 wire 原值（**不自造展示值**）。
 */
const JOB_STATUS_KEY: Record<WorkspaceJobStatus, string> = {
    pending: "workspace.environmentJobStatus.pending",
    running: "workspace.environmentJobStatus.running",
    succeeded: "workspace.environmentJobStatus.succeeded",
    cancelled: "workspace.environmentJobStatus.cancelled",
    timeout: "workspace.environmentJobStatus.timeout",
    orphaned: "workspace.environmentJobStatus.orphaned",
    interrupted: "workspace.environmentJobStatus.interrupted",
};

const JOB_CANCEL_REASON_KEY: Record<WorkspaceJobCancelReason, string> = {
    user_cancel: "workspace.environmentJobCancelReason.userCancel",
    scope_run_end: "workspace.environmentJobCancelReason.scopeRunEnd",
    scope_session_stop: "workspace.environmentJobCancelReason.scopeSessionStop",
    workspace_destroy: "workspace.environmentJobCancelReason.workspaceDestroy",
    runtime_restart: "workspace.environmentJobCancelReason.runtimeRestart",
    destroy_orphan: "workspace.environmentJobCancelReason.destroyOrphan",
    job_missing: "workspace.environmentJobCancelReason.jobMissing",
};

const JOB_CLEANUP_STATUS_KEY: Record<WorkspaceJobCleanupStatus, string> = {
    not_started: "workspace.environmentJobCleanupStatus.notStarted",
    running: "workspace.environmentJobCleanupStatus.running",
    completed: "workspace.environmentJobCleanupStatus.completed",
    failed: "workspace.environmentJobCleanupStatus.failed",
};

function jobStatusLabel(status: string): string {
    const key = JOB_STATUS_KEY[status as WorkspaceJobStatus];
    return key ? t(key) : status;
}

function jobCancelReasonLabel(reason: string): string {
    const key = JOB_CANCEL_REASON_KEY[reason as WorkspaceJobCancelReason];
    return key ? t(key) : reason;
}

function jobCleanupStatusLabel(status: string): string {
    const key = JOB_CLEANUP_STATUS_KEY[status as WorkspaceJobCleanupStatus];
    return key ? t(key) : status;
}

function isTerminalJob(status: string): boolean {
    return TERMINAL_JOB_STATUSES.has(status);
}

/**
 * One line of secondary job detail: terminal jobs surface `cancelReason`,
 * non-terminal jobs surface `cleanupStatus` once cleanup has actually started.
 */
function jobDetailText(job: WorkspaceJob): string {
    const parts: string[] = [];
    if (isTerminalJob(job.status)) {
        if (job.cancelReason) parts.push(jobCancelReasonLabel(job.cancelReason));
    } else if (job.cleanupStatus && job.cleanupStatus !== "not_started") {
        parts.push(jobCleanupStatusLabel(job.cleanupStatus));
    }
    return parts.join(" · ");
}

function jobErrorText(job: WorkspaceJob): string {
    return job.errorCode ? humanizeErrorCode(job.errorCode) : "";
}

// PLAN-0396：Job 可用性来自 Runtime capabilities（CP 透出），不再与
// `executionMode === 'docker'` 绑定；不可用/未知时给显式原因并禁用入口。
const jobCapability = computed(() => environment.value?.jobCapability),
    jobStartAvailable = computed(
        () => Boolean(jobCapability.value?.canStart) && jobCapability.value?.available === true,
    );
const jobStartReason = computed(() => {
    const capability = jobCapability.value;
    if (!capability) return t("workspace.environmentJobCapabilityUnknown");
    if (!jobStartAvailable.value) {
        return t("workspace.environmentJobCapabilityUnavailable", {
            reason:
                capability.unavailableReason ??
                t("workspace.environmentJobCapabilityReasonMissing"),
        });
    }
    const backend =
        capability.backendKind ||
        environment.value?.executionMode ||
        t("workspace.environmentBackendUnknown");
    if (capability.canIsolateFilesystem === true) {
        return t("workspace.environmentJobCapabilitySandboxed", { backend });
    }
    if (capability.canIsolateFilesystem === false) {
        return t("workspace.environmentJobCapabilityUnrestricted", { backend });
    }
    return t("workspace.environmentJobCapabilityUnknownIsolation", { backend });
});

// `hostPath` is a privileged projection. A null/safe projection must never be
// replaced with a locally cached path, and a raw path is only shown to an
// instance admin or the workspace owner.
const canViewRawHostPath = computed(() => {
    if (!auth.user) return false;
    if (auth.isAdmin) return true;
    return Boolean(auth.workspace?.ownerId && auth.workspace.ownerId === auth.user.id);
});
const disclosedHostPath = computed(() => {
    const path = environment.value?.hostPath;
    return canViewRawHostPath.value && typeof path === "string" && path.length > 0 ? path : null;
});

// PLAN-0551: managed_import is docker-only and direct_attach only switches between
// MXC and host. The page must never offer a combination CP rejects with 400.
const DIRECT_ATTACH_EXECUTION_MODES = ["windows-mxc", "windows-host"] as const;
const currentExecutionMode = computed(() => environment.value?.executionMode ?? "");
const isDirectAttachStorage = computed(() => environment.value?.storageMode === "direct_attach");
const managedExecutionModeIsDocker = computed(() => currentExecutionMode.value === "docker");
/**
 * PLAN-0612 M4.3: the workspace Docker execution backend is frozen (2026-10-31 ruling). Any
 * workspace still on it — either a `managed_import` workspace (docker-only) or a direct_attach one
 * that was switched to docker — gets the banner.
 */
const executionBackendFrozen = computed(
    () => managedExecutionModeIsDocker.value || environment.value?.storageMode === "managed_import",
);
const hasLegacyExecutionMode = computed(
    () =>
        isDirectAttachStorage.value &&
        !DIRECT_ATTACH_EXECUTION_MODES.includes(
            currentExecutionMode.value as (typeof DIRECT_ATTACH_EXECUTION_MODES)[number],
        ),
);
const managedExecutionModeLabel = computed(() => {
    if (managedExecutionModeIsDocker.value) return t("workspace.executionModeFixed");
    return t("workspace.executionModeLegacy");
});

async function loadEnvironment() {
    const id = workspaceId.value;
    if (!id) {
        error.value = "Workspace context is required";
        return;
    }
    loading.value = true;
    error.value = "";
    try {
        environment.value = await api.getWorkspaceEnvironment(id);
        selectedExecutionMode.value = environment.value.executionMode;
        try {
            jobs.value = await api.getWorkspaceJobs(id);
        } catch (cause) {
            jobs.value = [];
            logger.warn(
                "Workspace Job projection unavailable: " +
                    (cause instanceof Error ? cause.message : String(cause)),
            );
        }
    } catch (cause) {
        error.value =
            cause instanceof ApiError ? cause.message : "Failed to load workspace environment";
    } finally {
        loading.value = false;
    }
}

async function handleExecutionModeChange(value: string) {
    const id = workspaceId.value;
    if (!id || !environment.value) return;
    const nextMode = value as typeof selectedExecutionMode.value;
    if (nextMode === environment.value.executionMode) return;
    changingExecutionMode.value = true;
    try {
        await api.updateWorkspaceExecutionMode(id, nextMode);
        toast.success(t("workspace.executionModeUpdated"));
        await loadEnvironment();
    } catch (cause) {
        selectedExecutionMode.value = environment.value.executionMode;
        logger.error("Execution mode update failed", cause);
        const code = cause instanceof ApiError ? cause.problem.code : null;
        if (code === "WORKSPACE_BUSY") {
            // PLAN-0384 T2.4: an active Job blocks the switch; guide the user to stop it first.
            toast.error(t("workspace.executionModeBusy"));
        } else if (nextMode === "windows-mxc" && isExecutionModeSwitchProbeFailure(code)) {
            // MXC probe failure: offer an explicit switch to host; never fall back automatically.
            toast.error(t("workspace.executionModeMxcFailed"));
        } else {
            toast.error(
                cause instanceof ApiError
                    ? cause.message
                    : t("workspace.executionModeUpdateFailed"),
            );
        }
    } finally {
        changingExecutionMode.value = false;
    }
}

async function handlePrepare() {
    const id = workspaceId.value;
    if (!id || preparing.value) return;
    preparing.value = true;
    prepareError.value = "";
    // Set synchronously before the first await so the button state flips
    // even if the request resolves on the next microtask (mock/E2E timing).
    await nextTick();
    try {
        await api.materializeWorkspace(id);
        toast.success("Materialization started — polling status");
        startPolling();
    } catch (cause) {
        const message =
            cause instanceof ApiError ? cause.message : "Failed to start materialization";
        logger.error("Prepare workspace failed", cause);
        prepareError.value = message;
        toast.error(message);
        preparing.value = false;
    }
}

function startPolling() {
    stopPolling();
    pollTimer.value = setInterval(async () => {
        const id = workspaceId.value;
        if (!id) {
            stopPolling();
            return;
        }
        try {
            environment.value = await api.getWorkspaceEnvironment(id);
            const s = (environment.value?.status ?? "").toLowerCase();
            if (s === "ready" || s === "blocked") {
                stopPolling();
                if (s === "ready") toast.success("Workspace is ready");
            }
        } catch (cause) {
            logger.warn(
                "Environment poll failed: " +
                    (cause instanceof Error ? cause.message : String(cause)),
            );
        }
    }, 3000);
}

function stopPolling() {
    if (pollTimer.value) {
        clearInterval(pollTimer.value);
        pollTimer.value = null;
    }
    preparing.value = false;
}

onMounted(loadEnvironment);
watch(
    () => workspaceId.value,
    () => {
        stopPolling();
        loadEnvironment();
    },
);
onBeforeUnmount(stopPolling);
</script>

<template>
    <section class="min-h-full bg-background px-4 py-8 sm:px-8">
        <div class="mx-auto max-w-5xl">
            <header class="mb-8 border-b pb-5">
                <p class="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    {{ t("workspace.environmentEyebrow") }}
                </p>
                <h1
                    data-testid="workspace-environment-heading"
                    class="mt-2 text-2xl font-semibold tracking-tight"
                >
                    {{ t("workspace.environmentState") }}
                </h1>
                <p class="mt-2 max-w-2xl text-sm text-muted-foreground">
                    {{ t("workspace.environmentSubtitle") }}
                </p>
            </header>

            <div class="mb-5 flex justify-end">
                <button
                    class="px-3 py-1.5 text-xs rounded border hover:bg-accent text-muted-foreground transition-colors"
                    :title="t('common.refresh')"
                    data-testid="workspace-environment-refresh"
                    @click="loadEnvironment()"
                >
                    <RefreshCw class="mr-1 inline-block size-3.5" aria-hidden="true" />
                    {{ t("common.refresh") }}
                </button>
            </div>

            <div v-if="loading" class="rounded-lg border p-6 text-sm text-muted-foreground">
                {{ t("workspace.environmentLoading") }}
            </div>
            <div
                v-else-if="error"
                class="rounded-lg border border-destructive/40 p-6 text-sm text-destructive"
            >
                {{ error }}
            </div>
            <div v-else-if="environment" class="space-y-5">
                <!-- PLAN-0612 M4.3 / 2026-10-31 裁定: an existing workspace on the Docker execution
                     backend must say up front that the backend is frozen and point at direct_attach,
                     instead of failing later at container creation. -->
                <div
                    v-if="executionBackendFrozen"
                    class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
                    data-testid="workspace-execution-backend-frozen"
                >
                    <p class="font-medium">{{ t("workspace.executionBackendFrozenTitle") }}</p>
                    <p class="mt-1 text-xs text-muted-foreground">
                        {{ t("workspace.executionBackendFrozenHint") }}
                    </p>
                </div>
                <div
                    class="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-5"
                >
                    <div>
                        <p class="text-sm text-muted-foreground">
                            {{ t("workspace.environmentWorkspaceId") }}
                        </p>
                        <p class="mt-1 break-all font-mono text-sm">
                            {{ environment.workspaceId }}
                        </p>
                    </div>
                    <span
                        class="rounded-full border px-3 py-1 text-sm font-medium"
                        data-testid="workspace-environment-status"
                        :class="statusMeta.cls"
                    >
                        {{ environment.status }}
                    </span>
                </div>

                <p
                    class="rounded-lg border p-4 text-sm text-muted-foreground"
                    data-testid="workspace-environment-recovery"
                >
                    {{ t(statusMeta.recoveryKey) }}
                </p>

                <div
                    v-if="showPrepare"
                    class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-sky-500/40 bg-sky-50 dark:bg-sky-950 p-5"
                    data-testid="workspace-prepare-card"
                >
                    <div>
                        <p class="text-sm font-medium">
                            {{ t("workspace.environmentUnmaterializedTitle") }}
                        </p>
                        <p class="mt-1 max-w-xl text-xs text-muted-foreground">
                            {{ t("workspace.environmentUnmaterializedHint") }}
                        </p>
                        <p v-if="prepareError" class="mt-2 text-xs text-destructive">
                            {{ prepareError }}
                        </p>
                    </div>
                    <button
                        class="px-4 py-2 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                        :disabled="preparing"
                        data-testid="workspace-prepare-button"
                        @click="handlePrepare"
                    >
                        <LoaderCircle
                            v-if="preparing"
                            class="mr-1 inline-block size-3 animate-spin"
                            aria-hidden="true"
                        />
                        {{
                            preparing
                                ? t("workspace.environmentPreparePreparing")
                                : t("workspace.environmentPrepare")
                        }}
                    </button>
                </div>

                <div
                    v-if="showRelease"
                    class="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-5"
                    data-testid="workspace-release-card"
                >
                    <div>
                        <p class="text-sm font-medium">{{ t("workspace.releaseTitle") }}</p>
                        <p class="mt-1 max-w-xl text-xs text-muted-foreground">
                            {{ t("workspace.releaseHint") }}
                        </p>
                        <p
                            v-if="activeJobCount > 0"
                            class="mt-2 text-xs text-destructive"
                            data-testid="workspace-runtime-release-status"
                        >
                            {{ t("workspace.releaseBusyHint", { count: activeJobCount }) }}
                        </p>
                        <p
                            v-else-if="releaseError"
                            class="mt-2 text-xs text-destructive"
                            data-testid="workspace-runtime-release-status"
                        >
                            {{ releaseError }}
                        </p>
                    </div>
                    <button
                        class="px-4 py-2 text-sm rounded border border-destructive/60 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        :disabled="releasing || activeJobCount > 0"
                        data-testid="workspace-runtime-release"
                        @click="releaseConfirmOpen = true"
                    >
                        <LoaderCircle
                            v-if="releasing"
                            class="mr-1 inline-block size-3 animate-spin"
                            aria-hidden="true"
                        />
                        {{
                            releasing
                                ? t("workspace.releaseReleasing")
                                : t("workspace.releaseAction")
                        }}
                    </button>
                </div>

                <div
                    v-if="releaseConfirmOpen"
                    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                    data-testid="workspace-release-confirm"
                >
                    <div class="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg">
                        <p class="text-sm font-medium">{{ t("workspace.releaseConfirmTitle") }}</p>
                        <p class="mt-2 text-xs text-muted-foreground">
                            {{ t("workspace.releaseConfirmBody") }}
                        </p>
                        <p v-if="releaseError" class="mt-2 text-xs text-destructive">
                            {{ releaseError }}
                        </p>
                        <div class="mt-4 flex justify-end gap-2">
                            <button
                                class="px-3 py-1.5 text-sm rounded border hover:bg-muted"
                                data-testid="workspace-release-cancel"
                                @click="releaseConfirmOpen = false"
                            >
                                {{ t("workspace.cancel") }}
                            </button>
                            <button
                                class="px-3 py-1.5 text-sm rounded bg-destructive text-destructive-foreground hover:opacity-90 disabled:opacity-50"
                                :disabled="releasing"
                                data-testid="workspace-release-confirm-button"
                                @click="handleRelease"
                            >
                                {{ t("workspace.releaseConfirmAction") }}
                            </button>
                        </div>
                    </div>
                </div>

                <div class="grid gap-5 md:grid-cols-2">
                    <article class="rounded-lg border p-5">
                        <h2 class="font-medium">{{ t("workspace.environmentStorageTitle") }}</h2>
                        <dl class="mt-4 space-y-3 text-sm">
                            <div class="flex justify-between gap-4">
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldBackend") }}
                                </dt>
                                <dd>{{ environment.storageBackend }}</dd>
                            </div>
                            <div class="flex justify-between gap-4">
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldStorageMode") }}
                                </dt>
                                <dd>{{ environment.storageMode }}</dd>
                            </div>
                            <div class="flex justify-between gap-4">
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldStorageRef") }}
                                </dt>
                                <dd class="break-all font-mono text-right">
                                    {{ environment.storageRef }}
                                </dd>
                            </div>
                            <div
                                v-if="disclosedHostPath"
                                data-testid="workspace-host-path"
                                class="flex justify-between gap-4"
                            >
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldHostPath") }}
                                </dt>
                                <dd class="break-all font-mono text-right">
                                    {{ disclosedHostPath }}
                                </dd>
                            </div>
                        </dl>
                    </article>
                    <article class="rounded-lg border p-5">
                        <h2 class="font-medium">{{ t("workspace.environmentExecutionTitle") }}</h2>
                        <dl class="mt-4 space-y-3 text-sm">
                            <div class="flex justify-between gap-4">
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldStatus") }}
                                </dt>
                                <dd>
                                    {{
                                        (environment.executionSpec ?? environment.assignment)
                                            ?.status ?? "unknown"
                                    }}
                                </dd>
                            </div>
                            <div class="space-y-1">
                                <div class="flex items-start justify-between gap-4">
                                    <dt class="shrink-0 text-muted-foreground">
                                        {{ t("workspace.environmentFieldExecutionMode") }}
                                    </dt>
                                    <dd v-if="isDirectAttachStorage" class="min-w-0 text-right">
                                        <Select
                                            :model-value="
                                                selectedExecutionMode ||
                                                (hasLegacyExecutionMode ? '__legacy_unknown__' : '')
                                            "
                                            :disabled="changingExecutionMode"
                                            @update:model-value="
                                                (value) =>
                                                    handleExecutionModeChange(
                                                        String(
                                                            value === '__legacy_unknown__'
                                                                ? ''
                                                                : (value ?? ''),
                                                        ),
                                                    )
                                            "
                                        >
                                            <SelectTrigger
                                                class="rounded border bg-background px-2 py-1 text-xs"
                                                aria-describedby="workspace-execution-mode-hint"
                                                data-testid="workspace-execution-mode"
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem
                                                    v-if="hasLegacyExecutionMode"
                                                    :value="
                                                        currentExecutionMode || '__legacy_unknown__'
                                                    "
                                                    disabled
                                                    data-testid="workspace-execution-mode-legacy"
                                                >
                                                    {{
                                                        currentExecutionMode ||
                                                        t("workspace.environmentValueUnknown")
                                                    }}（{{ t("workspace.executionModeLegacy") }}）
                                                </SelectItem>
                                                <SelectItem
                                                    v-for="mode in DIRECT_ATTACH_EXECUTION_MODES"
                                                    :key="mode"
                                                    :value="mode"
                                                >
                                                    {{ mode }}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <p
                                            id="workspace-execution-mode-hint"
                                            class="mt-1 text-left text-xs text-muted-foreground"
                                            data-testid="workspace-execution-mode-hint"
                                        >
                                            {{ t("workspace.executionModeDirectHint") }}
                                        </p>
                                    </dd>
                                    <dd
                                        v-else
                                        class="min-w-0 text-right"
                                        data-testid="workspace-execution-mode-fixed"
                                    >
                                        {{
                                            currentExecutionMode ||
                                            t("workspace.environmentValueUnknown")
                                        }}
                                        <span class="ml-1 text-xs text-muted-foreground">
                                            {{ managedExecutionModeLabel }}
                                        </span>
                                        <p
                                            id="workspace-execution-mode-hint"
                                            class="mt-1 text-left text-xs text-muted-foreground"
                                            data-testid="workspace-execution-mode-hint"
                                        >
                                            {{ t("workspace.executionModeManagedHint") }}
                                        </p>
                                    </dd>
                                </div>
                            </div>
                            <div v-if="environment.capability" class="flex justify-between gap-4">
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldCapability") }}
                                </dt>
                                <dd
                                    :class="
                                        environment.capability.available
                                            ? 'text-emerald-700 dark:text-emerald-300'
                                            : 'text-destructive'
                                    "
                                    class="text-right"
                                >
                                    {{
                                        environment.capability.available
                                            ? t("workspace.environmentCapabilityAvailable", {
                                                  maturity: environment.capability.maturity,
                                              })
                                            : t("workspace.environmentCapabilityUnavailable", {
                                                  reason:
                                                      environment.capability.reason ??
                                                      t(
                                                          "workspace.environmentCapabilityReasonUnknown",
                                                      ),
                                              })
                                    }}
                                </dd>
                            </div>
                            <div class="flex justify-between gap-4">
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldGeneration") }}
                                </dt>
                                <dd>
                                    {{
                                        (environment.executionSpec ?? environment.assignment)
                                            ?.generation ?? "—"
                                    }}
                                </dd>
                            </div>
                            <div class="flex justify-between gap-4">
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldSpecHash") }}
                                </dt>
                                <dd class="break-all font-mono text-right">
                                    {{
                                        (environment.executionSpec ?? environment.assignment)
                                            ?.sandboxSpecHash || t("workspace.environmentValueNone")
                                    }}
                                </dd>
                            </div>
                        </dl>
                    </article>
                    <article class="rounded-lg border p-5 md:col-span-2">
                        <h2 class="font-medium">{{ t("workspace.environmentRuntimeTitle") }}</h2>
                        <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                            <div>
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldStatus") }}
                                </dt>
                                <dd class="mt-1">{{ environment.runtime.status }}</dd>
                            </div>
                            <div>
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldDevice") }}
                                </dt>
                                <dd class="mt-1 break-all font-mono">
                                    {{
                                        environment.runtime.deviceId ||
                                        t("workspace.environmentValueNotObserved")
                                    }}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldLastHeartbeat") }}
                                </dt>
                                <dd class="mt-1 break-all">
                                    {{
                                        environment.runtime.lastHeartbeatAt ||
                                        t("workspace.environmentValueNotObserved")
                                    }}
                                </dd>
                            </div>
                            <div
                                v-if="environment.runtime.reason"
                                data-testid="workspace-runtime-reason"
                            >
                                <dt class="text-muted-foreground">
                                    {{ t("workspace.environmentFieldReleaseStatus") }}
                                </dt>
                                <dd class="mt-1">
                                    {{ releaseReasonLabel(environment.runtime.reason) }}
                                </dd>
                            </div>
                        </dl>
                    </article>
                    <article
                        class="rounded-lg border p-5 md:col-span-2"
                        data-testid="workspace-jobs-panel"
                    >
                        <div class="flex flex-wrap items-center justify-between gap-3">
                            <h2 class="font-medium">{{ t("workspace.environmentJobsTitle") }}</h2>
                            <div class="flex items-center gap-3">
                                <span
                                    class="rounded border px-2 py-1 text-xs text-muted-foreground"
                                    :class="
                                        jobStartAvailable ? '' : 'opacity-60 cursor-not-allowed'
                                    "
                                    :aria-disabled="!jobStartAvailable"
                                    :title="jobStartReason"
                                    data-testid="workspace-job-start-hint"
                                >
                                    {{ jobStartReason }}
                                </span>
                                <span class="text-xs text-muted-foreground">{{
                                    t("workspace.environmentJobCount", { count: jobs.length })
                                }}</span>
                            </div>
                        </div>
                        <p v-if="jobs.length === 0" class="mt-3 text-sm text-muted-foreground">
                            {{ t("workspace.environmentJobsEmpty") }}
                        </p>
                        <ul v-else class="mt-3 divide-y text-sm">
                            <li
                                v-for="job in jobs"
                                :key="job.jobId"
                                class="flex flex-wrap items-center justify-between gap-3 py-3"
                            >
                                <div class="min-w-0">
                                    <p class="truncate font-mono text-xs">
                                        {{ job.jobId }}
                                    </p>
                                    <p
                                        class="mt-1 text-xs text-muted-foreground"
                                        data-testid="workspace-job-secondary"
                                    >
                                        {{ job.source }} · {{ job.scope }} ·
                                        {{
                                            job.backendKind ??
                                            t("workspace.environmentBackendUnknown")
                                        }}
                                        <template v-if="jobDetailText(job)">
                                            · {{ jobDetailText(job) }}</template
                                        >
                                    </p>
                                    <p
                                        v-if="job.errorCode"
                                        class="mt-1 text-xs text-destructive"
                                        data-testid="workspace-job-error"
                                        role="alert"
                                    >
                                        {{ jobErrorText(job) }}
                                        <code class="font-mono">({{ job.errorCode }})</code>
                                    </p>
                                </div>
                                <span
                                    class="rounded border px-2 py-1 text-xs"
                                    data-testid="workspace-job-status"
                                >
                                    {{ jobStatusLabel(job.status) }}
                                </span>
                            </li>
                        </ul>
                    </article>
                </div>
            </div>
        </div>
    </section>
</template>
