package com.cc01cc.p.xihe.cp.operation;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationEvent;
import com.cc01cc.p.xihe.cp.entity.OperationExtension;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.SessionOperation;
import com.cc01cc.p.xihe.cp.repository.OperationAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.OperationEventRepository;
import com.cc01cc.p.xihe.cp.repository.OperationExtensionRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionOperationRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Operation Ledger writer/query service (PLAN-281 M1 tasks 1.2/1.3).
 *
 * All state changes follow the persist-before-publish order: conditional
 * durable update first, then an append-only operation_event, then commit.
 * Aggregates are never derived from in-memory counters; sequences are read
 * inside the transaction and idempotency relies on the partial unique
 * indexes frozen in V2__session_operation_ledger.sql.
 */
@Service
public class OperationService {

    private static final Logger logger = LoggerFactory.getLogger(OperationService.class);
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final int SCHEMA_VERSION = 1;
    private static final Map<String, List<String>> OPERATION_TRANSITIONS = Map.of(
            "accepted", List.of("running", "completed", "failed", "cancelled"),
            "running", List.of("waiting_for_approval", "completed", "failed", "cancelled",
                    "interrupted", "ambiguous"),
            // Rejection terminates while waiting; forcing a synthetic
            // waiting -> running hop would fabricate a lifecycle event.
            // completed/failed: a run that was approved (grant consumed) and
            // finished while the aggregate never hopped back to running —
            // the run's own terminal event is the authoritative transition
            // (PLAN-292 C1: otherwise the operation sticks at
            // waiting_for_approval forever after a successful approval).
            "waiting_for_approval", List.of("running", "completed", "failed", "cancelled"));
    private static final Map<String, List<String>> ITEM_TRANSITIONS = Map.of(
            "pending", List.of("running", "cancelled", "aborted", "failed"),
            "running", List.of("waiting_for_approval", "completed", "failed", "aborted",
                    "cancelled", "ambiguous"),
            "waiting_for_approval", List.of("resolving", "cancelled"),
            "resolving", List.of("completed", "failed", "aborted"));

    private final SessionOperationRepository operations;
    private final OperationItemRepository items;
    private final OperationAttemptRepository attempts;
    private final OperationEventRepository events;
    private final OperationExtensionRepository extensions;

    public OperationService(SessionOperationRepository operations,
                            OperationItemRepository items,
                            OperationAttemptRepository attempts,
                            OperationEventRepository events,
                            OperationExtensionRepository extensions) {
        this.operations = operations;
        this.items = items;
        this.attempts = attempts;
        this.events = events;
        this.extensions = extensions;
    }

    public record OperationStartResult(UUID operationId, boolean alreadyRecorded) {}

    /**
     * Resolve the durable root operation for an existing ChatRun. Legacy runs
     * may not have an operation yet, so callers must tolerate a null result.
     */
    @Transactional(readOnly = true)
    public UUID findOperationIdByRunId(String runId) {
        if (runId == null || runId.isBlank()) {
            return null;
        }
        return operations.findByRunId(runId).map(SessionOperation::getId).orElse(null);
    }

    /**
     * Keep ChatRun lifecycle updates best-effort for legacy rows while making
     * all newly-created runs durable in the Operation Ledger.
     */
    @Transactional
    public void transitionOperationForRun(String runId, String targetStatus,
                                           String errorCode, String errorRef) {
        UUID operationId = findOperationIdByRunId(runId);
        if (operationId == null) {
            logger.debug("[LIFECYCLE] service=cp event=operation_missing_for_run runId={} targetStatus={}",
                    runId, targetStatus);
            return;
        }
        try {
            transitionOperation(operationId, targetStatus, errorCode, errorRef);
        } catch (CpApiException e) {
            if ("OPERATION_STATE_CONFLICT".equals(e.getCode())) {
                logger.warn("[LIFECYCLE] service=cp event=operation_transition_ignored runId={} operationId={} targetStatus={} reason={}",
                        runId, operationId, targetStatus, e.getMessage());
                return;
            }
            throw e;
        }
    }

