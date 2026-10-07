package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunHistory;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.operation.JobScopeClosureService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.InboxRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.RunCheckpointService;
import jakarta.persistence.EntityManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The only CP owner that commits a ChatRun terminal state.
 *
 * <p>PLAN-0464: the ChatRun row is the single root. This service no longer
 * settles an Operation, mirrors a Ledger status or keeps a per-run waiting link
 * on an OperationItem — it writes the run terminal transition, its
 * {@code chat_run_history} row, the spawn waiting-link settlement, the Inbox
 * notice and (when the relay supplied it) the {@code llm.usage} ContextEvent,
 * all in one transaction.</p>
 */
@Service
public class ChatRunTerminalService {
    private static final Logger logger = LoggerFactory.getLogger(ChatRunTerminalService.class);
    private static final String TERMINAL_APPLICATION_NAME_PREFIX = "xihe-terminal-";

    /** Who owned the terminal write; also selects the history event type. */
    public enum TerminalSource {
        STREAM(ChatRunHistory.EVENT_TERMINAL, ChatRunHistory.SOURCE_STREAM),
        CANCELLATION(ChatRunHistory.EVENT_CANCEL, ChatRunHistory.SOURCE_CANCELLATION),
        RECONCILIATION(ChatRunHistory.EVENT_RECOVERY, ChatRunHistory.SOURCE_RECONCILIATION);

        private final String eventType;
        private final String source;

        TerminalSource(String eventType, String source) {
            this.eventType = eventType;
            this.source = source;
        }

        public String eventType() {
            return eventType;
        }

        public String source() {
            return source;
        }
    }

    public enum Outcome {
        COMMITTED,
        NOT_FOUND,
        LOST
    }

    public record TerminalRequest(
            String runId,
            Collection<String> expectedStatuses,
            String status,
            String terminalOutcome,
            String errorCode,
            String errorDetail,
            int tokenCount,
            int assistantChars,
            TerminalSource source,
            /** Relay in-memory usage payload (cost-enriched) or {@code null}. */
            Object usagePayload) {
        public TerminalRequest {
            expectedStatuses = expectedStatuses == null ? List.of() : List.copyOf(expectedStatuses);
        }
    }

    public record TerminalResult(Outcome outcome, String currentStatus) {
        public boolean committed() {
            return outcome == Outcome.COMMITTED;
        }
    }

    private record ParentLink(
            UUID sessionId,
            UUID runId,
            UUID waitingToolCallId,
            boolean missing,
            boolean alreadyTerminal,
            String currentStatus) {}

    private final DbLockTimeout dbLockTimeout;
    private final String datasourceUrl;
    private final EntityManager entityManager;
    private final ChatRunRepository chatRuns;
    private final SessionRepository sessions;
    private final ChatRunHistoryWriter historyWriter;
    private final EventStoreService eventStoreService;
    private final McpInvocationService mcpInvocationService;
    private final JobScopeClosureService jobScopeClosureService;
    private final RunCheckpointService checkpoints;
    private final InboxRepository inboxes;
    private final SseEmitterManager sseEmitters;

