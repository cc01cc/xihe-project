package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.entity.ApprovalHistory;
import com.cc01cc.p.xihe.cp.entity.ChatRunHistory;
import com.cc01cc.p.xihe.cp.entity.McpAttempt;
import com.cc01cc.p.xihe.cp.entity.McpDispatchHistory;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJobHistory;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0466 T1.2/T2.2: whitelist projections for the audit read views — the ported
 * equivalent of {@code OperationViews} for the four-domain read model.
 *
 * <p>Field boundary (spec/security/audit.md §3, PLAN-0466 T2.2): no prompt, no
 * credential, no raw arguments in either tier. The user tier never emits
 * {@code userId} / {@code idempotencyKey} / {@code requestId} / {@code runtimeJobId}
 * / {@code resultRef} / {@code httpStatus}; the internal tier adds exactly those
 * and nothing else. Every method builds its map key-by-key, so a column that is not
 * listed here cannot leak into a response.</p>
 */
public final class AuditViews {

    private AuditViews() {}

    // ---------------------------------------------------------------------
    // Entry projections (list rows and detail entry object)
    // ---------------------------------------------------------------------

    /** User tier of one VIEW row: scope, status/summary, timestamps, correlation ids. */
    public static Map<String, Object> toUserEntry(AuditEntryRow row) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("type", row.type());
        view.put("id", row.entryId() == null ? null : row.entryId().toString());
        view.put("sessionId", uuid(row.sessionId()));
        view.put("workspaceId", uuid(row.workspaceId()));
        view.put("runId", uuid(row.runId()));
        view.put("status", row.status());
        view.put("summary", row.summary());
        view.put("source", row.source());
        view.put("errorCode", row.errorCode());
        view.put("scope", row.scope());
        view.put("cancelReason", row.cancelReason());
        view.put("toolCallId", uuid(row.toolCallId()));
        view.put("approvalRequestId", uuid(row.approvalRequestId()));
        view.put("terminalOutcome", row.terminalOutcome());
        view.put("createdAt", instant(row.createdAt()));
        view.put("startedAt", instant(row.startedAt()));
        view.put("finishedAt", instant(row.finishedAt()));
        return view;
    }

    /** Internal tier: user tier + the ported toInternalTrace identity/correlation keys. */
    public static Map<String, Object> toInternalEntry(AuditEntryRow row) {
        Map<String, Object> view = toUserEntry(row);
        view.put("userId", uuid(row.userId()));
        view.put("idempotencyKey", row.idempotencyKey());
        view.put("requestId", uuid(row.requestId()));
        view.put("runtimeJobId", row.runtimeJobId());
        return view;
    }

    // ---------------------------------------------------------------------
    // Timeline projections (one per history table; payload TEXT is never projected)
    // ---------------------------------------------------------------------

    /** chat_run_history → uniform timeline event. */
    public static Map<String, Object> toTimeline(ChatRunHistory history) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("sequence", history.getSequence());
        event.put("eventType", history.getEventType());
        event.put("fromStatus", history.getFromStatus());
        event.put("toStatus", history.getToStatus());
        event.put("actorType", history.getActorType());
        event.put("terminalOutcome", history.getTerminalOutcome());
        event.put("errorCode", history.getErrorCode());
        event.put("createdAt", instant(history.getCreatedAt()));
        return event;
    }

    /** workspace_job_history → uniform timeline event. */
    public static Map<String, Object> toTimeline(WorkspaceJobHistory history) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("sequence", history.getSequence());
        event.put("eventType", history.getEventType());
        event.put("fromStatus", history.getFromStatus());
        event.put("toStatus", history.getToStatus());
        event.put("cancelReason", history.getCancelReason());
        event.put("errorCode", history.getErrorCode());
        event.put("createdAt", instant(history.getCreatedAt()));
        return event;
    }

    /** mcp_dispatch_history → uniform timeline event. */
    public static Map<String, Object> toTimeline(McpDispatchHistory history) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("sequence", history.getSequence());
        event.put("eventType", history.getEventType());
        event.put("fromStatus", history.getFromStatus());
        event.put("toStatus", history.getToStatus());
        event.put("actorType", history.getActorType());
        event.put("attemptId", uuid(history.getAttemptId()));
        event.put("createdAt", instant(history.getCreatedAt()));
        return event;
    }

    /** approval_history (from_state/to_state → fromStatus/toStatus) → uniform event. */
    public static Map<String, Object> toTimeline(ApprovalHistory history) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("sequence", history.getSequence());
        event.put("eventType", history.getEventType());
        event.put("fromStatus", history.getFromState());
        event.put("toStatus", history.getToState());
        event.put("actorType", history.getActorType());
        event.put("approved", history.getApproved());
        event.put("decisionKind", history.getDecisionKind());
        event.put("createdAt", instant(history.getCreatedAt()));
        return event;
    }

    // ---------------------------------------------------------------------
    // Attempt projections (mcp_invocations detail only)
    // ---------------------------------------------------------------------

    /** User tier attempt: no httpStatus, no resultRef (OperationViews.toAttempt parity). */
    public static Map<String, Object> toUserAttempt(McpAttempt attempt) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", attempt.getId() == null ? null : attempt.getId().toString());
        view.put("invocationId", uuid(attempt.getInvocationId()));
        view.put("stage", attempt.getStage());
        view.put("retryNo", attempt.getRetryNo());
        view.put("module", attempt.getModule());
        view.put("status", attempt.getStatus());
        view.put("errorCode", attempt.getErrorCode());
        view.put("durationMs", attempt.getDurationMs());
        view.put("startedAt", instant(attempt.getStartedAt()));
        view.put("finishedAt", instant(attempt.getFinishedAt()));
        return view;
    }

    /** Internal tier attempt: user tier + httpStatus + resultRef reference. */
    public static Map<String, Object> toInternalAttempt(McpAttempt attempt) {
        Map<String, Object> view = toUserAttempt(attempt);
        view.put("httpStatus", attempt.getHttpStatus());
        view.put("resultRef", attempt.getResultRef());
        return view;
    }

    private static String uuid(UUID value) {
        return value == null ? null : value.toString();
    }

    /** ISO-8601 with {@code Z}, matching every other CP instant projection. */
    private static String instant(Instant value) {
        return value == null ? null : value.toString();
    }
}
