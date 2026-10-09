package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.McpAttempt;
import com.cc01cc.p.xihe.cp.entity.McpDispatchHistory;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.policy.SafePolicySummary;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.McpDispatchHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0463 T1.2: write paths for the MCP execution domain
 * ({@code mcp_invocations} / {@code mcp_attempts} / {@code mcp_dispatch_history}).
 *
 * <p>Every write runs in its own {@code REQUIRES_NEW} transaction bounded by
 * {@link DbLockTimeout}, so an execution-domain bookkeeping failure can never
 * poison or widen the dispatch transaction: the Agent gate fails closed when
 * no invocation could be opened, while the direct-user path is best-effort by
 * design (design key 3/4: creation failure is logged as a known gap and never
 * blocks the mutation).</p>
 *
 * <p>Nothing here persists a prompt, unbounded arguments or any secret; the
 * preview column keeps the existing 4096-byte bounded-prefix rule and history
 * payloads carry ids/flags only.</p>
 */
@Service
public class McpInvocationService {

    private static final Logger logger = LoggerFactory.getLogger(McpInvocationService.class);

    private static final List<String> TERMINAL_STATUSES = List.of(
            McpInvocation.STATUS_COMPLETED, McpInvocation.STATUS_FAILED,
            McpInvocation.STATUS_UNKNOWN, McpInvocation.STATUS_CANCELLED);

    /** Verdict the MCP proxy already derived from a 2xx response body. */
    public enum McpDispatchVerdict { COMPLETED, TOOL_ERROR, PROTOCOL_ERROR, UNDECIDABLE }

    private final McpInvocationRepository invocations;
    private final McpAttemptRepository attempts;
    private final McpDispatchHistoryRepository history;
    private final ChatRunRepository chatRuns;
    private final DbLockTimeout dbLockTimeout;

    public McpInvocationService(McpInvocationRepository invocations,
                                McpAttemptRepository attempts,
                                McpDispatchHistoryRepository history,
                                ChatRunRepository chatRuns,
                                DbLockTimeout dbLockTimeout) {
        this.invocations = invocations;
        this.attempts = attempts;
        this.history = history;
        this.chatRuns = chatRuns;
        this.dbLockTimeout = dbLockTimeout;
    }

    private record InvocationScope(String runId, String sessionId, String workspaceId, String userId) {}

    /** Returns only the provenance projection needed to label a Run's Workspace Jobs. */
    public Map<String, String> toolNamesByCallForRun(String runId) {
        Map<String, String> toolNamesByCall = new LinkedHashMap<>();
        for (McpInvocation invocation : invocations.findByRunIdOrderByCreatedAtAsc(runId)) {
            if (invocation.getToolCallId() != null && invocation.getToolName() != null) {
                toolNamesByCall.putIfAbsent(
                        invocation.getToolCallId().toLowerCase(java.util.Locale.ROOT),
                        invocation.getToolName());
            }
        }
        return Map.copyOf(toolNamesByCall);
    }

