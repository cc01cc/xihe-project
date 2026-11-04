import { ApiError } from "../../composables/api";
import { problemDetailText } from "../../lib/errorMessages";

/**
 * Role/binding error copy. PLAN-0610 W5b originally **never** echoed the CP's English `detail`;
 * BL-288 (2026-11-05) overrides that for actionable problems: when the Problem carries a `detail`
 * (e.g. `ROLE_BINDING_EXCEEDS_CAP` names the offending cap), the user must see it — the localized
 * mapped copy is only the fallback when there is no detail. The code is still logged by callers.
 *
 * <p>The four codes the wave explicitly requires are the first four; the rest exist because the CP
 * can answer them on the same endpoints and a generic fallback would hide the reason.</p>
 */
export type RoleErrorKey =
    | "roleScopeMismatch"
    | "privilegeEscalation"
    | "lastSuperAdmin"
    | "concurrentModification"
    | "roleInUse"
    | "systemRoleImmutable"
    | "roleNameExists"
    | "roleNotFound"
    | "invalidRoleName"
    | "invalidRoleAtoms"
    | "invalidScope"
    | "workspaceNotFound"
    | "invalidBinding"
    | "userDeleted"
    | "userNotFound"
    | "forbidden"
    | "lockTimeout"
    | "generic";

const CODE_TO_KEY: Record<string, RoleErrorKey> = {
    ROLE_SCOPE_MISMATCH: "roleScopeMismatch",
    PRIVILEGE_ESCALATION: "privilegeEscalation",
    LAST_SUPER_ADMIN: "lastSuperAdmin",
    CONCURRENT_MODIFICATION: "concurrentModification",
    ROLE_IN_USE: "roleInUse",
    SYSTEM_ROLE_IMMUTABLE: "systemRoleImmutable",
    ROLE_NAME_EXISTS: "roleNameExists",
    ROLE_NOT_FOUND: "roleNotFound",
    INVALID_ROLE_NAME: "invalidRoleName",
    INVALID_ROLE_ATOMS: "invalidRoleAtoms",
    INVALID_SCOPE: "invalidScope",
    WORKSPACE_NOT_FOUND: "workspaceNotFound",
    INVALID_BINDING: "invalidBinding",
    USER_DELETED: "userDeleted",
    USER_NOT_FOUND: "userNotFound",
    FORBIDDEN: "forbidden",
    AUTHORIZATION_REQUIRED: "forbidden",
    OPERATION_LOCK_TIMEOUT: "lockTimeout",
};

export function roleErrorKey(cause: unknown): RoleErrorKey {
    if (cause instanceof ApiError && cause.problem?.code) {
        return CODE_TO_KEY[cause.problem.code] ?? "generic";
    }
    return "generic";
}

/** `t` is passed in so this stays a pure function (no composable coupling, trivially testable). */
export function roleErrorMessage(cause: unknown, t: (key: string) => string): string {
    // BL-288：可行动 detail（超限原子名/条数/上限）优先；无 detail 才回退本地化通用文案。
    const detail = problemDetailText(cause, "");
    if (detail) return detail;
    return t(`settings.rolesError.${roleErrorKey(cause)}`);
}
