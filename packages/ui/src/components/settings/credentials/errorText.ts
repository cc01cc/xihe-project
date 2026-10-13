import { ApiError } from "../../../composables/api";

/**
 * PLAN-0498: maps credential API failures onto user-readable text.
 * 401/403/404/409/422 are domain outcomes the credential dialogs surface inline.
 */
export function credentialErrorText(error: unknown, t: (key: string) => string): string {
    if (error instanceof ApiError) {
        const status = error.problem.status;
        if (status === 401) return t("credentials.errUnauthorized");
        if (status === 403) return t("credentials.errForbidden");
        if (status === 404) return t("credentials.errNotFound");
        if (status === 409) return t("credentials.errConflict");
        if (status === 422) return t("credentials.errUnprocessable");
        return error.problem.detail || error.problem.code || t("credentials.errGeneric");
    }
    return error instanceof Error ? error.message : t("credentials.errGeneric");
}

/**
 * PLAN-0498 T3.1: reveal failures are domain outcomes (wrong step-up password,
 * rate limit, tier/status gates) — they stay inline in the reveal dialog.
 */
export function credentialRevealErrorText(error: unknown, t: (key: string) => string): string {
    if (error instanceof ApiError) {
        const { status, code } = error.problem;
        if (code === "CREDENTIAL_REVEAL_STEP_UP_FAILED")
            return t("credentials.revealWrongPassword");
        if (code === "CREDENTIAL_REVEAL_RATE_LIMITED") return t("credentials.revealRateLimited");
        if (code === "CREDENTIAL_DISABLED") return t("credentials.revealDisabled");
        if (code === "CREDENTIAL_TIER_MISMATCH") return t("credentials.revealTierMismatch");
        if (status === 401) return t("credentials.revealWrongPassword");
        if (status === 403) return t("credentials.errForbidden");
        if (status === 404) return t("credentials.errNotFound");
        return error.problem.detail || code || t("credentials.errGeneric");
    }
    return error instanceof Error ? error.message : t("credentials.errGeneric");
}
