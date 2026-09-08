package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationEvent;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.SessionOperation;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Redacted projections shared by the user and internal operation APIs.
 * User views never include error_ref/result_ref/arguments_preview; internal
 * trace views include references but never artifact contents.
 */
final class OperationViews {

    private OperationViews() {}

    static Map<String, Object> toUserTrace(Map<String, Object> trace) {
        SessionOperation operation = (SessionOperation) trace.get("operation");
        @SuppressWarnings("unchecked")
        List<OperationItem> items = (List<OperationItem>) trace.get("items");
        @SuppressWarnings("unchecked")
        List<OperationAttempt> attempts = (List<OperationAttempt>) trace.get("attempts");
        @SuppressWarnings("unchecked")
        List<OperationEvent> events = (List<OperationEvent>) trace.get("events");
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("operation", OperationController.toSummary(operation));
        view.put("items", items.stream().map(OperationViews::toUserItem).toList());
        view.put("attempts", attempts.stream().map(OperationViews::toAttempt).toList());
        view.put("events", events.stream().map(OperationViews::toEvent).toList());
        return view;
    }

    static Map<String, Object> toInternalTrace(Map<String, Object> trace) {
        SessionOperation operation = (SessionOperation) trace.get("operation");
        @SuppressWarnings("unchecked")
        List<OperationItem> items = (List<OperationItem>) trace.get("items");
        @SuppressWarnings("unchecked")
        List<OperationAttempt> attempts = (List<OperationAttempt>) trace.get("attempts");
        @SuppressWarnings("unchecked")
        List<OperationEvent> events = (List<OperationEvent>) trace.get("events");
        Map<String, Object> operationView = new LinkedHashMap<>();
        operationView.put("id", operation.getId().toString());
        operationView.put("sessionId", operation.getSessionId());
        operationView.put("workspaceId", operation.getWorkspaceId());
        operationView.put("userId", operation.getUserId());
        operationView.put("runId", operation.getRunId());
        operationView.put("requestId", operation.getRequestId());
        operationView.put("kind", operation.getKind());
        operationView.put("source", operation.getSource());
        operationView.put("actorType", operation.getActorType());
        operationView.put("actorId", operation.getActorId());
        operationView.put("status", operation.getStatus());
        operationView.put("idempotencyKey", operation.getIdempotencyKey());
        operationView.put("summary", operation.getSummary());
        operationView.put("errorCode", operation.getErrorCode());
        operationView.put("errorRef", operation.getErrorRef());
        operationView.put("startedAt", operation.getStartedAt() == null ? null : operation.getStartedAt().toString());
        operationView.put("finishedAt", operation.getFinishedAt() == null ? null : operation.getFinishedAt().toString());
        operationView.put("createdAt", operation.getCreatedAt() == null ? null : operation.getCreatedAt().toString());
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("operation", operationView);
        view.put("items", items.stream().map(OperationViews::toInternalItem).toList());
        view.put("attempts", attempts.stream().map(OperationViews::toInternalAttempt).toList());
        view.put("events", events.stream().map(OperationViews::toEvent).toList());
        return view;
    }

    private static Map<String, Object> toUserItem(OperationItem item) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", item.getId().toString());
        view.put("operationId", item.getOperationId());
        view.put("toolCallId", item.getToolCallId());
        view.put("parentItemId", item.getParentItemId());
        view.put("sequence", item.getSequence());
        view.put("kind", item.getKind());
        view.put("toolName", item.getToolName());
        view.put("source", item.getSource());
        view.put("policyDecision", item.getPolicyDecision());
        view.put("approvalRequestId", item.getApprovalRequestId());
        view.put("status", item.getStatus());
        view.put("errorCode", item.getErrorCode());
        view.put("startedAt", item.getStartedAt() == null ? null : item.getStartedAt().toString());
        view.put("finishedAt", item.getFinishedAt() == null ? null : item.getFinishedAt().toString());
        return view;
    }

    private static Map<String, Object> toInternalItem(OperationItem item) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", item.getId().toString());
        view.put("operationId", item.getOperationId());
        view.put("toolCallId", item.getToolCallId());
        view.put("parentItemId", item.getParentItemId());
        view.put("sequence", item.getSequence());
        view.put("kind", item.getKind());
        view.put("toolName", item.getToolName());
        view.put("source", item.getSource());
        view.put("policyDecision", item.getPolicyDecision());
        view.put("approvalRequestId", item.getApprovalRequestId());
        view.put("status", item.getStatus());
        view.put("resultRef", item.getResultRef());
        view.put("errorCode", item.getErrorCode());
        view.put("argumentsPreview", item.getArgumentsPreview());
        view.put("cwd", item.getCwd());
        view.put("startedAt", item.getStartedAt() == null ? null : item.getStartedAt().toString());
        view.put("finishedAt", item.getFinishedAt() == null ? null : item.getFinishedAt().toString());
        return view;
    }

    private static Map<String, Object> toAttempt(OperationAttempt attempt) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", attempt.getId().toString());
        view.put("itemId", attempt.getItemId());
        view.put("stage", attempt.getStage());
        view.put("retryNo", attempt.getRetryNo());
        view.put("parentAttemptId", attempt.getParentAttemptId());
        view.put("module", attempt.getModule());
        view.put("status", attempt.getStatus());
        view.put("errorCode", attempt.getErrorCode());
        view.put("durationMs", attempt.getDurationMs());
        view.put("startedAt", attempt.getStartedAt() == null ? null : attempt.getStartedAt().toString());
        view.put("finishedAt", attempt.getFinishedAt() == null ? null : attempt.getFinishedAt().toString());
        return view;
    }

    private static Map<String, Object> toInternalAttempt(OperationAttempt attempt) {
        Map<String, Object> view = toAttempt(attempt);
        view.put("httpStatus", attempt.getHttpStatus());
        view.put("resultRef", attempt.getResultRef());
        return view;
    }

    private static Map<String, Object> toEvent(OperationEvent event) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", event.getId().toString());
        view.put("operationId", event.getOperationId());
        view.put("itemId", event.getItemId());
        view.put("attemptId", event.getAttemptId());
        view.put("sequence", event.getSequence());
        view.put("eventType", event.getEventType());
        view.put("state", event.getState());
        view.put("actor", event.getActor());
        view.put("schemaVersion", event.getSchemaVersion());
        view.put("createdAt", event.getCreatedAt() == null ? null : event.getCreatedAt().toString());
        return view;
    }
}