    @Transactional(readOnly = true)
    public OperationItem findLatestOpenItem(UUID operationId, String toolName) {
        if (operationId == null || toolName == null || toolName.isBlank()) {
            return null;
        }
        return items.findFirstByOperationIdAndToolNameAndStatusInOrderByCreatedAtDesc(
                operationId.toString(), toolName, List.of("pending", "running", "waiting_for_approval", "resolving"))
                .orElse(null);
    }

    @Transactional(readOnly = true)
    public OperationItem findItemByApprovalRequestId(String approvalRequestId) {
        if (approvalRequestId == null || approvalRequestId.isBlank()) {
            return null;
        }
        return items.findByApprovalRequestId(approvalRequestId).stream().findFirst().orElse(null);
    }

    @Transactional
    public OperationItem appendApprovalItem(UUID operationId, String approvalRequestId,
                                            String toolName, String argumentsPreview) {
        OperationItem item = appendItem(operationId, approvalRequestId, null, "approval",
                toolName, "agent", argumentsPreview, null, null);
        if (item.getApprovalRequestId() == null) {
            item.setApprovalRequestId(approvalRequestId);
            // Assigned IDs make save() a merge: keep the managed copy so
            // later reads in this transaction observe the same instance.
            item = items.saveAndFlush(item);
        }
        if ("pending".equals(item.getStatus())) {
            transitionItem(item.getId(), "running", "pending", approvalRequestId, null, null);
            transitionItem(item.getId(), "waiting_for_approval", "pending", approvalRequestId, null, null);
        }
        // transitionItem syncs the managed instance, but the reference held
        // here may be detached (merge copy semantics); re-read the durable
        // state before returning.
        return items.findById(item.getId())
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_ITEM_NOT_FOUND",
                        "Operation item not found"));
    }

    @Transactional
    public void resolveApprovalItem(String approvalRequestId, boolean approved) {
        OperationItem item = findItemByApprovalRequestId(approvalRequestId);
        if (item == null || !"waiting_for_approval".equals(item.getStatus())) {
            return;
        }
        transitionItem(item.getId(), "resolving", approved ? "approved" : "rejected",
                approvalRequestId, null, approved ? null : "APPROVAL_REJECTED");
        if (!approved) {
            transitionItem(item.getId(), "failed", "rejected", approvalRequestId, null, "APPROVAL_REJECTED");
        }
    }

    @Transactional
    public OperationStartResult startOperation(String userId, String sessionId, String workspaceId,
                                               String runId, String requestId, String kind,
                                               String source, String actorType, String actorId,
                                               String idempotencyKey, String summary) {
        if (kind == null || kind.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "kind is required");
        }
        if (source == null || source.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "source is required");
        }
        if (actorType == null || actorType.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "actorType is required");
        }
        if (idempotencyKey != null && !idempotencyKey.isBlank() && userId != null && sessionId != null) {
            SessionOperation existing = operations
                    .findByUserIdAndSessionIdAndIdempotencyKey(userId, sessionId, idempotencyKey)
                    .orElse(null);
            if (existing != null) {
                logger.info("[LIFECYCLE] service=cp event=operation_idempotent_hit operationId={} sessionId={}",
                        existing.getId(), sessionId);
                return new OperationStartResult(existing.getId(), true);
            }
        }
        SessionOperation operation = new SessionOperation();
        operation.setId(UUID.randomUUID());
        operation.setUserId(userId);
        operation.setSessionId(sessionId);
        operation.setWorkspaceId(workspaceId);
        operation.setRunId(runId);
        operation.setRequestId(requestId);
        operation.setKind(kind);
        operation.setSource(source);
        operation.setActorType(actorType);
        operation.setActorId(actorId);
        operation.setIdempotencyKey(idempotencyKey);
        operation.setStatus("accepted");
        operation.setStartedAt(Instant.now());
        operation.setSummary(summary);
        try {
            operations.saveAndFlush(operation);
        } catch (DataIntegrityViolationException e) {
            logger.warn("[LIFECYCLE] service=cp event=operation_start_conflict sessionId={} runId={} reason={}",
                    sessionId, runId, e.getMessage());
            String reason = e.getMostSpecificCause() != null ? e.getMostSpecificCause().getMessage() : e.getMessage();
            if (reason != null && reason.contains("uq_session_operations_run")) {
                throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_RUN_CONFLICT",
                        "An operation already exists for this run");
            }
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_IDEMPOTENCY_CONFLICT",
                    "Operation with the same idempotency key already exists");
        }
        appendEvent(operation.getId(), null, null, "operation.started", "accepted", actorType, null);
        logger.info("[LIFECYCLE] service=cp event=operation_started operationId={} kind={} sessionId={} runId={}",
                operation.getId(), kind, sessionId, runId);
        return new OperationStartResult(operation.getId(), false);
    }

    @Transactional
    public void transitionOperation(UUID operationId, String targetStatus,
                                    String errorCode, String errorRef) {
        SessionOperation operation = operations.findById(operationId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                        "Operation not found"));
        if (isTerminal(operation.getStatus())) {
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_STATE_CONFLICT",
                    "Operation is already terminal (" + operation.getStatus() + ")");
        }
        if (!allowedOperationTarget(operation.getStatus(), targetStatus)) {
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_STATE_CONFLICT",
                    "Operation cannot transition from " + operation.getStatus() + " to " + targetStatus);
        }
        int affected = operations.transitionStatus(operationId,
                List.of(operation.getStatus()), targetStatus, errorCode, errorRef,
                isTerminal(targetStatus) ? Instant.now() : null);
        if (affected == 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_STATE_CONFLICT",
                    "Operation concurrently changed state; cannot transition to " + targetStatus);
        }
        // Bulk conditional updates bypass the persistence context; sync the
        // managed entity so later reads in the same transaction see the new
        // state instead of the stale pre-update snapshot.
        operation.setStatus(targetStatus);
        operation.setErrorCode(errorCode);
        operation.setErrorRef(errorRef);
        if (isTerminal(targetStatus)) {
            operation.setFinishedAt(Instant.now());
        }
        appendEvent(operationId, null, null, "operation." + targetStatus, targetStatus,
                operation.getActorType(), null);
        logger.info("[LIFECYCLE] service=cp event=operation_transitioned operationId={} status={}",
                operationId, targetStatus);
    }

    private static boolean allowedOperationTarget(String current, String target) {
        List<String> targets = OPERATION_TRANSITIONS.get(current);
        return targets != null && targets.contains(target);
    }

    @Transactional
    public OperationItem appendItem(UUID operationId, String toolCallId, String parentId,
                                    String kind, String toolName, String source,
                                    String argumentsPreview, String normalizedArgv, String cwd) {
        SessionOperation operation = operations.findById(operationId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                        "Operation not found"));
        if (toolCallId != null && !toolCallId.isBlank()) {
            OperationItem existing = items
                    .findByOperationIdAndToolCallId(operationId.toString(), toolCallId).orElse(null);
            if (existing != null) {
                logger.info("[LIFECYCLE] service=cp event=operation_item_idempotent_hit itemId={} toolCallId={}",
                        existing.getId(), toolCallId);
                return existing;
            }
        }
        OperationItem item = new OperationItem();
        item.setId(UUID.randomUUID());
        item.setOperationId(operationId.toString());
        item.setToolCallId(toolCallId);
        item.setParentItemId(parentId);
        item.setSequence(items.findMaxSequence(operationId.toString()) + 1);
        item.setKind(kind);
        item.setToolName(toolName);
        item.setSource(source);
        item.setStatus("pending");
        item.setArgumentsPreview(argumentsPreview);
        item.setNormalizedArgv(normalizedArgv);
        item.setStartedAt(Instant.now());
        try {
            // Assigned IDs make save() a merge: keep the managed copy.
            item = items.saveAndFlush(item);
        } catch (DataIntegrityViolationException e) {
            logger.warn("[LIFECYCLE] service=cp event=operation_item_conflict operationId={} toolCallId={} reason={}",
                    operationId, toolCallId, e.getMessage());
            if (toolCallId != null && !toolCallId.isBlank()) {
                OperationItem existing = items
                        .findByOperationIdAndToolCallId(operationId.toString(), toolCallId).orElse(null);
                if (existing != null) {
                    return existing;
                }
            }
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_ITEM_CONFLICT",
                    "Operation item conflicts with an existing row");
        }
        appendEvent(operationId, item.getId().toString(), null, "item.created", "pending",
                operation.getActorType(), null);        logger.info("[LIFECYCLE] service=cp event=operation_item_created operationId={} itemId={} toolName={}",
                operationId, item.getId(), toolName);
        return item;
    }

    @Transactional
    public void transitionItem(UUID itemId, String targetStatus, String policyDecision,
                               String approvalRequestId, String resultRef, String errorCode) {
        OperationItem item = items.findById(itemId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_ITEM_NOT_FOUND",
                        "Operation item not found"));
        if (isItemTerminal(item.getStatus())) {
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_STATE_CONFLICT",
                    "Operation item is already terminal (" + item.getStatus() + ")");
        }
        List<String> targets = ITEM_TRANSITIONS.get(item.getStatus());
        if (targets == null || !targets.contains(targetStatus)) {
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_STATE_CONFLICT",
                    "Operation item cannot transition from " + item.getStatus() + " to " + targetStatus);
        }
        int affected = items.transitionStatus(itemId, List.of(item.getStatus()), targetStatus,
                policyDecision, approvalRequestId, resultRef, errorCode,
                isItemTerminal(targetStatus) ? Instant.now() : null);
        if (affected == 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_STATE_CONFLICT",
                    "Operation item concurrently changed state; cannot transition to " + targetStatus);
        }
        // Bulk conditional updates bypass the persistence context; sync the
        // managed entity so a second transition in the same transaction
        // (e.g. pending -> running -> waiting_for_approval for approvals)
        // reads the new state instead of the stale pre-update snapshot.
        item.setStatus(targetStatus);
        item.setPolicyDecision(policyDecision);
        item.setApprovalRequestId(approvalRequestId);
        item.setResultRef(resultRef);
        item.setErrorCode(errorCode);
        if (isItemTerminal(targetStatus)) {
            item.setFinishedAt(Instant.now());
        }
        appendEvent(UUID.fromString(item.getOperationId()), itemId.toString(), null,
                "item." + targetStatus, targetStatus, "system", null);
        logger.info("[LIFECYCLE] service=cp event=operation_item_transitioned itemId={} status={}",
                itemId, targetStatus);
    }

    @Transactional
    public OperationAttempt startAttempt(UUID itemId, String stage, String parentAttemptId,
                                         String module, String requestId) {
        OperationItem item = items.findById(itemId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_ITEM_NOT_FOUND",
                        "Operation item not found"));
        if (requestId != null && !requestId.isBlank()) {
            OperationAttempt existing = attempts.findByItemIdAndStageAndRequestId(
                    itemId.toString(), stage, requestId).orElse(null);
            if (existing != null) {
                logger.info("[LIFECYCLE] service=cp event=operation_attempt_idempotent_hit itemId={} stage={} requestId={} attemptId={}",
                        itemId, stage, requestId, existing.getId());
                return existing;
            }
        }
        OperationAttempt attempt = new OperationAttempt();
        attempt.setId(UUID.randomUUID());
        attempt.setItemId(itemId.toString());
        attempt.setStage(stage);
        attempt.setRetryNo(attempts.findMaxRetryNo(itemId.toString(), stage) + 1);
        attempt.setParentAttemptId(parentAttemptId);
        attempt.setModule(module);
        attempt.setRequestId(requestId);
        attempt.setStatus("started");
        attempt.setStartedAt(Instant.now());
        try {
            attempts.saveAndFlush(attempt);
        } catch (DataIntegrityViolationException e) {
            logger.warn("[LIFECYCLE] service=cp event=operation_attempt_conflict itemId={} stage={} reason={}",
                    itemId, stage, e.getMessage());
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_ATTEMPT_CONFLICT",
                    "Operation attempt conflicts with an existing row");
        }
        appendEvent(UUID.fromString(item.getOperationId()), itemId.toString(), attempt.getId().toString(),
                "attempt.started", "started", "system", null);
        logger.info("[LIFECYCLE] service=cp event=operation_attempt_started itemId={} attemptId={} stage={} retryNo={}",
                itemId, attempt.getId(), stage, attempt.getRetryNo());
        return attempt;
    }

    @Transactional
    public void finishAttempt(UUID attemptId, String targetStatus, Integer httpStatus,
                               String errorCode, String resultRef, Long durationMs) {
        if (!List.of("succeeded", "failed", "timed_out", "cancelled", "unknown")
                .contains(targetStatus)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Unsupported operation attempt terminal status");
        }
        OperationAttempt attempt = attempts.findById(attemptId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_ATTEMPT_NOT_FOUND",
                        "Operation attempt not found"));
        long computed = durationMs != null ? durationMs
                : java.time.Duration.between(attempt.getStartedAt(), Instant.now()).toMillis();
        int affected;
        try {
            affected = attempts.finishStarted(attemptId, targetStatus, httpStatus, errorCode,
                    resultRef, computed, Instant.now());
        } catch (DataAccessException e) {
            logger.error("[LIFECYCLE] service=cp event=operation_attempt_finish_unknown attemptId={} status={}",
                    attemptId, targetStatus, e);
            throw new CpApiException(HttpStatus.SERVICE_UNAVAILABLE,
                    "OPERATION_ATTEMPT_FINISH_UNKNOWN",
                    "Attempt completion could not be durably recorded; execution state is unknown");
        }
        if (affected == 0) {
            OperationAttempt current = attempts.findById(attemptId)
                    .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_ATTEMPT_NOT_FOUND",
                            "Operation attempt not found"));
            if (targetStatus.equals(current.getStatus())
                    && Objects.equals(httpStatus, current.getHttpStatus())
                    && Objects.equals(errorCode, current.getErrorCode())
                    && Objects.equals(resultRef, current.getResultRef())) {
                logger.info("[LIFECYCLE] service=cp event=operation_attempt_finish_idempotent_hit attemptId={} status={}",
                        attemptId, targetStatus);
                return;
            }
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_STATE_CONFLICT",
                    "Operation attempt is not in the started state");
        }
        // Bulk finish bypasses the persistence context; sync the managed
        // entity so later reads in the same transaction see the terminal
        // state instead of the stale "started" snapshot.
        attempt.setStatus(targetStatus);
        attempt.setHttpStatus(httpStatus);
        attempt.setErrorCode(errorCode);
        attempt.setResultRef(resultRef);
        attempt.setDurationMs(computed);
        attempt.setFinishedAt(Instant.now());
        OperationItem item = items.findById(UUID.fromString(attempt.getItemId())).orElse(null);
        appendEvent(item == null ? null : UUID.fromString(item.getOperationId()),
                attempt.getItemId(), attemptId.toString(), "attempt." + targetStatus, targetStatus,
                "system", null);
        logger.info("[LIFECYCLE] service=cp event=operation_attempt_finished attemptId={} status={} durationMs={}",
                attemptId, targetStatus, computed);
    }

    @Transactional
    public void appendExtension(UUID itemId, UUID attemptId, String extensionKind,
                                Integer schemaVersion, String payloadJson) {
        if ((itemId == null && attemptId == null) || (itemId != null && attemptId != null)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Exactly one of itemId or attemptId is required");
        }
        if (schemaVersion == null) {
            schemaVersion = SCHEMA_VERSION;
        }
        OperationExtension existing = itemId != null
                ? extensions.findByItemIdAndExtensionKindAndSchemaVersion(
                        itemId.toString(), extensionKind, schemaVersion).orElse(null)
                : extensions.findByAttemptIdAndExtensionKindAndSchemaVersion(
                        attemptId.toString(), extensionKind, schemaVersion).orElse(null);
        if (existing != null) {
            if (sameJsonPayload(existing.getPayload(), payloadJson)) {
                logger.info("[LIFECYCLE] service=cp event=operation_extension_idempotent_hit itemId={} attemptId={} kind={} schemaVersion={}",
                        itemId, attemptId, extensionKind, schemaVersion);
                return;
            }
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_EXTENSION_CONFLICT",
                    "An extension of this kind and schema version already exists with different payload");
        }
        OperationExtension extension = new OperationExtension(
                itemId == null ? null : itemId.toString(),
                attemptId == null ? null : attemptId.toString(),
                extensionKind, schemaVersion, payloadJson);
        extension.setId(UUID.randomUUID());
        try {
            extensions.saveAndFlush(extension);
        } catch (DataIntegrityViolationException e) {
            logger.warn("[LIFECYCLE] service=cp event=operation_extension_conflict itemId={} attemptId={} kind={} reason={}",
                    itemId, attemptId, extensionKind, e.getMessage());
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_EXTENSION_CONFLICT",
                    "An extension of this kind and schema version already exists for the target");
        }
        logger.info("[LIFECYCLE] service=cp event=operation_extension_appended itemId={} attemptId={} kind={}",
                itemId, attemptId, extensionKind);
    }

    private static boolean sameJsonPayload(String left, String right) {
        if (Objects.equals(left, right)) {
            return true;
        }
        try {
            return OBJECT_MAPPER.readTree(left).equals(OBJECT_MAPPER.readTree(right));
        } catch (JsonProcessingException | RuntimeException e) {
            return false;
        }
    }

    @Transactional(readOnly = true)
    public Page<SessionOperation> listUserOperations(String userId, String sessionId,
                                                     String workspaceId, String status,
                                                     Pageable pageable) {
        return operations.searchByUserId(userId, sessionId, workspaceId, status, pageable);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> getOperationTrace(UUID operationId) {
        SessionOperation operation = operations.findById(operationId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                        "Operation not found"));
        List<OperationItem> operationItems = items.findByOperationIdOrderBySequenceAsc(operationId.toString());
        List<OperationAttempt> operationAttempts = new ArrayList<>();
        for (OperationItem item : operationItems) {
            operationAttempts.addAll(attempts.findByItemIdOrderByStartedAtAsc(item.getId().toString()));
        }
        List<OperationEvent> operationEvents = events.findByOperationIdOrderBySequenceAsc(operationId.toString());
        Map<String, Object> trace = new LinkedHashMap<>();
        trace.put("operation", operation);
        trace.put("items", operationItems);
        trace.put("attempts", operationAttempts);
        trace.put("events", operationEvents);
        return trace;
    }

    @Transactional(readOnly = true)
    public SessionOperation requireOwnedOperation(UUID operationId, String userId) {
        SessionOperation operation = operations.findById(operationId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                        "Operation not found"));
        if (userId == null || !userId.equals(operation.getUserId())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                    "Operation not found");
        }
        return operation;
    }

    private void appendEvent(UUID operationId, String itemId, String attemptId,
                             String eventType, String state, String actor, String payload) {
        Long sequence = events.findByOperationIdOrderBySequenceAsc(operationId.toString()).stream()
                .mapToLong(OperationEvent::getSequence)
                .max()
                .orElse(-1L) + 1;
        OperationEvent event = new OperationEvent(operationId.toString(), sequence, eventType,
                state, actor, payload);
        event.setId(UUID.randomUUID());
        event.setItemId(itemId);
        event.setAttemptId(attemptId);
        try {
            events.saveAndFlush(event);
        } catch (DataIntegrityViolationException e) {
            logger.warn("[LIFECYCLE] service=cp event=operation_event_conflict operationId={} sequence={} reason={}",
                    operationId, sequence, e.getMessage());
            throw new CpApiException(HttpStatus.CONFLICT, "OPERATION_EVENT_CONFLICT",
                    "Operation event sequence conflicts with an existing row");
        }
    }

    private static boolean isTerminal(String status) {
        return "completed".equals(status) || "failed".equals(status) || "cancelled".equals(status)
                || "interrupted".equals(status) || "ambiguous".equals(status);
    }

    private static boolean isItemTerminal(String status) {
        return "completed".equals(status) || "failed".equals(status) || "aborted".equals(status)
                || "cancelled".equals(status) || "ambiguous".equals(status);
    }
}