    /**
     * T1.2 gate path: create (or idempotently return) the {@code source=agent}
     * invocation for this {@code (runId, toolCallId)}.
     *
     * <p>Returns {@code empty} when the run context is unusable (missing/invalid
     * ids, ChatRun row absent) or when the write failed — the caller's invocation
     * context gate then rejects the dispatch. No legacy owner fallback is used.</p>
     */
    @Transactional(isolation = Isolation.READ_COMMITTED, propagation = Propagation.REQUIRES_NEW)
    public Optional<UUID> openAgentInvocation(String runId, String toolCallId, String toolName,
                                              String requestId, String argumentsPreview) {
        dbLockTimeout.apply();
        InvocationScope scope = agentScope(runId).orElse(null);
        if (scope == null) {
            return Optional.empty();
        }
        String canonicalToolCallId = canonicalUuidString(toolCallId);
        if (canonicalToolCallId == null) {
            logger.info("[LIFECYCLE] service=cp event=mcp_invocation_open_skipped runId={} reason=invalid_tool_call_id",
                    scope.runId());
            return Optional.empty();
        }
        Optional<McpInvocation> existing = invocations
                .findByRunIdAndToolCallIdAndSource(scope.runId(), canonicalToolCallId,
                        McpInvocation.SOURCE_AGENT);
        if (existing.isPresent()) {
            return Optional.of(existing.get().getId());
        }
        try {
            return Optional.of(create(scope.runId(), scope.sessionId(), scope.workspaceId(),
                    scope.userId(), canonicalToolCallId, toolName,
                    McpInvocation.SOURCE_AGENT, requestId, argumentsPreview).getId());
        } catch (DataIntegrityViolationException race) {
            // Concurrent gate/relay for the same (run, toolCallId): re-read winner.
            return invocations
                    .findByRunIdAndToolCallIdAndSource(scope.runId(), canonicalToolCallId,
                            McpInvocation.SOURCE_AGENT)
                    .map(McpInvocation::getId);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_invocation_open_failed runId={} toolCallId={} failureType={}",
                    scope.runId(), canonicalToolCallId, e.getClass().getName(), e);
            return Optional.empty();
        }
    }

    /**
     * T1.2 direct-user path: create the {@code source=direct_user} invocation
     * best-effort (review round-1 #2 / design key 3). Never throws; a failure is
     * logged as the documented known gap and the mutation proceeds untouched.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Optional<UUID> openDirectUserInvocation(String sessionId, String workspaceId, String userId,
                                                   String toolCallId, String toolName,
                                                   String requestId, String argumentsPreview) {
        try {
            dbLockTimeout.apply();
            String canonicalToolCallId = canonicalUuidString(toolCallId);
            if (canonicalToolCallId == null || workspaceId == null || userId == null) {
                return Optional.empty();
            }
            McpInvocation invocation = create(null, canonicalUuidString(sessionId), workspaceId, userId,
                    canonicalToolCallId, toolName, McpInvocation.SOURCE_DIRECT_USER,
                    requestId, argumentsPreview);
            return Optional.of(invocation.getId());
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_invocation_direct_user_failed tool={} failureType={}",
                    toolName, e.getClass().getName(), e);
            return Optional.empty();
        }
    }

    private McpInvocation create(String runId, String sessionId, String workspaceId, String userId,
                                 String toolCallId, String toolName, String source,
                                 String requestId, String argumentsPreview) {
        McpInvocation invocation = new McpInvocation();
        invocation.setId(UUID.randomUUID());
        invocation.setRunId(runId);
        invocation.setSessionId(sessionId);
        invocation.setWorkspaceId(workspaceId);
        invocation.setUserId(userId);
        invocation.setToolCallId(toolCallId);
        invocation.setToolName(toolName == null || toolName.isBlank() ? "unknown" : toolName);
        invocation.setSource(source);
        invocation.setRequestId(canonicalUuidString(requestId));
        invocation.setArgumentsPreview(boundedPreview(argumentsPreview));
        invocation.setStatus(McpInvocation.STATUS_ACTIVE);
        invocations.saveAndFlush(invocation);
        appendHistory(invocation.getId(), null, McpDispatchHistory.EVENT_INVOCATION_OPENED,
                null, McpInvocation.STATUS_ACTIVE, "system", null);
        logger.info("[LIFECYCLE] service=cp event=mcp_invocation_opened invocationId={} source={} runId={} toolCallId={}",
                invocation.getId(), source, runId, toolCallId);
        return invocation;
    }

    private Optional<InvocationScope> agentScope(String runId) {
        Optional<UUID> runUuid = canonicalUuid(runId);
        if (runUuid.isEmpty()) {
            return Optional.empty();
        }
        Optional<ChatRun> run = chatRuns.findById(runUuid.get());
        if (run.isEmpty()) {
            logger.info("[LIFECYCLE] service=cp event=mcp_invocation_open_skipped runId={} reason=run_missing", runId);
            return Optional.empty();
        }
        ChatRun row = run.get();
        return Optional.of(new InvocationScope(row.getId().toString(), row.getSessionId(),
                row.getWorkspaceId(), row.getUserId()));
    }

    /**
     * T1.2 dispatch: start a {@code cp_forward} attempt on the invocation.
     * Empty when the invocation does not exist (nothing to account for).
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Optional<UUID> startDispatchAttempt(UUID invocationId, String requestId) {
        return startAttemptFor(invocationId, McpAttempt.STAGE_CP_FORWARD, "cp", requestId);
    }

    /**
     * T1.2 SSE relay (review round-1 #1): the {@code agent_tool} attempt lands in
     * {@code mcp_attempts} beside the still-live legacy row.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Optional<UUID> startAgentToolAttempt(UUID invocationId, String requestId) {
        return startAttemptFor(invocationId, McpAttempt.STAGE_AGENT_TOOL, "agent", requestId);
    }

    private Optional<UUID> startAttemptFor(UUID invocationId, String stage, String module,
                                           String requestId) {
        if (invocationId == null) {
            return Optional.empty();
        }
        dbLockTimeout.apply();
        if (invocations.findById(invocationId).isEmpty()) {
            return Optional.empty();
        }
        String canonicalRequestId = canonicalUuidString(requestId);
        if (canonicalRequestId != null) {
            Optional<McpAttempt> existing = attempts.findByInvocationIdAndStageAndRequestId(
                    invocationId, stage, canonicalRequestId);
            if (existing.isPresent()) {
                return Optional.of(existing.get().getId());
            }
        }
        try {
            return Optional.of(startAttempt(invocationId, stage, module, canonicalRequestId).getId());
        } catch (DataIntegrityViolationException race) {
            return canonicalRequestId == null ? Optional.empty()
                    : attempts.findByInvocationIdAndStageAndRequestId(invocationId, stage,
                            canonicalRequestId).map(McpAttempt::getId);
        }
    }

    private McpAttempt startAttempt(UUID invocationId, String stage, String module, String requestId) {
        McpAttempt attempt = new McpAttempt();
        attempt.setId(UUID.randomUUID());
        attempt.setInvocationId(invocationId);
        attempt.setStage(stage);
        attempt.setModule(module);
        attempt.setRequestId(requestId);
        attempt.setRetryNo(attempts.findMaxRetryNo(invocationId, stage) + 1);
        attempt.setStatus(McpAttempt.STATUS_STARTED);
        attempt.setStartedAt(Instant.now());
        attempts.saveAndFlush(attempt);
        appendHistory(invocationId, attempt.getId(), McpDispatchHistory.EVENT_ATTEMPT_STARTED,
                null, McpAttempt.STATUS_STARTED, "system", null);
        logger.info("[LIFECYCLE] service=cp event=mcp_attempt_started invocationId={} attemptId={} stage={} retryNo={}",
                invocationId, attempt.getId(), stage, attempt.getRetryNo());
        return attempt;
    }

    /**
     * T1.2 dispatch settlement. A {@code *_UNKNOWN} transport failure finishes as
     * {@code unknown} and flips the invocation to {@code unknown} (left for the
     * late-termination report); a decidable result settles the invocation only
     * from {@code active}, mirroring the legacy {@code ambiguous} semantics.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void finishDispatchAttempt(UUID invocationId, UUID attemptId, int httpStatus,
                                      String errorCode, McpDispatchVerdict verdict) {
        if (attemptId == null) {
            return;
        }
        dbLockTimeout.apply();
        boolean succeeded = httpStatus >= 200 && httpStatus < 300 && errorCode == null;
        boolean unknown = errorCode != null && errorCode.endsWith("_UNKNOWN");
        String targetStatus = unknown ? McpAttempt.STATUS_UNKNOWN
                : succeeded ? McpAttempt.STATUS_SUCCEEDED : McpAttempt.STATUS_FAILED;
        try {
            attempts.finishStarted(attemptId, targetStatus, httpStatus, errorCode, null,
                    null, Instant.now(), Instant.now());
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_attempt_finish_failed attemptId={} failureType={}",
                    attemptId, e.getClass().getName(), e);
            return;
        }
        String event = switch (targetStatus) {
            case McpAttempt.STATUS_SUCCEEDED -> McpDispatchHistory.EVENT_ATTEMPT_SUCCEEDED;
            case McpAttempt.STATUS_UNKNOWN -> McpDispatchHistory.EVENT_ATTEMPT_UNKNOWN;
            default -> McpDispatchHistory.EVENT_ATTEMPT_FAILED;
        };
        appendHistory(invocationId, attemptId, event, McpAttempt.STATUS_STARTED, targetStatus,
                "cp", null);
        if (unknown) {
            settle(invocationId, McpInvocation.STATUS_UNKNOWN, errorCode);
        } else if (!succeeded) {
            settle(invocationId, McpInvocation.STATUS_FAILED, errorCode);
        } else if (verdict == McpDispatchVerdict.TOOL_ERROR) {
            settle(invocationId, McpInvocation.STATUS_FAILED, "MCP_RESULT_IS_ERROR");
        } else if (verdict == McpDispatchVerdict.PROTOCOL_ERROR) {
            settle(invocationId, McpInvocation.STATUS_FAILED, "MCP_PROTOCOL_ERROR");
        } else {
            settle(invocationId, McpInvocation.STATUS_COMPLETED, null);
        }
    }

    /**
     * T1.2 relay settlement: the Agent-side tool result settles the
     * {@code agent_tool} attempt and the invocation while it is still active.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void finishAgentToolAttempt(UUID invocationId, UUID attemptId, boolean failed) {
        if (attemptId == null) {
            return;
        }
        dbLockTimeout.apply();
        String targetStatus = failed ? McpAttempt.STATUS_FAILED : McpAttempt.STATUS_SUCCEEDED;
        try {
            attempts.finishStarted(attemptId, targetStatus, failed ? 500 : 200,
                    failed ? "TOOL_FAILED" : null, null, null, Instant.now(), Instant.now());
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_attempt_finish_failed attemptId={} failureType={}",
                    attemptId, e.getClass().getName(), e);
            return;
        }
        appendHistory(invocationId, attemptId,
                failed ? McpDispatchHistory.EVENT_ATTEMPT_FAILED : McpDispatchHistory.EVENT_ATTEMPT_SUCCEEDED,
                McpAttempt.STATUS_STARTED, targetStatus, "agent", null);
        settle(invocationId, failed ? McpInvocation.STATUS_FAILED : McpInvocation.STATUS_COMPLETED,
                failed ? "TOOL_FAILED" : null);
    }

    /** Moves an {@code active} invocation to a terminal/unknown state; idempotent. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void settle(UUID invocationId, String status, String errorCode) {
        if (invocationId == null || !TERMINAL_STATUSES.contains(status)) {
            return;
        }
        dbLockTimeout.apply();
        McpInvocation invocation = invocations.findByIdForUpdate(invocationId).orElse(null);
        if (invocation == null || !McpInvocation.STATUS_ACTIVE.equals(invocation.getStatus())) {
            return;
        }
        invocation.setStatus(status);
        invocation.setErrorCode(errorCode);
        invocation.setFinishedAt(Instant.now());
        invocations.save(invocation);
        appendHistory(invocationId, null, McpDispatchHistory.EVENT_INVOCATION_SETTLED,
                McpInvocation.STATUS_ACTIVE, status, "system", null);
        logger.info("[LIFECYCLE] service=cp event=mcp_invocation_settled invocationId={} status={}",
                invocationId, status);
    }

    /**
     * PLAN-0463 handoff gap 2 / PLAN-0464: a run that reaches a terminal state
     * reconciles every {@code source=agent} invocation of that run that is still
     * {@code active} (gate-created, relay lost or tool result never relayed).
     * Called after the terminal commit; idempotent and bounded by the run's own
     * invocation rows.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int settleStrandedForRun(String runId, String status, String errorCode) {
        if (runId == null || runId.isBlank() || !TERMINAL_STATUSES.contains(status)) {
            return 0;
        }
        dbLockTimeout.apply();
        int settled = 0;
        for (McpInvocation stranded : invocations.findByRunIdAndStatus(runId, McpInvocation.STATUS_ACTIVE)) {
            McpInvocation invocation = invocations.findByIdForUpdate(stranded.getId()).orElse(null);
            if (invocation == null || !McpInvocation.STATUS_ACTIVE.equals(invocation.getStatus())) {
                continue;
            }
            invocation.setStatus(status);
            invocation.setErrorCode(errorCode);
            invocation.setFinishedAt(Instant.now());
            invocations.save(invocation);
            appendHistory(invocation.getId(), null, McpDispatchHistory.EVENT_INVOCATION_SETTLED,
                    McpInvocation.STATUS_ACTIVE, status, "system", null);
            settled++;
        }
        return settled;
    }

    /**
     * T1.2/T2.2 late termination on the new target: append-only history, then
     * {@code unknown → late_confirmed} when Runtime confirms the termination.
     * An already-settled invocation is never rewritten.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordLateTermination(UUID invocationId, UUID attemptId, boolean confirmed) {
        dbLockTimeout.apply();
        McpInvocation invocation = invocations.findByIdForUpdate(invocationId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "MCP_INVOCATION_NOT_FOUND", "MCP invocation not found"));
        McpAttempt target = attemptId != null
                ? attempts.findById(attemptId).orElse(null)
                : attempts.findFirstByInvocationIdAndStatusOrderByStartedAtDesc(
                        invocationId, McpAttempt.STATUS_UNKNOWN).orElse(null);
        String fromStatus = target != null ? target.getStatus() : invocation.getStatus();
        String toStatus = confirmed ? McpAttempt.STATUS_LATE_CONFIRMED : "late_unconfirmed";
        if (target != null && McpAttempt.STATUS_UNKNOWN.equals(target.getStatus()) && confirmed) {
            attempts.confirmLate(target.getId(), Instant.now(), Instant.now());
        }
        if (confirmed && McpInvocation.STATUS_UNKNOWN.equals(invocation.getStatus())) {
            invocation.setStatus(McpInvocation.STATUS_COMPLETED);
            invocation.setFinishedAt(Instant.now());
            invocations.save(invocation);
        }
        appendHistory(invocationId, target != null ? target.getId() : null,
                McpDispatchHistory.EVENT_ATTEMPT_LATE_CONFIRMED, fromStatus, toStatus,
                "runtime", "{\"confirmed\":" + confirmed + "}");
        logger.info("[LIFECYCLE] service=cp event=mcp_late_termination invocationId={} attemptId={} confirmed={} fromStatus={}",
                invocationId, target != null ? target.getId() : null, confirmed, fromStatus);
    }

    /** Attach the verdict snapshot after applying the same bounded-payload defenses. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void attachPolicySummary(UUID invocationId, String policySummaryJson) {
        if (invocationId == null || policySummaryJson == null || policySummaryJson.isBlank()) {
            return;
        }
        if (SafePolicySummary.parse(policySummaryJson).isEmpty()) {
            logger.warn("[LIFECYCLE] service=cp event=mcp_invocation_policy_summary_rejected invocationId={} reason=unsafe_shape",
                    invocationId);
            return;
        }
        dbLockTimeout.apply();
        McpInvocation invocation = invocations.findById(invocationId).orElse(null);
        if (invocation == null || (invocation.getPolicySummary() != null
                && !invocation.getPolicySummary().isBlank())) {
            return;
        }
        invocation.setPolicySummary(policySummaryJson);
        invocations.save(invocation);
    }

    /** Read helper for the MCP proxy (outbound {@code X-Mcp-Invocation-Id}). */
    public Optional<UUID> findAgentInvocation(String runId, String toolCallId) {
        Optional<UUID> runUuid = canonicalUuid(runId);
        Optional<UUID> toolCallUuid = canonicalUuid(toolCallId);
        if (runUuid.isEmpty() || toolCallUuid.isEmpty()) {
            return Optional.empty();
        }
        return invocations.findByRunIdAndToolCallIdAndSource(runUuid.get().toString(),
                toolCallUuid.get().toString(), McpInvocation.SOURCE_AGENT)
                .map(McpInvocation::getId);
    }

    public List<McpDispatchHistory> historyFor(UUID invocationId) {
        return history.findByInvocationIdOrderBySequenceAsc(invocationId);
    }

    private void appendHistory(UUID invocationId, UUID attemptId, String eventType,
                               String fromStatus, String toStatus, String actorType, String payload) {
        try {
            McpDispatchHistory row = new McpDispatchHistory();
            row.setId(UUID.randomUUID());
            row.setInvocationId(invocationId);
            row.setAttemptId(attemptId);
            row.setSequence(history.findMaxSequence(invocationId) + 1);
            row.setEventType(eventType);
            row.setFromStatus(fromStatus);
            row.setToStatus(toStatus);
            row.setActorType(actorType);
            row.setPayload(payload);
            history.save(row);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_dispatch_history_failed invocationId={} eventType={} failureType={}",
                    invocationId, eventType, e.getClass().getName(), e);
        }
    }

    private static Optional<UUID> canonicalUuid(String raw) {
        String canonical = canonicalUuidString(raw);
        if (canonical == null) {
            return Optional.empty();
        }
        return Optional.of(UUID.fromString(canonical));
    }

    /** Canonical UUID string for a correlation key; {@code null} when unusable. */
    private static String canonicalUuidString(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw.trim()).toString();
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String boundedPreview(String raw) {
        if (raw == null) {
            return null;
        }
        return raw.length() <= 4096 ? raw : raw.substring(0, 4096);
    }
}
