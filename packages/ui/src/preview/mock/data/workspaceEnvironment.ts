import type {
    WorkspaceEnvironment,
    WorkspaceJob,
    WorkspaceJobCancelReason,
    WorkspaceJobCleanupStatus,
    WorkspaceJobStatus,
} from "../../../types";

/**
 * task-49（Lead 2026-11-11 扩授权）：工作区环境页的真页面 + mock 数据夹具。
 *
 * 为什么需要：`GET /workspaces/{id}/environment` 与 `/jobs` 原先**没有** mock 端点
 * ⇒ 环境页在 mock lane 里是 `API error 404`，Job 三列根本不渲染（改前读数：0 格）。
 * 卡面判的正是"界面在 en-US 下长什么样"，jsdom 能证"文案不含 CJK"但不能证"那一列渲染出来了"，
 * 所以补齐两条端点；同一批夹具后续「环境页整页 i18n」卡与设置区以外的页也能复用。
 *
 * 值域对齐 `docs/api/openapi.yaml` 的 `WorkspaceJob`（status `:8055` / cancelReason `:8060`
 * / cleanupStatus `:8065`）：**三套枚举的每个取值都至少有一条 job**，这样拍图时三列都有内容，
 * 不会出现"看着没中文其实是因为没渲染"。
 */
function makeJob(
    overrides: Pick<WorkspaceJob, "jobId" | "status"> & Partial<WorkspaceJob>,
): WorkspaceJob {
    return {
        runtimeJobId: null,
        workspaceId: "mock-ws-main",
        sessionId: null,
        runId: null,
        source: "ui",
        scope: "session",
        startedAt: "2026-11-11T09:00:00Z",
        endedAt: null,
        exitCode: null,
        timeoutSecs: 300,
        cancelReason: null,
        backendKind: "windows-host",
        executionMode: "windows-host",
        actorType: "user",
        createdAt: "2026-11-11T09:00:00Z",
        cleanupStatus: null,
        errorCode: null,
        ...overrides,
    };
}

/** 7 个 `status` 各一条；terminal 的用 `cancelReason` 造二级行，非 terminal 的用 `cleanupStatus`。 */
const STATUS_SAMPLES: { status: WorkspaceJobStatus; scope: WorkspaceJob["scope"] }[] = [
    { status: "pending", scope: "session" },
    { status: "running", scope: "workspace" },
    { status: "succeeded", scope: "run" },
    { status: "cancelled", scope: "session" },
    { status: "timeout", scope: "workspace" },
    { status: "orphaned", scope: "run" },
    { status: "interrupted", scope: "session" },
];

/** terminal 状态配取消原因（`jobDetailText` 只在 terminal 时读 `cancelReason`）。 */
const TERMINAL_REASONS: Record<string, WorkspaceJobCancelReason> = {
    succeeded: "job_missing",
    cancelled: "user_cancel",
    timeout: "runtime_restart",
    orphaned: "destroy_orphan",
    interrupted: "scope_run_end",
};

/** 与产品页共用同一判据（`TERMINAL_JOB_STATUSES`），只是这里的对象更窄。 */
const TERMINAL_STATUSES = new Set<string>([
    "succeeded",
    "cancelled",
    "timeout",
    "orphaned",
    "interrupted",
]);

/** 非 terminal 状态配清理状态（`not_started` 按产品逻辑不渲染，所以只用后三档）。 */
const CLEANUP_FOR_ACTIVE: Record<string, WorkspaceJobCleanupStatus> = {
    pending: "not_started",
    running: "running",
};

/** 7 个 `cancelReason` 里被 STATUS_SAMPLES 用掉的那几个之外，剩下的各补一条。 */
const EXTRA_REASONS: WorkspaceJobCancelReason[] = [
    "scope_session_stop",
    "workspace_destroy",
    "user_cancel",
];

export function mockWorkspaceJobs(workspaceId: string): WorkspaceJob[] {
    const statusJobs = STATUS_SAMPLES.map(({ status, scope }) =>
        makeJob({
            jobId: `mock-job-${status}`,
            workspaceId,
            status,
            scope,
            cancelReason: TERMINAL_REASONS[status] ?? null,
            cleanupStatus: CLEANUP_FOR_ACTIVE[status] ?? null,
            endedAt: TERMINAL_REASONS[status] ? "2026-11-11T09:05:00Z" : null,
            exitCode: status === "succeeded" ? 0 : status === "timeout" ? 124 : null,
        }),
    );
    // 让 7 个取消原因都出现一次（三列都有料，才是可读的证据）
    const reasonJobs = EXTRA_REASONS.map((reason, index) =>
        makeJob({
            jobId: `mock-job-reason-${reason}`,
            workspaceId,
            status: "cancelled",
            scope: "session",
            cancelReason: reason,
            endedAt: "2026-11-11T09:06:00Z",
            exitCode: 130,
            // 用不同的错误码区分行，避免三行看起来一模一样
            errorCode: index === 0 ? "RUNTIME_UNAVAILABLE" : null,
        }),
    );
    // `cleanupStatus` 的 `completed` / `failed` 各一条（非 terminal 也会显示清理进度）
    const cleanupJobs: WorkspaceJobCleanupStatus[] = ["completed", "failed"];
    const cleanupJobRows = cleanupJobs.map((cleanupStatus) =>
        makeJob({
            jobId: `mock-job-cleanup-${cleanupStatus}`,
            workspaceId,
            status: "running",
            scope: "workspace",
            cleanupStatus,
        }),
    );
    return [...statusJobs, ...reasonJobs, ...cleanupJobRows];
}

export function mockWorkspaceEnvironment(workspaceId: string): WorkspaceEnvironment {
    // `activeJobCount` 从夹具**现算**，不手写数字 —— 手写的计数迟早与列表不符，
    // 而「计数与可见项矛盾」正是 UI 交付自审五维里的一条。
    const activeJobCount = mockWorkspaceJobs(workspaceId).filter(
        (job) => !TERMINAL_STATUSES.has(job.status),
    ).length;
    return {
        workspaceId,
        status: "ready",
        storageBackend: "local",
        storageRef: workspaceId,
        storageMode: "direct_attach",
        hostPath: null,
        executionMode: "windows-host",
        capability: {
            contractVersion: "1",
            backendKind: "windows-host",
            backendRevision: "mock",
            maturity: "stable",
            executionMode: "windows-host",
            available: true,
        },
        jobCapability: {
            backendKind: "windows-host",
            backendRevision: "mock",
            maturity: "stable",
            executionMode: "windows-host",
            canStart: true,
            canCancel: true,
            canStreamOutput: true,
            canIsolateFilesystem: false,
            available: true,
            unavailableReason: null,
            checkedAt: "2026-11-11T09:00:00Z",
        },
        runtime: {
            status: "up",
            deviceId: "mock-device",
            lastHeartbeatAt: "2026-11-11T09:10:00Z",
            materializationState: "materialized",
            activeJobCount,
            releaseOperationId: null,
            reason: null,
        },
    };
}
