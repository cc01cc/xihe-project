package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunTransportAttempt;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunTransportAttemptRepository;
import com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/** Read-side ChatRun projections used by the public Chat API. */
@Service
public class ChatRunReadService {

    /** task-105: the config domain that owns runMaxTokens / runMaxTokensCeiling / budgetAccounting. */
    static final String AGENT_RUNTIME_DOMAIN = "agent-runtime";

    private final ChatRunRepository chatRunRepository;
    private final ChatRunTransportAttemptRepository transportAttempts;
    private final ApprovalService approvalService;
    private final com.cc01cc.p.xihe.cp.repository.MessageRepository messages;
    private final ConfigService configService;

    public ChatRunReadService(ChatRunRepository chatRunRepository,
                              ChatRunTransportAttemptRepository transportAttempts,
                              ApprovalService approvalService,
                              com.cc01cc.p.xihe.cp.repository.MessageRepository messages,
                              ConfigService configService) {
        this.chatRunRepository = chatRunRepository;
        this.transportAttempts = transportAttempts;
        this.approvalService = approvalService;
        this.messages = messages;
        this.configService = configService;
    }

    /**
     * PLAN-0605: the user message's admitted attachment JSON for this run. Dispatch builds
     * `images[]` from it, so it does not depend on `files.message_id` being linked yet.
     */
    Optional<String> findUserMessageAttachmentsJson(String runId) {
        return chatRunRepository.findById(UUID.fromString(runId))
                .map(ChatRun::getUserMessageId)
                .filter(messageId -> messageId != null && !messageId.isBlank())
                .flatMap(messageId -> messages.findById(UUID.fromString(messageId)))
                .map(com.cc01cc.p.xihe.cp.entity.Message::getAttachments)
                .filter(json -> json != null && !json.isBlank());
    }

    /**
     * BL-370: the one owner gate. Order is load-bearing and frozen: unknown run ⇒ 404
     * RUN_NOT_FOUND, then wrong owner/workspace ⇒ 403 FORBIDDEN. Callers must not pre-check owner
     * before existence or a cross-tenant probe would learn the difference (404 vs 403).
     */
    private ChatRun requireOwnedChatRun(UUID runUuid, String userId, String workspaceId) {
        ChatRun run = chatRunRepository.findById(runUuid).orElse(null);
        if (run == null) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        }
        if (!userId.equals(run.getUserId()) || !workspaceId.equals(run.getWorkspaceId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Chat run does not belong to current user/workspace");
        }
        return run;
    }

    /**
     * BL-370 (S1): read-run entry point for controllers that used to inject ChatRunRepository.
     * Same 404-before-403 gate as {@link #getStatus}; a controller still owns any additional
     * session-level authorization that must run *after* this one.
     */
    public ChatRun requireOwnedRun(UUID runUuid, String userId, String workspaceId) {
        return requireOwnedChatRun(runUuid, userId, workspaceId);
    }

    /** BL-370 (S1): latest run of a session as the delegation provenance anchor (null = none). */
    public ChatRun latestRunForSession(String sessionId) {
        return chatRunRepository.findFirstBySessionIdOrderByCreatedAtDescIdDesc(sessionId).orElse(null);
    }

    /** BL-370 (S1): dispatch evidence without leaking the attempt repository to callers. */
    public boolean hasTransportAttempt(String runId) {
        return transportAttempts.existsByRunId(runId);
    }

    public Map<String, Object> getStatus(UUID runUuid, String runId, String userId, String workspaceId) {
        ChatRun run = requireOwnedChatRun(runUuid, userId, workspaceId);
        boolean leaseExpired = run.getLeaseExpiresAt() != null
                && run.getLeaseExpiresAt().isBefore(Instant.now());
        List<Map<String, Object>> pendingApprovals = approvalService.findActiveForRun(runId, userId, workspaceId);
        String status = run.getStatus();
        String effectiveStatus = !pendingApprovals.isEmpty() && ("running".equals(status) || "cancelling".equals(status))
                ? "awaiting_approval"
                : status;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("runId", runId);
        body.put("sessionId", run.getSessionId());
        body.put("origin", run.getOrigin());
        body.put("status", effectiveStatus);
        body.put("terminalOutcome", run.getTerminalOutcome());
        // PLAN-0493 T3.1: terminal cause fact (e.g. RUN_NO_PROGRESS) so the
        // recovery banner can present the reason; free-form like the runs list.
        body.put("errorCode", run.getErrorCode());
        body.put("leaseExpired", leaseExpired);
        body.put("pendingApprovals", pendingApprovals);
        // PLAN-0628 M2a-③ (D28-42): the admission-frozen skills listing, replay-only. The stored
        // document is a Jackson-2 node, so it leaves through a typed projection (C1); `null` means
        // "this Run captured no snapshot" ({}) and never "this Run had no skills" (D28-40).
        body.put("skillsSnapshot", com.cc01cc.p.xihe.cp.skill.SkillSnapshotView.of(run.getSkillsSnapshot()));
        putBudgetFace(body, run);
        return body;
    }

