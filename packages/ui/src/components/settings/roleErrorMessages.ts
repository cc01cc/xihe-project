import { ApiError } from "../../composables/api";

/**
 * PLAN-0610 W5b: the role/binding surfaces map the CP Problem code to localized copy and **never**
 * echo the server's English `detail` (the same rule the principal-grant page follows, and the rule
 * that lets the backend reword a message without breaking the UI).
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
    return t(`settings.rolesError.${roleErrorKey(cause)}`);
}
