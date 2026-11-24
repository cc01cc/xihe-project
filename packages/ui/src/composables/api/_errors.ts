/* task-1032：自 composables/api.ts 拆出的 _errors 段（逐字节搬运）。 */
import { ApiError } from "./_core";
export const WORKSPACE_JOB_ERROR_CODES = [
    "IDEMPOTENCY_KEY_REQUIRED",
    "WORKSPACE_NOT_FOUND",
    "JOB_IDEMPOTENCY_CONFLICT",
    "JOB_BACKEND_LAUNCH_PENDING",
    "RUNTIME_UNAVAILABLE",
    "PATH_OUT_OF_SCOPE",
    "CAPABILITY_UNAVAILABLE",
    "PROCESS_TIMEOUT",
    "PROCESS_CANCELLED",
    "UNMAPPED_ERROR",
] as const;
export type WorkspaceJobErrorCode = (typeof WORKSPACE_JOB_ERROR_CODES)[number];
export const WORKSPACE_JOB_ERROR_REASONS: Record<WorkspaceJobErrorCode, string> = {
    IDEMPOTENCY_KEY_REQUIRED: "缺少 Idempotency-Key，无法安全启动 Job",
    WORKSPACE_NOT_FOUND: "工作区不存在或无权访问",
    JOB_IDEMPOTENCY_CONFLICT: "幂等键冲突：相同键对应了不同的启动参数",
    JOB_BACKEND_LAUNCH_PENDING: "当前执行后端尚未提供 Job 启动器，暂不可用",
    RUNTIME_UNAVAILABLE: "Runtime 暂不可达，请确认服务已启动后重试",
    PATH_OUT_OF_SCOPE: "路径超出工作区范围，操作已拒绝",
    CAPABILITY_UNAVAILABLE: "执行能力当前不可用，请检查 Runtime 或后端状态",
    PROCESS_TIMEOUT: "进程执行超时，任务已终止",
    PROCESS_CANCELLED: "进程已取消",
    UNMAPPED_ERROR: "执行失败，后端未映射具体错误",
};
export function isWorkspaceJobErrorCode(
    code: string | null | undefined,
): code is WorkspaceJobErrorCode {
    return (
        typeof code === "string" && (WORKSPACE_JOB_ERROR_CODES as readonly string[]).includes(code)
    );
}
export function workspaceJobErrorReason(error: unknown): string {
    if (error instanceof ApiError) {
        if (isWorkspaceJobErrorCode(error.problem.code)) {
            return WORKSPACE_JOB_ERROR_REASONS[error.problem.code];
        }
        return error.problem.detail || error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
export const WORKSPACE_PREFLIGHT_ERROR_CODES = [
    "INVALID_STORAGE_MODE",
    "INVALID_EXECUTION_MODE",
    "INVALID_HOST_PATH",
    "RUNTIME_UNAVAILABLE",
] as const;
export type WorkspacePreflightErrorCode = (typeof WORKSPACE_PREFLIGHT_ERROR_CODES)[number];
export const EXECUTION_MODE_SWITCH_PROBE_CODES = [
    "DIRECT_ATTACH_UNAVAILABLE",
    "DIRECT_ATTACH_PROBE_FAILED",
    "RUNTIME_UNAVAILABLE",
] as const;
export function isExecutionModeSwitchProbeFailure(code: string | null | undefined): boolean {
    return (
        typeof code === "string" &&
        (EXECUTION_MODE_SWITCH_PROBE_CODES as readonly string[]).includes(code)
    );
}
