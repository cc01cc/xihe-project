package com.cc01cc.p.xihe.cp.operation;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationEvent;
import com.cc01cc.p.xihe.cp.entity.OperationExtension;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.LedgerOperation;
import com.cc01cc.p.xihe.cp.repository.OperationAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.OperationEventRepository;
import com.cc01cc.p.xihe.cp.repository.OperationExtensionRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Propagation;

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
            // 2026-09-13 E2E（V11）：pending → completed 用于"写完即完成"的记录型
            // 条目（llm_usage），避免为它伪造 running 生命周期或残留 pending。
            // 0346 (gap D)：aborted 对所有活动态开放——reconcileStaleOperation
            // 对 running/waiting/resolving 的收敛此前必抛 STATE_CONFLICT 被吞，
            // item 永远停 in running（测试 reconcileStaleOperation_settlesRows...
            // 实证），修 transition 表而非让对账绕过守卫。
            "pending", List.of("running", "completed", "cancelled", "aborted", "failed"),
            "running", List.of("waiting_for_approval", "completed", "failed", "aborted",
                    "cancelled", "ambiguous"),
            "waiting_for_approval", List.of("running", "resolving", "completed", "failed",
                    "aborted", "cancelled"),
            // 2026-09-13 E2E（决策 #8 补充）：审批通过后的派发窗口 item 处于
            // resolving，此刻取消必须能落 cancelled（否则 item 悬挂在 resolving）。
            "resolving", List.of("completed", "failed", "aborted", "cancelled"));

    private final LedgerOperationRepository operations;
    private final OperationItemRepository items;
    private final OperationAttemptRepository attempts;
    private final OperationEventRepository events;
    private final OperationExtensionRepository extensions;
    private final JobStateService jobStateService;
    private final WorkspaceService workspaceService;
    // PLAN-0346 T1.8: bounds FOR UPDATE / conditional UPDATE / unique-index
    // INSERT waits so a stuck writer cannot pin Hikari connections forever.
    private final DbLockTimeout dbLockTimeout;
    // PLAN-0346 (gap B): self-injection so the post-unique-violation re-read
    // can run in a REQUIRES_NEW transaction — inside the aborted transaction
    // PostgreSQL rejects every further statement.
    @Autowired
    private ApplicationContext applicationContext;

    public OperationService(LedgerOperationRepository operations,
                            OperationItemRepository items,
                            OperationAttemptRepository attempts,
                            OperationEventRepository events,
                            OperationExtensionRepository extensions,
                            DbLockTimeout dbLockTimeout,
                            JobStateService jobStateService,
                            WorkspaceService workspaceService) {
        this.operations = operations;
        this.items = items;
        this.attempts = attempts;
        this.events = events;
        this.extensions = extensions;
        this.dbLockTimeout = dbLockTimeout;
        this.jobStateService = jobStateService;
        this.workspaceService = workspaceService;
    }

    private OperationService self() {
        return applicationContext.getBean(OperationService.class);
    }

    /** Re-read an extension in a fresh transaction (aborted-txn escape hatch). */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public OperationExtension findExtensionFresh(UUID itemId, UUID attemptId,
                                                 String extensionKind, Integer schemaVersion) {
        return itemId != null
                ? extensions.findByItemIdAndExtensionKindAndSchemaVersion(
                        itemId.toString(), extensionKind, schemaVersion).orElse(null)
                : extensions.findByAttemptIdAndExtensionKindAndSchemaVersion(
                        attemptId.toString(), extensionKind, schemaVersion).orElse(null);
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
        return operations.findByRunId(runId).map(LedgerOperation::getId).orElse(null);
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

    /** PLAN-0317 T2.4：该 operation 下仍在途的 CP→Runtime 转发（取消目标）。 */
    @Transactional(readOnly = true)
    public List<OperationAttempt> findStartedForwards(UUID operationId) {
        if (operationId == null) {
            return List.of();
        }
        return attempts.findStartedForwards(operationId.toString());
    }

    @Transactional(readOnly = true)
    public OperationItem findItem(String itemId) {
        if (itemId == null || itemId.isBlank()) {
            return null;
        }
        return items.findById(UUID.fromString(itemId)).orElse(null);
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> listWorkspaceJobs(String workspaceId) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (LedgerOperation operation : operations
                .findByWorkspaceIdAndKindOrderByCreatedAtDesc(workspaceId, "job")) {
            for (OperationItem item : items.findByOperationIdOrderBySequenceAsc(operation.getId().toString())) {
                if (!"job".equals(item.getKind())) {
                    continue;
                }
                JobStateService.JobArchive archive = jobStateService.find(item.getId()).orElse(null);
                if (archive == null) {
                    continue;
                }
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("operationId", operation.getId().toString());
                view.put("operationItemId", item.getId().toString());
                view.put("workspaceId", operation.getWorkspaceId());
                view.put("sessionId", operation.getSessionId());
                view.put("runId", operation.getRunId());
                view.put("source", operation.getSource());
                view.put("scope", archive.scope());
                view.put("status", archive.status());
                view.put("jobId", archive.jobId());
                view.put("startedAt", archive.startedAt());
                view.put("endedAt", archive.endedAt());
                view.put("exitCode", archive.exitCode());
                view.put("timeoutSecs", archive.timeoutSecs());
                view.put("cancelReason", archive.cancelReason());
                result.add(view);
            }
        }
        return result;
    }

    /**
     * PLAN-0317 T2.9（决策 #14）：Runtime 追偿成功后记录的迟到终止事件。
     * **只追加 {@code item.terminated.late}，不回改已终态**——账本保留"当时未确认"
     * 的事实，迟到成功作为独立事件可被审计。
     */
    @Transactional
    public void recordLateTermination(String itemId, boolean confirmed) {
        dbLockTimeout.apply();
        OperationItem item = items.findById(UUID.fromString(itemId))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_ITEM_NOT_FOUND",
                        "Operation item not found"));
        appendEvent(UUID.fromString(item.getOperationId()), item.getId().toString(), null,
                "item.terminated.late", item.getStatus(), "runtime",
                "{\"confirmed\":" + confirmed + "}");
        logger.info("[LIFECYCLE] service=cp event=operation_item_late_termination itemId={} itemStatus={} confirmed={}",
                itemId, item.getStatus(), confirmed);
    }

    /**
     * PLAN-0366 T1.3（决策 #14）：用户直连取消 job 的账本事件（`job.cancel`）。
     *
     * <p>只追加 operation ledger 事件，**不改写** `ledger_operations.actor_type`
     * （那是 run 的发起事实）。调用方保证：归属校验通过且存在 job 档案（无档案分支
     * 不写，`state` NOT NULL 且无 job 事实，不造占位值——R3-2 处置）。
     *
     * @param state  写入事件时的档案状态（成功分支为终态；未确认/不可达分支保持现值）
     * @param result {@code cancelled|unconfirmed|orphaned|rejected_terminal|unreachable}
     */
    @Transactional
    public void recordJobCancel(String itemId, String workspaceId, String jobId,
                                String state, String result, boolean changed) {
        dbLockTimeout.apply();
        if (itemId == null || itemId.isBlank() || state == null) {
            return;
        }
        OperationItem item = items.findById(UUID.fromString(itemId)).orElse(null);
        if (item == null) {
            logger.warn("[LIFECYCLE] service=cp event=job_cancel_audit_skipped itemId={} reason=item_missing",
                    itemId);
            return;
        }
        UUID operationId = UUID.fromString(item.getOperationId());
        String runId = operations.findById(operationId)
                .map(LedgerOperation::getRunId)
                .orElse(null);
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("jobId", jobId);
        fields.put("workspaceId", workspaceId);
        fields.put("runId", runId);
        fields.put("result", result);
        fields.put("changed", changed);
        String payload;
        try {
            payload = OBJECT_MAPPER.writeValueAsString(fields);
        } catch (JsonProcessingException e) {
            logger.warn("[LIFECYCLE] service=cp event=job_cancel_audit_failed itemId={} error={}",
                    itemId, e.getMessage());
            return;
        }
        appendEvent(operationId, itemId, null, "job.cancel", state, "user", payload);
        logger.info("[LIFECYCLE] service=cp event=job_cancel_recorded itemId={} jobId={} result={} changed={} state={}",
                itemId, jobId, result, changed, state);
    }

    /**
     * PLAN-0328 T1.15：把当次派发的安全 Verdict 快照挂到**既有**账本条目上
     * （绝不新建第二个条目）。条目缺失 → 安全跳过并记生命周期事件；已有快照
     * 保持不变（同键重放幂等，不重写首次派发时的事实）。快照内容由
     * {@link OperationPolicySummary} 保证只含安全键。
     */
    @Transactional
    public boolean attachPolicySummary(UUID itemId, String policySummaryJson) {
        dbLockTimeout.apply();
        if (itemId == null || policySummaryJson == null || policySummaryJson.isBlank()) {
            return false;
        }
        // Defense in depth: only the exact safe shape is ever persisted — a caller that
        // accidentally passes a raw body / arguments payload is rejected here.
        if (OperationPolicySummary.parse(policySummaryJson).isEmpty()) {
            logger.warn("[LIFECYCLE] service=cp event=operation_policy_summary_rejected itemId={} reason=unsafe_shape",
                    itemId);
            return false;
        }
        OperationItem item = items.findById(itemId).orElse(null);
        if (item == null) {
            logger.info("[LIFECYCLE] service=cp event=operation_policy_summary_skipped itemId={} reason=item_missing",
                    itemId);
            return false;
        }
        if (item.getPolicySummary() != null && !item.getPolicySummary().isBlank()) {
            logger.info("[LIFECYCLE] service=cp event=operation_policy_summary_kept itemId={} reason=already_attached",
                    itemId);
            return false;
        }
        item.setPolicySummary(policySummaryJson);
        items.save(item);
        logger.info("[LIFECYCLE] service=cp event=operation_policy_summary_attached itemId={}", itemId);
        return true;
    }

    /**
     * PLAN-0317 决策 #8 补充（2026-09-13 宿主 E2E）：一次取消流程内四层终态落定。
     * 在途 forward 由 {@link #settleCancellation} 结算后，operation 下可能仍存在
     * 非终态 item（如中继重复建项、审批遗留）与其 started attempt——全部收口为
     * {@code cancelled}，避免取消后账本残留中间态（V11）。
     */
    @Transactional
    public void settleRemainingOpenItems(UUID operationId) {
        dbLockTimeout.apply();
        if (operationId == null) {
            return;
        }
        List<OperationItem> open = items.findByOperationIdAndStatusIn(operationId.toString(),
                List.of("pending", "running", "waiting_for_approval", "resolving"));
        for (OperationItem item : open) {
            for (OperationAttempt attempt : attempts.findByItemIdOrderByStartedAtAsc(item.getId().toString())) {
                if (!"started".equals(attempt.getStatus())) {
                    continue;
                }
                attempts.finishStarted(attempt.getId(), "cancelled", 499, null, null, null, Instant.now());
            }
            try {
                transitionItem(item.getId(), "cancelled", null, null, null, null);
            } catch (CpApiException e) {
                if (!"OPERATION_STATE_CONFLICT".equals(e.getCode())) {
                    throw e;
                }
                logger.info("[LIFECYCLE] service=cp event=cancel_item_kept_terminal itemId={} reason={}",
                        item.getId(), e.getMessage());
            }
        }
    }

    /**
     * PLAN-0317 T2.5：取消链路的账本落地——在途 attempt 落 {@code cancelled}，
     * item 按终止确认结果落 {@code cancelled}/{@code aborted}。幂等：item 已是
     * 终态（取消与自然完成竞态）时保留既有事实，不覆盖。
     */
    @Transactional
    public void settleCancellation(UUID itemId, UUID attemptId, String itemStatus, String errorCode) {
        dbLockTimeout.apply();
        if (attemptId != null) {
            int affected = attempts.finishStarted(attemptId, "cancelled", 499, errorCode, null, null,
                    Instant.now());
            if (affected == 0) {
                logger.debug("[LIFECYCLE] service=cp event=cancel_attempt_already_finished attemptId={}",
                        attemptId);
            }
        }
        try {
            transitionItem(itemId, itemStatus, null, null, null, errorCode);
        } catch (CpApiException e) {
            if (!"OPERATION_STATE_CONFLICT".equals(e.getCode())) {
                throw e;
            }
            logger.info("[LIFECYCLE] service=cp event=cancel_item_kept_terminal itemId={} reason={}",
                    itemId, e.getMessage());
        }
    }

    @Transactional
    public OperationStartResult startOperation(String userId, String sessionId, String workspaceId,
                                               String runId, String requestId, String kind,
                                               String source, String actorType, String actorId,
                                               String idempotencyKey, String summary) {
        dbLockTimeout.apply();
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
            LedgerOperation existing = operations
                    .findByUserIdAndSessionIdAndIdempotencyKey(userId, sessionId, idempotencyKey)
                    .orElse(null);
            if (existing != null) {
                logger.info("[LIFECYCLE] service=cp event=operation_idempotent_hit operationId={} sessionId={}",
                        existing.getId(), sessionId);
                return new OperationStartResult(existing.getId(), true);
            }
        }
        LedgerOperation operation = new LedgerOperation();
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
            if (reason != null && reason.contains("uq_ledger_operations_run")) {
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
        dbLockTimeout.apply();
        LedgerOperation operation = operations.findById(operationId)
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
        dbLockTimeout.apply();
        // PLAN-0317 决策 #7②：锁 operation 行串行化序号分配（同一 operation
        // 内的 item/event 追加不再依赖唯一约束失败回滚）。
        LedgerOperation operation = operations.findByIdForUpdate(operationId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                        "Operation not found"));
        // PLAN-0326 决策 #9：行身份 = (operation_id, source, tool_call_id)。
        // 幂等收敛限定在同源内——同一通道的重放命中，跨通道各建己行。
        if (toolCallId != null && !toolCallId.isBlank()) {
            OperationItem existing = items
                    .findByOperationIdAndSourceAndToolCallId(operationId.toString(), source, toolCallId).orElse(null);
            if (existing != null) {
                logger.info("[LIFECYCLE] service=cp event=operation_item_idempotent_hit itemId={} source={} toolCallId={}",
                        existing.getId(), source, toolCallId);
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
            logger.warn("[LIFECYCLE] service=cp event=operation_item_conflict operationId={} source={} toolCallId={} reason={}",
                    operationId, source, toolCallId, e.getMessage());
            if (toolCallId != null && !toolCallId.isBlank()) {
                OperationItem existing = items
                        .findByOperationIdAndSourceAndToolCallId(operationId.toString(), source, toolCallId).orElse(null);
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
        dbLockTimeout.apply();
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
        dbLockTimeout.apply();
        OperationItem item = items.findById(itemId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_ITEM_NOT_FOUND",
                        "Operation item not found"));
        // PLAN-0346 (gap C): take the same operation-row lock as appendItem so
        // retryNo allocation is serialized per operation (previously unlocked;
        // concurrent retries hit a 409 instead of an ordered allocation).
        operations.findByIdForUpdate(UUID.fromString(item.getOperationId()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                        "Operation not found"));
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
        dbLockTimeout.apply();
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

    // PLAN-0346 (gap B): a concurrent duplicate delivery hits the unique index
    // inside the REQUIRES_NEW worker, which aborts ONLY the worker transaction
    // (the facade has no transaction). The facade then re-reads the winner in a
    // fresh REQUIRES_NEW transaction — impossible inside the aborted one — and
    // decides: same payload = idempotent hit, different payload = 409. The race
    // loser surfaces as DataIntegrityViolationException (the worker lets it
    // propagate so the aborted transaction rolls back cleanly); pre-existing
    // different-payload conflicts surface as CpApiException 409.
    public void appendExtension(UUID itemId, UUID attemptId, String extensionKind,
                                Integer schemaVersion, String payloadJson) {
        if ((itemId == null && attemptId == null) || (itemId != null && attemptId != null)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Exactly one of itemId or attemptId is required");
        }
        try {
            self().appendExtensionInNewTx(itemId, attemptId, extensionKind, schemaVersion, payloadJson);
        } catch (CpApiException e) {
            if (!"OPERATION_EXTENSION_CONFLICT".equals(e.getCode())) {
                throw e;
            }
            resolveConcurrentExtension(itemId, attemptId, extensionKind, schemaVersion, payloadJson, e);
        } catch (DataIntegrityViolationException e) {
            logger.warn("[LIFECYCLE] service=cp event=operation_extension_race itemId={} attemptId={} kind={} schemaVersion={}",
                    itemId, attemptId, extensionKind, schemaVersion);
            resolveConcurrentExtension(itemId, attemptId, extensionKind, schemaVersion, payloadJson,
                    new CpApiException(HttpStatus.CONFLICT, "OPERATION_EXTENSION_CONFLICT",
                            "An extension of this kind and schema version already exists with different payload"));
        }
        logger.info("[LIFECYCLE] service=cp event=operation_extension_appended itemId={} attemptId={} kind={}",
                itemId, attemptId, extensionKind);
    }

    /**
     * PLAN-0346 (gap B): the loser's insert aborted its own transaction, but the
     * winner is committed — a fresh read decides between idempotent hit (same
     * payload) and genuine conflict (different payload / invisible winner).
     */
    private void resolveConcurrentExtension(UUID itemId, UUID attemptId, String extensionKind,
                                            Integer schemaVersion, String payloadJson,
                                            CpApiException conflict) {
        OperationExtension winner = self().findExtensionFresh(
                itemId, attemptId, extensionKind, schemaVersion);
        if (winner != null && sameJsonPayload(winner.getPayload(), payloadJson)) {
            logger.info("[LIFECYCLE] service=cp event=operation_extension_idempotent_hit itemId={} attemptId={} kind={} schemaVersion={} path=concurrent",
                    itemId, attemptId, extensionKind, schemaVersion);
            return;
        }
        throw conflict;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void appendExtensionInNewTx(UUID itemId, UUID attemptId, String extensionKind,
                                       Integer schemaVersion, String payloadJson) {
        dbLockTimeout.apply();
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
        // Any DataIntegrityViolationException here propagates: the worker
        // transaction is aborted and rolls back (the concurrent winner owns the
        // row), and the facade's fresh-read retry decides the final outcome.
        extensions.saveAndFlush(extension);
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
    public Page<LedgerOperation> listUserOperations(String userId, String sessionId,
                                                     String workspaceId, String status,
                                                     Pageable pageable) {
        return operations.searchByUserId(userId, sessionId, workspaceId, status, pageable);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> getOperationTrace(UUID operationId) {
        LedgerOperation operation = operations.findById(operationId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                        "Operation not found"));
        List<OperationItem> operationItems = items.findByOperationIdOrderBySequenceAsc(operationId.toString());
        // PLAN-0351 T1.3 (DDL-8): one batched attempt fetch for the whole
        // operation instead of one query per item (N+1); grouping restores the
        // per-item startedAt ordering while keeping the flat response shape.
        List<OperationAttempt> operationAttempts = new ArrayList<>();
        if (!operationItems.isEmpty()) {
            List<String> itemIds = new ArrayList<>();
            for (OperationItem item : operationItems) {
                itemIds.add(item.getId().toString());
            }
            Map<String, List<OperationAttempt>> attemptsByItem = new LinkedHashMap<>();
            for (OperationAttempt attempt : attempts.findByItemIdInOrderByStartedAtAsc(itemIds)) {
                attemptsByItem.computeIfAbsent(attempt.getItemId(), key -> new ArrayList<>()).add(attempt);
            }
            for (OperationItem item : operationItems) {
                operationAttempts.addAll(attemptsByItem.getOrDefault(item.getId().toString(), List.of()));
            }
        }
        List<OperationEvent> operationEvents = events.findByOperationIdOrderBySequenceAsc(operationId.toString());
        Map<String, Object> trace = new LinkedHashMap<>();
        trace.put("operation", operation);
        trace.put("items", operationItems);
        trace.put("attempts", operationAttempts);
        trace.put("events", operationEvents);
        trace.put("toolCallPairs", buildToolCallPairs(operationItems));
        return trace;
    }

    /**
     * PLAN-0346 (Q2): read-only pairing of the two channel facts of one tool
     * call — the agent row and the mcp row share the {@code tool_call_id}.
     * A missing side is returned as {@code null} instead of hiding the pair;
     * non-{@code tool_call} kinds stay out (approval/checkpoint ids are not
     * dispatch pairs).
     */
    private static List<Map<String, Object>> buildToolCallPairs(List<OperationItem> operationItems) {
        Map<String, List<OperationItem>> grouped = new LinkedHashMap<>();
        for (OperationItem item : operationItems) {
            if (!"tool_call".equals(item.getKind())
                    || item.getToolCallId() == null || item.getToolCallId().isBlank()) {
                continue;
            }
            grouped.computeIfAbsent(item.getToolCallId(), key -> new ArrayList<>()).add(item);
        }
        List<Map<String, Object>> pairs = new ArrayList<>();
        for (Map.Entry<String, List<OperationItem>> entry : grouped.entrySet()) {
            Map<String, Object> pair = new LinkedHashMap<>();
            pair.put("toolCallId", entry.getKey());
            pair.put("agentItemId", null);
            pair.put("mcpItemId", null);
            for (OperationItem item : entry.getValue()) {
                if ("agent".equals(item.getSource())) {
                    pair.put("agentItemId", item.getId().toString());
                } else if ("mcp".equals(item.getSource())) {
                    pair.put("mcpItemId", item.getId().toString());
                }
            }
            pairs.add(pair);
        }
        return pairs;
    }

    /**
     * PLAN-0346 (Q1): minimal read-only replay — re-applies the state-carrying
     * events in sequence order and diffs the derived state against the current
     * rows. Only event-derivable fields enter the verdict (operation/item/
     * attempt status, id sets, sequence continuity); source/kind/toolCallId,
     * timestamps and extension payloads are out of scope by design
     * (design「重放是什么」).
     */
    @Transactional(readOnly = true)
    public Map<String, Object> replayOperation(UUID operationId) {
        LedgerOperation operation = operations.findById(operationId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                        "Operation not found"));
        List<OperationEvent> operationEvents = events.findByOperationIdOrderBySequenceAsc(operationId.toString());

        String expectedOperationStatus = null;
        Map<String, String> expectedItemStatuses = new LinkedHashMap<>();
        Map<String, String> expectedAttemptStatuses = new LinkedHashMap<>();
        List<Map<String, Object>> sequenceGaps = new ArrayList<>();
        // Ledger sequences are 0-based (findMaxSequence coalesces to -1).
        long previousSequence = -1L;
        for (OperationEvent event : operationEvents) {
            long sequence = event.getSequence() == null ? -1L : event.getSequence();
            if (sequence != previousSequence + 1) {
                Map<String, Object> gap = new LinkedHashMap<>();
                gap.put("expected", previousSequence + 1);
                gap.put("actual", sequence);
                sequenceGaps.add(gap);
            }
            previousSequence = sequence;
            String type = event.getEventType();
            String state = event.getState();
            if (type == null || state == null) {
                continue;
            }
            if (type.startsWith("operation.")) {
                expectedOperationStatus = state;
            } else if (type.startsWith("item.") && event.getItemId() != null) {
                // Covers item.created / item.<status> and item.terminated.late
                // (the late marker re-states the current status, never changes it).
                expectedItemStatuses.put(event.getItemId(), state);
            } else if (type.startsWith("attempt.") && event.getAttemptId() != null) {
                expectedAttemptStatuses.put(event.getAttemptId(), state);
            }
        }

        List<OperationItem> currentItems = items.findByOperationIdOrderBySequenceAsc(operationId.toString());
        Map<String, String> actualItemStatuses = new LinkedHashMap<>();
        Map<String, String> actualAttemptStatuses = new LinkedHashMap<>();
        for (OperationItem item : currentItems) {
            actualItemStatuses.put(item.getId().toString(), item.getStatus());
            for (OperationAttempt attempt : attempts.findByItemIdOrderByStartedAtAsc(item.getId().toString())) {
                actualAttemptStatuses.put(attempt.getId().toString(), attempt.getStatus());
            }
        }

        List<Map<String, Object>> mismatches = new ArrayList<>();
        if (expectedOperationStatus != null
                && !expectedOperationStatus.equals(operation.getStatus())) {
            mismatches.add(replayMismatch("operation", operationId.toString(),
                    expectedOperationStatus, operation.getStatus()));
        }
        diffReplayStatuses(expectedItemStatuses, actualItemStatuses, "item", mismatches);
        diffReplayStatuses(expectedAttemptStatuses, actualAttemptStatuses, "attempt", mismatches);

        Map<String, Object> counts = new LinkedHashMap<>();
        counts.put("events", operationEvents.size());
        counts.put("items", currentItems.size());
        counts.put("attempts", actualAttemptStatuses.size());
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("operationId", operationId.toString());
        report.put("consistent", mismatches.isEmpty() && sequenceGaps.isEmpty());
        report.put("mismatches", mismatches);
        report.put("sequenceGaps", sequenceGaps);
        report.put("counts", counts);
        return report;
    }

    private static void diffReplayStatuses(Map<String, String> expected, Map<String, String> actual,
                                           String entity, List<Map<String, Object>> mismatches) {
        for (Map.Entry<String, String> entry : expected.entrySet()) {
            String actualStatus = actual.get(entry.getKey());
            if (!Objects.equals(entry.getValue(), actualStatus)) {
                mismatches.add(replayMismatch(entity, entry.getKey(), entry.getValue(), actualStatus));
            }
        }
        for (Map.Entry<String, String> entry : actual.entrySet()) {
            if (!expected.containsKey(entry.getKey())) {
                mismatches.add(replayMismatch(entity, entry.getKey(), null, entry.getValue()));
            }
        }
    }

    private static Map<String, Object> replayMismatch(String entity, String id, String expected, String actual) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("entity", entity);
        row.put("id", id);
        row.put("expected", expected);
        row.put("actual", actual);
        return row;
    }

    @Transactional(readOnly = true)
    public LedgerOperation requireOwnedOperation(UUID operationId, String userId) {
        LedgerOperation operation = operations.findById(operationId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                        "Operation not found"));
        if (userId == null || !userId.equals(operation.getUserId())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                    "Operation not found");
        }
        return operation;
    }

    /**
     * PLAN-0344 T1.2：按 item 归属校验（item → operation.userId）。
     * 供 job-output 续看端点使用；无权与不存在同样返回 404（不泄露存在性）。
     */
    @Transactional(readOnly = true)
    public OperationItem requireOwnedItem(UUID itemId, String userId) {
        OperationItem item = items.findById(itemId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_ITEM_NOT_FOUND",
                        "Operation item not found"));
        requireOwnedOperation(UUID.fromString(item.getOperationId()), userId);
        return item;
    }

    /** Job output/cancel access is scoped to Workspace membership, not Job creator. */
    @Transactional(readOnly = true)
    public OperationItem requireWorkspaceAccessibleItem(UUID itemId, String userId) {
        OperationItem item = items.findById(itemId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_ITEM_NOT_FOUND",
                        "Operation item not found"));
        LedgerOperation operation = operations.findById(UUID.fromString(item.getOperationId()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND",
                        "Operation not found"));
        workspaceService.requireAccessibleWorkspace(operation.getWorkspaceId(), userId);
        return item;
    }

    private void appendEvent(UUID operationId, String itemId, String attemptId,
                             String eventType, String state, String actor, String payload) {
        // PLAN-0317 决策 #7②：与 appendItem 相同，序号分配必须在 operation 行锁下
        // 进行——只换成聚合 max 仍会并发撞唯一约束（宿主 E2E 实测 OPERATION_EVENT_CONFLICT）。
        operations.findByIdForUpdate(operationId);
        Long sequence = events.findMaxSequence(operationId.toString()) + 1;
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

    /**
     * PLAN-0317 T2.7（决策 #9）：周期对账的账本收口——把仍在途的 item/attempt
     * 落为 {@code aborted}/{@code unknown}，并将 operation 推到目标终态。
     * 幂等：已终态的行保留既有事实。
     */
    @Transactional
    public void reconcileStaleOperation(String runId, String targetStatus) {
        dbLockTimeout.apply();
        UUID operationId = findOperationIdByRunId(runId);
        if (operationId == null) {
            return;
        }
        for (OperationItem item : items.findByOperationIdOrderBySequenceAsc(operationId.toString())) {
            if (isItemTerminal(item.getStatus())) {
                continue;
            }
            for (OperationAttempt attempt : attempts.findByItemIdOrderByStartedAtAsc(item.getId().toString())) {
                if ("started".equals(attempt.getStatus())) {
                    attempts.finishStarted(attempt.getId(), "unknown", null, "RUN_RECONCILED",
                            null, null, Instant.now());
                }
            }
            try {
                transitionItem(item.getId(), "aborted", null, null, null, "RUN_RECONCILED");
            } catch (CpApiException e) {
                if (!"OPERATION_STATE_CONFLICT".equals(e.getCode())) {
                    throw e;
                }
            }
        }
        try {
            transitionOperation(operationId, targetStatus, "RUN_RECONCILED", null);
        } catch (CpApiException e) {
            if (!"OPERATION_STATE_CONFLICT".equals(e.getCode())) {
                throw e;
            }
        }
        logger.info("[LIFECYCLE] service=cp event=operation_reconciled runId={} operationId={} targetStatus={}",
                runId, operationId, targetStatus);
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