    /**
     * task-105 (D-1869 ①): the Run's budget face. Both numbers ride together on purpose — a view
     * that shows only one of them tells half a story:
     *
     * <ul>
     *   <li>{@code tokenCount} — the provider's real cumulative total, straight from
     *       {@code chat_runs.token_count}; its semantics do not change here.</li>
     *   <li>{@code budgetConsumed} — the accounting value from {@code chat_runs.budget_consumed}.
     *       The durable column is nullable (V174, task-101/B) and {@code null} means "not
     *       recorded", so a historical Run leaves the field null; it is never coerced to 0.</li>
     *   <li>{@code runMaxTokens} / {@code runMaxTokensCeiling} / {@code budgetAccounting} — the
     *       limits "adjustable" needs to be visible, resolved from the same
     *       {@code agent-runtime} scope dispatch used for this Run. {@code chat_runs} keeps no
     *       per-run config snapshot (PLAN-0590's snapshot lives in the dispatch payload only), so
     *       these are read-time effective values and the contract says so.</li>
     * </ul>
     */
    private void putBudgetFace(Map<String, Object> body, ChatRun run) {
        body.put("tokenCount", run.getTokenCount());
        body.put("budgetConsumed", run.getBudgetConsumed());
        Map<String, String> runtime = configService
                .effective(AGENT_RUNTIME_DOMAIN, uuidOrNull(run.getUserId()), uuidOrNull(run.getWorkspaceId()))
                .entries();
        body.put("runMaxTokens", nonNegativeLong(runtime.get("runMaxTokens")));
        body.put("runMaxTokensCeiling", nonNegativeLong(runtime.get("runMaxTokensCeiling")));
        body.put("budgetAccounting", accountingOf(runtime.get("budgetAccounting")));
    }

