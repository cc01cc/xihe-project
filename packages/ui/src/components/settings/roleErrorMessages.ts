import { ApiError } from "../../composables/api";
import { withErrorCode } from "../../lib/errorMessages";

/**
 * Grant-preset/binding error copy: **localized copy + stable code**（`文案（CODE）`）。
 *
 * <p>task-855 收口：BL-288 的 detail-first 口径已撤销 — CP 的 `Problem.detail` 可能是英文原文，
 * 只能进日志/诊断，不能当用户主文案。这里统一返回本地化映射文案，并附上稳定错误码供支持引用。</p>
 *
 * <p>The four codes the wave explicitly requires are the first four; the rest exist because the CP
 * can answer them on the same endpoints and a generic fallback would hide the reason.</p>
 *
 * <p>PLAN-0651 V17 B4: `AGENT_PRINCIPAL_FORBIDDEN_ATOMS` 的 `detail` 是未本地化的原子清单，
 * 因此它同样只能走本地化文案（现在所有码都走本地化文案，这条只是保留语义说明）。</p>
 */
export type PresetErrorKey =
    | "presetScopeMismatch"
    | "privilegeEscalation"
    | "lastSuperAdmin"
    | "concurrentModification"
    | "presetInUse"
    | "systemPresetImmutable"
    | "presetNameExists"
    | "presetNotFound"
    | "invalidPresetName"
    | "invalidPresetAtoms"
    /**
     * task-81 / task-126：`resource` 前缀不合法（400 INVALID_GRANT_RESOURCE）。CP 的 detail 会点名
     * 具体原子与原因，按 BL-288 走 detail-first；这条只是 detail 缺失时的兜底。
     */
    | "invalidGrantResource"
    | "invalidScope"
    | "workspaceNotFound"
    | "invalidBinding"
    | "userDeleted"
    | "userNotFound"
    | "forbidden"
    | "agentPresetForbiddenAtoms"
    | "lockTimeout"
    | "generic";

const CODE_TO_KEY: Record<string, PresetErrorKey> = {
    ROLE_SCOPE_MISMATCH: "presetScopeMismatch",
    PRIVILEGE_ESCALATION: "privilegeEscalation",
    LAST_SUPER_ADMIN: "lastSuperAdmin",
    CONCURRENT_MODIFICATION: "concurrentModification",
    ROLE_IN_USE: "presetInUse",
    SYSTEM_ROLE_IMMUTABLE: "systemPresetImmutable",
    ROLE_NAME_EXISTS: "presetNameExists",
    ROLE_NOT_FOUND: "presetNotFound",
    INVALID_ROLE_NAME: "invalidPresetName",
    INVALID_ROLE_ATOMS: "invalidPresetAtoms",
    INVALID_GRANT_RESOURCE: "invalidGrantResource",
    INVALID_SCOPE: "invalidScope",
    WORKSPACE_NOT_FOUND: "workspaceNotFound",
    INVALID_BINDING: "invalidBinding",
    USER_DELETED: "userDeleted",
    USER_NOT_FOUND: "userNotFound",
    FORBIDDEN: "forbidden",
    AUTHORIZATION_REQUIRED: "forbidden",
    AGENT_PRINCIPAL_FORBIDDEN_ATOMS: "agentPresetForbiddenAtoms",
    OPERATION_LOCK_TIMEOUT: "lockTimeout",
};

export function presetErrorKey(cause: unknown): PresetErrorKey {
    if (cause instanceof ApiError && cause.problem?.code) {
        return CODE_TO_KEY[cause.problem.code] ?? "generic";
    }
    return "generic";
}

/** `t` is passed in so this stays a pure function (no composable coupling, trivially testable). */
export function presetErrorMessage(cause: unknown, t: (key: string) => string): string {
    const key = presetErrorKey(cause);
    const code = cause instanceof ApiError ? cause.problem?.code : undefined;
    // 一律本地化文案 + 码；CP 的英文 detail 只在调用方进 logger，不回到用户面。
    return withErrorCode(t(`settings.presetsError.${key}`), code);
}