    public ChatRunTerminalService(
            DbLockTimeout dbLockTimeout,
            @Value("${spring.datasource.url:}") String datasourceUrl,
            EntityManager entityManager,
            ChatRunRepository chatRuns,
            SessionRepository sessions,
            ChatRunHistoryWriter historyWriter,
            EventStoreService eventStoreService,
            McpInvocationService mcpInvocationService,
            JobScopeClosureService jobScopeClosureService,
            RunCheckpointService checkpoints,
            InboxRepository inboxes,
            SseEmitterManager sseEmitters) {
        this.dbLockTimeout = dbLockTimeout;
        this.datasourceUrl = datasourceUrl;
        this.entityManager = entityManager;
        this.chatRuns = chatRuns;
        this.sessions = sessions;
        this.historyWriter = historyWriter;
        this.eventStoreService = eventStoreService;
        this.mcpInvocationService = mcpInvocationService;
        this.jobScopeClosureService = jobScopeClosureService;
        this.checkpoints = checkpoints;
        this.inboxes = inboxes;
        this.sseEmitters = sseEmitters;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public TerminalResult terminalize(TerminalRequest request) {
        dbLockTimeout.apply();
        UUID runId = UUID.fromString(request.runId());
        if (datasourceUrl.startsWith("jdbc:postgresql:")) {
            entityManager.createNativeQuery("select set_config('application_name', :applicationName, true)")
                    .setParameter("applicationName", TERMINAL_APPLICATION_NAME_PREFIX + runId)
                    .getSingleResult();
        }
        ChatRun locator = chatRuns.findById(runId).orElse(null);
        if (locator == null) {
            return new TerminalResult(Outcome.NOT_FOUND, null);
        }
        UUID sessionId = UUID.fromString(locator.getSessionId());
        Session sessionLocator = sessions.findById(sessionId).orElse(null);
        if (sessionLocator == null) {
            logger.warn("[LIFECYCLE] service=cp event=terminal_session_missing runId={} sessionId={}",
                    runId, sessionId);
            return new TerminalResult(Outcome.NOT_FOUND, null);
        }

        ParentLink parentLink = lockParentLink(sessionLocator, runId);
        if (parentLink != null && parentLink.alreadyTerminal()) {
            return new TerminalResult(Outcome.LOST, parentLink.currentStatus());
        }
        Session session = sessions.findByIdForUpdate(sessionId).orElse(null);
        if (session == null) {
            return new TerminalResult(Outcome.NOT_FOUND, null);
        }
        entityManager.refresh(session);
        ChatRun run = chatRuns.findByIdForUpdate(runId).orElse(null);
        if (run == null) {
            return new TerminalResult(Outcome.NOT_FOUND, null);
        }
        entityManager.refresh(run);
        if (!sessionId.equals(UUID.fromString(run.getSessionId()))
                || !sessionId.toString().equals(session.getId().toString())
                || !session.getUserId().equals(run.getUserId())
                || !session.getWorkspaceId().equals(run.getWorkspaceId())
                || (parentLink != null && (!parentLink.sessionId().equals(session.getSpawnedFromSessionId())
                        || !parentLink.runId().equals(session.getSpawnedFromRunId())))) {
            throw terminalInvariant("Run and Session ownership changed while acquiring terminal locks", runId);
        }
        if (isTerminal(run.getStatus())) {
            return new TerminalResult(Outcome.LOST, run.getStatus());
        }
        if (!request.expectedStatuses().contains(run.getStatus())) {
            return new TerminalResult(Outcome.LOST, run.getStatus());
        }

        String fromStatus = run.getStatus();
        Instant terminalAt = Instant.now();
        int changed = chatRuns.terminalTransition(runId, request.expectedStatuses(), request.status(),
                request.terminalOutcome(), request.errorCode(), request.errorDetail(),
                request.tokenCount(), request.assistantChars(), terminalAt);
        if (changed != 1) {
            return new TerminalResult(Outcome.LOST, run.getStatus());
        }
        entityManager.refresh(run);

        historyWriter.append(request.source().eventType(), request.source().source(), "system",
                runId, sessionId, fromStatus, request.status(), request.terminalOutcome(),
                request.errorCode(), null);
        writeUsageEvent(run, request.usagePayload());
        if (parentLink != null && !parentLink.missing()) {
            settleWaitingLink(run);
            // PLAN-0407 T2.6b: Inbox business key is the last lock/write of this
            // transaction (design #45); an Inbox failure rolls back ChatRun
            // terminal status, terminal_at, waiting link and history.
            upsertChildTerminalInbox(parentLink.sessionId(), sessionId, runId, inboxState(request));
            publishDerivedStateAfterCommit(parentLink.sessionId(), sessionId, runId,
                    inboxState(request), run.getTerminalAt());
        } else if (parentLink != null) {
            logger.warn("[LIFECYCLE] service=cp event=derived_parent_missing runId={} parentSessionId={} parentRunId={}",
                    runId, parentLink.sessionId(), parentLink.runId());
        }

        requestCheckpointAfterCommit(runId.toString());
        // PLAN-0464 T1.2 (review round-1 #1): the run-scope Job收口 trigger is
        // now owned by the Chat terminal path; OperationService is no longer the
        // single entry. Both are best-effort after commit (Runtime is remote).
        requestRunScopeClosureAfterCommit(runId.toString());
        settleStrandedInvocationsAfterCommit(runId.toString(), request);
        return new TerminalResult(Outcome.COMMITTED, request.status());
    }

    /**
     * PLAN-0464 T2.1: the waiting link is read from the child run row itself.
     * Lock order stays parent Session → parent Run → child Session → child Run.
     *
     * <p>A non-terminal spawn child MUST carry the link: {@code
     * createSpawnFromParent} writes it in the same transaction as the run, so a
     * missing link is an invariant breach (the terminal transaction rolls back
     * rather than silently skipping the parent settle and the derived Inbox
     * notice). The link is never backfilled (design 风险画像), which is why this
     * is enforced as a hard invariant instead of a legacy fallback read.</p>
     */
    private ParentLink lockParentLink(Session childSessionLocator, UUID childRunId) {
        if (!Session.KIND_SPAWN.equals(childSessionLocator.getKind())) {
            return null;
        }
        UUID parentSessionId = childSessionLocator.getSpawnedFromSessionId();
        UUID parentRunId = childSessionLocator.getSpawnedFromRunId();
        if (parentSessionId == null || parentRunId == null) {
            throw terminalInvariant("Spawn child is missing parent provenance", childRunId);
        }

        ChatRun childLocator = chatRuns.findById(childRunId).orElse(null);
        if (childLocator == null) {
            return new ParentLink(parentSessionId, parentRunId, null, true, false, null);
        }
        String childStatus = chatRuns.findStatusById(childRunId).orElse(null);
        if (isTerminal(childStatus)) {
            // Already settled (replay/duplicate settle) — LOST, not an invariant breach.
            return new ParentLink(parentSessionId, parentRunId, null, false, true, childStatus);
        }
        UUID waitingOnRunId = parseWaiting(childLocator.getWaitingOnRunId());
        UUID waitingToolCallId = parseWaiting(childLocator.getWaitingToolCallId());
        if (waitingOnRunId == null || waitingToolCallId == null) {
            throw terminalInvariant("Spawn child is missing its waiting link", childRunId);
        }
        if (!parentRunId.equals(waitingOnRunId)) {
            throw terminalInvariant("Spawn child waiting link does not match its parent provenance", childRunId);
        }

        Session parentSession = sessions.findByIdForUpdate(parentSessionId).orElse(null);
        if (parentSession == null) {
            return new ParentLink(parentSessionId, parentRunId, waitingToolCallId, true, false, null);
        }
        entityManager.refresh(parentSession);

        ChatRun parentRun = chatRuns.findByIdForUpdate(parentRunId).orElse(null);
        if (parentRun == null) {
            return new ParentLink(parentSessionId, parentRunId, waitingToolCallId, true, false, null);
        }
        entityManager.refresh(parentRun);
        if (!parentSessionId.toString().equals(parentRun.getSessionId())
                || !parentSession.getUserId().equals(parentRun.getUserId())
                || !parentSession.getWorkspaceId().equals(parentRun.getWorkspaceId())
                || !parentSession.getUserId().equals(childSessionLocator.getUserId())
                || !parentSession.getWorkspaceId().equals(childSessionLocator.getWorkspaceId())) {
            throw terminalInvariant("Live spawn parent ownership/provenance does not match", childRunId);
        }
        // The spawn_agent binding is proven when the spawn transaction writes the
        // link (ChatSubmissionService validates the invocation before writing),
        // so terminal only re-checks domain provenance.
        return new ParentLink(parentSessionId, parentRunId, waitingToolCallId, false, false, null);
    }

    /** Clears the child run waiting link inside the terminal transaction. */
    private void settleWaitingLink(ChatRun run) {
        if (run.getWaitingOnRunId() == null && run.getWaitingToolCallId() == null) {
            return;
        }
        run.setWaitingOnRunId(null);
        run.setWaitingToolCallId(null);
        chatRuns.save(run);
        logger.debug("[LIFECYCLE] service=cp event=run_waiting_link_settled runId={}", run.getId());
    }

    /**
     * PLAN-0464 T1.4: the terminal transition writes the {@code llm.usage}
     * ContextEvent from the relay's in-memory usage payload — the same input the
     * retired {@code llm_usage} extension used. No usage data (recovery /
     * CP_RESTARTED / cancel without a relay) writes no event.
     */
    private void writeUsageEvent(ChatRun run, Object usagePayload) {
        if (!(usagePayload instanceof Map<?, ?> envelope) || envelope.isEmpty()) {
            return;
        }
        if (envelope.get("usage") == null) {
            return;
        }
        Map<String, Object> eventPayload = new HashMap<>();
        eventPayload.put("usage", envelope.get("usage"));
        eventStoreService.append(run.getSessionId(), run.getWorkspaceId(), run.getUserId(),
                "llm.usage", eventPayload, run.getId().toString());
        Map<?, ?> usage = envelope.get("usage") instanceof Map<?, ?> u ? u : Map.of();
        logger.info("[LIFECYCLE] service=cp event=llm_usage_persisted runId={} source={} inputTokens={} totalTokens={} cost={} costSource={}",
                run.getId(), usage.get("source"), usage.get("inputTokens"), usage.get("totalTokens"),
                usage.get("cost"), usage.get("costSource"));
    }

    /**
     * PLAN-0463 handoff gap 2: gate-created invocations whose relay was lost stay
     * {@code active}; the terminal transition is their reconciliation point.
     */
    private void settleStrandedInvocationsAfterCommit(String runId, TerminalRequest request) {
        String targetStatus = "cancelled".equals(request.status())
                ? McpInvocation.STATUS_CANCELLED
                : McpInvocation.STATUS_FAILED;
        String errorCode = request.errorCode() == null ? "RUN_TERMINAL" : request.errorCode();
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                try {
                    int settled = mcpInvocationService.settleStrandedForRun(runId, targetStatus, errorCode);
                    if (settled > 0) {
                        logger.info("[LIFECYCLE] service=cp event=mcp_invocations_reconciled runId={} settled={} status={}",
                                runId, settled, targetStatus);
                    }
                } catch (RuntimeException error) {
                    logger.warn("[LIFECYCLE] service=cp event=mcp_invocation_reconcile_failed runId={} error={}",
                            runId, error.getMessage(), error);
                }
            }
        });
    }

    /** PLAN-0407 T2.6b: one notice per (parent Session, child_terminal, child run), same transaction. */
    private void upsertChildTerminalInbox(UUID parentSessionId, UUID childSessionId, UUID childRunId,
                                          String state) {
        String payload = "{\"sessionId\":\"" + childSessionId + "\",\"runId\":\"" + childRunId
                + "\",\"state\":\"" + state + "\"}";
        inboxes.upsertChildTerminal(UUID.randomUUID(), parentSessionId, childRunId, payload);
        logger.debug("[LIFECYCLE] service=cp event=derived_inbox_upserted runId={} parentSessionId={} state={}",
                childRunId, parentSessionId, state);
    }

    /** payload_pointer.state is the terminalOutcome wire enum {success,error,partial,ambiguous,cancelled}. */
    private static String inboxState(TerminalRequest request) {
        if (request.terminalOutcome() != null) {
            return request.terminalOutcome();
        }
        return switch (request.status()) {
            case "succeeded" -> "success";
            case "partial" -> "partial";
            case "failed" -> "error";
            case "cancelled" -> "cancelled";
            case "ambiguous" -> "ambiguous";
            default -> throw new IllegalArgumentException(
                    "Unsupported terminal status for Inbox payload: " + request.status());
        };
    }

    /** SSE is only a post-commit refresh hint; the Inbox row remains authoritative. */
    private void publishDerivedStateAfterCommit(UUID parentSessionId, UUID childSessionId, UUID childRunId,
                                                String state, Instant terminalAt) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                Map<String, String> payload = new LinkedHashMap<>();
                payload.put("sessionId", childSessionId.toString());
                payload.put("runId", childRunId.toString());
                payload.put("state", state);
                payload.put("at", terminalAt.toString());
                try {
                    // The parent page owns the derived-state view; the payload identifies the child run.
                    sseEmitters.send(parentSessionId.toString(), "derived_state_changed", payload);
                } catch (RuntimeException error) {
                    logger.warn("[LIFECYCLE] service=cp event=derived_state_sse_failed runId={} parentSessionId={}",
                            childRunId, parentSessionId, error);
                }
            }
        });
    }

    private void requestCheckpointAfterCommit(String runId) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                try {
                    checkpoints.requestCapture(runId);
                } catch (RuntimeException error) {
                    logger.warn("[LIFECYCLE] service=cp event=terminal_checkpoint_trigger_failed runId={} error={}",
                            runId, error.getMessage(), error);
                }
            }
        });
    }

    private void requestRunScopeClosureAfterCommit(String runId) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                try {
                    jobScopeClosureService.closeRunScope(runId);
                } catch (RuntimeException error) {
                    logger.warn("[LIFECYCLE] service=cp event=job_scope_run_close_failed runId={} error={}",
                            runId, error.getMessage(), error);
                }
            }
        });
    }

    private CpApiException terminalInvariant(String detail, UUID runId) {
        logger.error("[LIFECYCLE] service=cp event=terminal_invariant_failed runId={} detail={}", runId, detail);
        return new CpApiException(HttpStatus.CONFLICT, "RUN_TERMINAL_INVARIANT_VIOLATION", detail);
    }

    /** Unparsable waiting-link values are treated exactly like a missing link. */
    private static UUID parseWaiting(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static boolean isTerminal(String status) {
        return List.of("succeeded", "partial", "failed", "cancelled", "ambiguous").contains(status);
    }
}
