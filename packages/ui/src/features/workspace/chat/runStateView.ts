import type { ChatRunResponse } from "../../../types";

/**
 * PLAN-0631 D31-01: the **single** presentation projection for a Run's status.
 *
 * UI already carries six status vocabularies (`ChatRunResponse` 12 values,
 * `ChatSessionRunState` 5 local values, `Message.runStatus`, `monitor.status`,
 * `chat.followUpStatus`, `settings.auditStatusLabels`). This module is the one place
 * where a wire status turns into "how attention-worthy is this" + "which existing copy
 * do we show" — new surfaces must go through it instead of writing their own `if`s
 * (N10: one semantic, one resolver).
 *
 * Zero new status names, zero new colors: every label key below already exists in both
 * locales except `chat.runState.awaitingApproval` (the one gap: the chat column had no
 * neutral wording for it).
 */
export type RunStateTier = "active" | "needs-human" | "stopping" | "terminal";

const TIERS: Record<ChatRunResponse["status"], RunStateTier> = {
    accepted: "active",
    queued: "active",
    dispatching: "active",
    running: "active",
    streaming: "active",
    awaiting_approval: "needs-human",
    cancelling: "stopping",
    succeeded: "terminal",
    failed: "terminal",
    partial: "terminal",
    ambiguous: "terminal",
    cancelled: "terminal",
};

/**
 * Existing copy may be shown for each status. Terminal values deliberately reuse the
 * follow-up-queue wording (`chat.followUpStatus*`) because that is the only place the
 * user has already seen these states rendered inside the chat column.
 */
const LABEL_KEYS: Record<ChatRunResponse["status"], string> = {
    accepted: "chat.derivedStateStatus.accepted",
    queued: "chat.runState.queued",
    dispatching: "chat.derivedStateStatus.dispatching",
    running: "chat.derivedStateStatus.running",
    streaming: "chat.derivedStateStatus.streaming",
    awaiting_approval: "chat.runState.awaitingApproval",
    cancelling: "chat.derivedStateStatus.cancelling",
    succeeded: "chat.followUpStatusCompleted",
    failed: "chat.followUpStatusFailed",
    partial: "chat.derivedStateOutcome.partial",
    ambiguous: "chat.followUpStatusAmbiguous",
    cancelled: "chat.followUpStatusCancelled",
};

function isKnownStatus(status: string): status is ChatRunResponse["status"] {
    // `Object.hasOwn` is not in this package's `lib` target; hasOwnProperty.call is.
    return Object.prototype.hasOwnProperty.call(TIERS, status);
}

/** Attention tier, or `null` for a status this UI does not know (never guessed). */
export function runStateTier(status: string | undefined | null): RunStateTier | null {
    return status && isKnownStatus(status) ? TIERS[status] : null;
}

/** i18n key for the status label, or `null` when unknown (caller shows the raw value). */
export function runStateLabelKey(status: string | undefined | null): string | null {
    return status && isKnownStatus(status) ? LABEL_KEYS[status] : null;
}
