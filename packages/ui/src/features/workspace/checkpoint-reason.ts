/**
 * Shared checkpoint reason mapping (BL-119).
 *
 * Known capture/durable reasons get a localized label. Unknown or missing
 * reasons fall back to a generic label; the raw code is only exposed as a
 * non-visible `title` for diagnostics.
 */
const REASON_KEYS: Record<string, string> = {
    UNAVAILABLE: "chat.checkpointReasonUnavailable",
    INVALID_REQUEST: "chat.checkpointReasonInvalidRequest",
    GIT_UNAVAILABLE: "chat.checkpointReasonGitUnavailable",
    GIT_TOO_OLD: "chat.checkpointReasonGitTooOld",
    GIT_FAILED: "chat.checkpointReasonGitFailed",
    WORKSPACE_UNKNOWN: "chat.checkpointReasonWorkspaceUnknown",
    NESTED_REPO_LIMIT: "chat.checkpointReasonNestedRepoLimit",
    EXPIRED: "chat.checkpointReasonExpired",
};

export function checkpointReasonKey(reason: string | null | undefined): string {
    return (reason && REASON_KEYS[reason]) || "chat.checkpointReasonUnavailable";
}

export function isKnownCheckpointReason(reason: string | null | undefined): boolean {
    return Boolean(reason && REASON_KEYS[reason]);
}

/** Raw code for the `title` attribute; only unknown reasons need it. */
export function checkpointReasonTitle(reason: string | null | undefined): string | undefined {
    return reason && !isKnownCheckpointReason(reason) ? reason : undefined;
}
