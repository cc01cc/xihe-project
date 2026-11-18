import type {
    ChatRunResponse,
    SessionDerivedActiveStatus,
    SessionDerivedTerminalState,
} from "../../../types";

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

/**
 * PLAN-0631 M1-C: is this run over? Derived from the same tier table, so a future status
 * cannot become "terminal" in one place and stay active in another. Unknown/absent is
 * **not** terminal — callers must not retire UI for a state they do not recognise.
 */
export function isTerminalRunStatus(status: string | undefined | null): boolean {
    return runStateTier(status) === "terminal";
}

/** The two end states that get a visible row-end chip (D31-02: success is silent). */
export type TerminalMarker = "partial" | "cancelled";

/**
 * PLAN-0631 M1-C / BL-406: which terminal chip (if any) a run earns, from the wire status
 * plus the terminal outcome. Kept here so the message row and the collapsed run shell
 * cannot disagree about which runs are marked.
 *
 * Deliberately only these two:
 *  - `succeeded` stays silent (no news is good news, D31-02);
 *  - `failed` / `ambiguous` already have the error box + recovery banner (D31-02/05).
 */
export function terminalMarkerOf(
    status: string | undefined | null,
    terminalOutcome: string | undefined | null,
): TerminalMarker | null {
    if (status === "partial" || terminalOutcome === "partial") return "partial";
    if (status === "cancelled" || terminalOutcome === "cancelled") return "cancelled";
    return null;
}

/**
 * task-1 / D-1846：**「要不要染红」也只有一个解析器**。
 *
 * 派生态 anchor 与 run 头（`RunGroupHeader` 的 `data-failed`）都得回答同一个问题：这个状态
 * 是「失败/取消」吗？判据留在本模块 ⇒ 以后新增终态词只会在这里被考虑一次
 * （组件里出现 `status === "failed"` 就是 N10 的违规形态）。
 */
export function runStateIsFailure(status: string | undefined | null): boolean {
    return status === "failed" || status === "cancelled";
}

/**
 * task-1 / D-1846（派生态 anchor）：derived-state 的**两套**词表 → 冻结的 wire 状态词表。
 *
 * derived-state 给的是两条轴：在途词（`activeChildren[].status`，7 值）与终态词
 * （`terminalNotices[].state`，5 值）。其中 7 个在途词与 `partial`/`ambiguous`/`cancelled`
 * 恰好就是 `ChatRunResponse["status"]` 的成员；`success`/`error` 是终态轴自己的说法。
 *
 * 映射放在**这里**（而不是调用方）是 N10 的要求：否则每个消费者都要写一遍
 * `if (state === "error") …`，那正是「一个语义、N 个解析器」。返回值只会是既有 12 个 wire
 * 状态之一（`succeeded`/`failed` 是映射目标，不是新词）。
 *
 * 未知/缺失 ⇒ `null`：调用方据此**不渲染状态**，绝不猜成 `running`（同 A2「不可见 ≠ 无变化」）。
 */
function terminalToWire(terminal: SessionDerivedTerminalState): ChatRunResponse["status"] | null {
    switch (terminal) {
        case "success":
            return "succeeded";
        case "error":
            return "failed";
        case "partial":
            return "partial";
        case "ambiguous":
            return "ambiguous";
        case "cancelled":
            return "cancelled";
        default:
            // 运行期可能是本 UI 不认识的新终态词 ⇒ 不猜（调用方据此不渲染状态）。
            return null;
    }
}

export function runStatusOfDerivedChild(
    active: SessionDerivedActiveStatus | null | undefined,
    terminal: SessionDerivedTerminalState | null | undefined,
): ChatRunResponse["status"] | null {
    if (active && isKnownStatus(active)) return active;
    if (terminal) return terminalToWire(terminal);
    return null;
}