    /** {@code 0} is a real value here (spec execution.md: the dimension is disabled), never "unknown". */
    private static Long nonNegativeLong(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            long value = Long.parseLong(raw.trim());
            return value < 0 ? null : value;
        } catch (NumberFormatException notANumber) {
            return null;
        }
    }

    /** The Agent's default is {@code growth}; an absent or unrecognised value reports that default. */
    private static String accountingOf(String raw) {
        return "cumulative".equalsIgnoreCase(raw == null ? null : raw.trim()) ? "cumulative" : "growth";
    }

    private static UUID uuidOrNull(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException notAUuid) {
            return null;
        }
    }

    /**
     * PLAN-0508 T2.2: durable provider HTTP transport attempts of one Run in
     * {@code seq} order, plus the same-count aggregate as the session monitor.
     * Authorization follows {@link #getStatus}; provider/model/connection
     * identity is projected from the immutable ChatRun snapshot. Wire bytes are
     * fixed {@code null} (v1 unknown) and the single {@code errorCode} slot
     * carries the safe string code or the provider HTTP status, whichever the
     * terminal summary reported.
     */
    public Map<String, Object> getRunAttempts(UUID runUuid, String runId, String userId, String workspaceId) {
        ChatRun run = requireOwnedChatRun(runUuid, userId, workspaceId);
        List<ChatRunTransportAttempt> rows = transportAttempts.findByRunIdOrderBySequenceAsc(runId);
        List<Map<String, Object>> attempts = new ArrayList<>(rows.size());
        long failedCount = 0;
        long partialCount = 0;
        for (ChatRunTransportAttempt row : rows) {
            String outcome = row.getOutcome();
            if (ChatRunTransportAttempt.OUTCOME_ERROR.equals(outcome)
                    || ChatRunTransportAttempt.OUTCOME_TIMEOUT.equals(outcome)) {
                failedCount++;
            } else if (ChatRunTransportAttempt.OUTCOME_ABORTED.equals(outcome)
                    || ChatRunTransportAttempt.OUTCOME_PARTIAL.equals(outcome)) {
                partialCount++;
            }
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("attemptId", row.getAttemptId().toString());
            view.put("seq", row.getSequence());
            view.put("status", row.getStatus());
            view.put("outcome", outcome);
            view.put("provider", run.getProvider());
            view.put("model", run.getModel());
            view.put("connectionId", run.getProviderConnectionId());
            view.put("connectionRevision", run.getConnectionRevision());
            view.put("startedAt", row.getStartedAt() == null ? null : row.getStartedAt().toString());
            view.put("endedAt", row.getEndedAt() == null ? null : row.getEndedAt().toString());
            view.put("durationMs", row.getDurationMs());
            view.put("errorCode", row.getErrorCode() != null ? row.getErrorCode() : row.getProviderHttpStatus());
            view.put("firstChunkMs", row.getFirstChunkMs());
            view.put("chunkCount", row.getChunkCount());
            view.put("uploadBytes", null);
            view.put("downloadBytes", null);
            view.put("lastProgressStage", row.getLastProgressStage());
            view.put("lastProgressElapsedMs", row.getLastProgressElapsedMs());
            attempts.add(view);
        }
        Map<String, Object> aggregate = new LinkedHashMap<>();
        aggregate.put("attemptCount", (long) rows.size());
        aggregate.put("failedCount", failedCount);
        aggregate.put("partialCount", partialCount);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("runId", runId);
        body.put("attempts", attempts);
        body.put("aggregate", aggregate);
        return body;
    }

    public Map<String, Object> listSessionRuns(String sessionId, int page, int size) {
        List<ChatRun> runs = chatRunRepository.findBySessionIdOrderByCreatedAtDescIdDesc(
                sessionId, PageRequest.of(page, size));
        List<Map<String, Object>> items = new ArrayList<>(runs.size());
        for (ChatRun run : runs) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("runId", run.getId().toString());
            item.put("sessionId", run.getSessionId());
            item.put("origin", run.getOrigin());
            item.put("status", run.getStatus());
            item.put("terminalOutcome", run.getTerminalOutcome());
            item.put("errorCode", run.getErrorCode());
            item.put("createdAt", run.getCreatedAt() == null ? null : run.getCreatedAt().toString());
            item.put("terminalAt", run.getTerminalAt() == null ? null : run.getTerminalAt().toString());
            item.put("waitingOnRunId", run.getWaitingOnRunId());
            item.put("waitingToolCallId", run.getWaitingToolCallId());
            items.add(item);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", sessionId);
        body.put("page", page);
        body.put("size", size);
        body.put("runs", items);
        return body;
    }

    /** Current durable Run status, or null when the Run no longer exists. */
    public String statusOrNull(String runId) {
        if (runId == null || runId.isBlank()) {
            return null;
        }
        return chatRunRepository.findById(UUID.fromString(runId))
                .map(ChatRun::getStatus)
                .orElse(null);
    }

    Optional<DispatchRun> findDispatchRun(String runId) {
        return chatRunRepository.findById(UUID.fromString(runId))
                .map(run -> new DispatchRun(
                        run.getId().toString(), run.getSessionId(), run.getUserId(), run.getWorkspaceId(),
                        run.getOrigin(), run.getStatus(), run.getUserMessageId(), run.getProvider(),
                        run.getModel(), run.getToolMode()));
    }

    record DispatchRun(String id, String sessionId, String userId, String workspaceId, String origin,
                       String status, String userMessageId, String provider, String model,
                       String toolMode) {
    }

    Optional<ExecutionRun> findExecutionRun(String runId) {
        return chatRunRepository.findById(UUID.fromString(runId))
                .map(run -> new ExecutionRun(run.getProvider(), run.getModel(), run.getProviderConnectionId(),
                        run.getConnectionRevision(), run.getUserMessageId(), run.getBranchId(),
                        run.getParentRunId(),
                        new ContextTemplateSourceService.RunContext(
                        run.getId().toString(), run.getSessionId(), run.getWorkspaceId(), run.getUserId(),
                        run.getContextTemplateSnapshot(),
                        // PLAN-0628 M2a (D28-39): dispatch renders the listing from this frozen
                        // document, never from the live bindings.
                        run.getSkillsSnapshot(),
                        run.getAgentPrincipalId() == null ? null : run.getAgentPrincipalId().toString()),
                        continuationDescriptor(run)));
    }

    record ExecutionRun(String provider, String model, String providerConnectionId, Long connectionRevision,
                        String userMessageId, String branchId, String parentRunId,
                        ContextTemplateSourceService.RunContext context,
                        ContinuationDescriptor continuation) {
    }

    Optional<ContinuationDispatchRun> findContinuationDispatchRun(String runId) {
        return chatRunRepository.findById(UUID.fromString(runId))
                .filter(run -> run.getContinuationSourceRunId() != null)
                .map(run -> new ContinuationDispatchRun(
                        run.getId().toString(), run.getSessionId(), run.getUserId(), run.getWorkspaceId(),
                        run.getOrigin(), run.getStatus(), run.getUserMessageId(), run.getProvider(),
                        run.getModel(), run.getToolMode(), continuationDescriptor(run)));
    }

    private static ContinuationDescriptor continuationDescriptor(ChatRun run) {
        if (run.getContinuationSourceRunId() == null) {
            return null;
        }
        if (run.getContinuationLineageId() == null || run.getContinuationThreadId() == null
                || run.getContinuationCheckpointId() == null || run.getContinuationEventSequence() == null
                || run.getContinuationMode() == null || run.getBranchId() == null) {
            throw new IllegalStateException("Continuation ChatRun has incomplete provenance");
        }
        return new ContinuationDescriptor(run.getContinuationMode(), run.getContinuationSourceRunId(),
                run.getContinuationLineageId(), run.getContinuationThreadId(), run.getContinuationCheckpointId(),
                run.getContinuationEventSequence(), run.getBranchId());
    }

    record ContinuationDescriptor(String mode, String sourceRunId, String lineageId, String threadId,
                                  String checkpointId, long eventSequence, String branchId) {
    }

    record ContinuationDispatchRun(String id, String sessionId, String userId, String workspaceId,
                                   String origin, String status, String userMessageId,
                                   String provider, String model, String toolMode,
                                   ContinuationDescriptor continuation) {
    }
}


