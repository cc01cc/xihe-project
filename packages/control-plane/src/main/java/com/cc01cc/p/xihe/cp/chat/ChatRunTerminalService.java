package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
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
import java.util.List;
import java.util.UUID;

/** The only CP owner that commits a ChatRun terminal state and its ledger projection. */
@Service
public class ChatRunTerminalService {
    private static final Logger logger = LoggerFactory.getLogger(ChatRunTerminalService.class);
    private static final String TERMINAL_APPLICATION_NAME_PREFIX = "xihe-terminal-";

    public enum LedgerMode {
        STREAM,
        CANCELLATION,
        RECONCILIATION
    }

    public enum Outcome {
        COMMITTED,
        NOT_FOUND,
        LOST
    }

    public record AttemptSettlement(UUID itemId, UUID attemptId, String itemStatus, String errorCode) {}

    public record TerminalRequest(
            String runId,
            Collection<String> expectedStatuses,
            String status,
            String terminalOutcome,
            String errorCode,
            String errorDetail,
            int tokenCount,
            int assistantChars,
            LedgerMode ledgerMode,
            List<AttemptSettlement> attemptSettlements) {
        public TerminalRequest {
            expectedStatuses = expectedStatuses == null ? List.of() : List.copyOf(expectedStatuses);
            attemptSettlements = attemptSettlements == null ? List.of() : List.copyOf(attemptSettlements);
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
            UUID operationId,
            UUID itemId,
            boolean missing,
            boolean alreadyTerminal,
            String currentStatus) {}

    private final DbLockTimeout dbLockTimeout;
    private final String datasourceUrl;
    private final EntityManager entityManager;
    private final ChatRunRepository chatRuns;
    private final SessionRepository sessions;
    private final LedgerOperationRepository ledgerOperations;
    private final OperationItemRepository operationItems;
    private final OperationService operationService;
    private final RunCheckpointService checkpoints;

    public ChatRunTerminalService(
            DbLockTimeout dbLockTimeout,
            @Value("${spring.datasource.url:}") String datasourceUrl,
            EntityManager entityManager,
            ChatRunRepository chatRuns,
            SessionRepository sessions,
            LedgerOperationRepository ledgerOperations,
            OperationItemRepository operationItems,
            OperationService operationService,
            RunCheckpointService checkpoints) {
        this.dbLockTimeout = dbLockTimeout;
        this.datasourceUrl = datasourceUrl;
        this.entityManager = entityManager;
        this.chatRuns = chatRuns;
        this.sessions = sessions;
        this.ledgerOperations = ledgerOperations;
        this.operationItems = operationItems;
        this.operationService = operationService;
        this.checkpoints = checkpoints;
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

        UUID operationId = ledgerOperations.findIdByRunId(runId.toString()).orElse(null);
        if (operationId != null) {
            ledgerOperations.findByIdForUpdate(operationId)
                    .orElseThrow(() -> terminalInvariant("Run LedgerOperation disappeared", runId));
        } else {
            logger.warn("[LIFECYCLE] service=cp event=terminal_operation_missing runId={} status={}",
                    runId, request.status());
        }

        Instant terminalAt = Instant.now();
        int changed = chatRuns.terminalTransition(runId, request.expectedStatuses(), request.status(),
                request.terminalOutcome(), request.errorCode(), request.errorDetail(),
                request.tokenCount(), request.assistantChars(), terminalAt);
        if (changed != 1) {
            return new TerminalResult(Outcome.LOST, run.getStatus());
        }
        entityManager.refresh(run);

        if (operationId != null) {
            settleLedger(request, operationId, runId);
        }
        if (parentLink != null && !parentLink.missing()) {
            operationService.settleWaitingChild(parentLink.operationId(), parentLink.itemId(), runId,
                    request.status(), run.getAssistantMessageId(), parentErrorCode(request));
        } else if (parentLink != null) {
            logger.warn("[LIFECYCLE] service=cp event=derived_parent_missing runId={} parentSessionId={} parentRunId={}",
                    runId, parentLink.sessionId(), parentLink.runId());
        }

        requestCheckpointAfterCommit(runId.toString());
        return new TerminalResult(Outcome.COMMITTED, request.status());
    }

    private ParentLink lockParentLink(Session childSessionLocator, UUID childRunId) {
        if (!Session.KIND_SPAWN.equals(childSessionLocator.getKind())) {
            return null;
        }
        UUID parentSessionId = childSessionLocator.getSpawnedFromSessionId();
        UUID parentRunId = childSessionLocator.getSpawnedFromRunId();
        if (parentSessionId == null || parentRunId == null) {
            throw terminalInvariant("Spawn child is missing parent provenance", childRunId);
        }

        Session parentSession = sessions.findByIdForUpdate(parentSessionId).orElse(null);
        if (parentSession == null) {
            return new ParentLink(parentSessionId, parentRunId, null, null, true, false, null);
        }
        entityManager.refresh(parentSession);

        ChatRun parentRun = chatRuns.findByIdForUpdate(parentRunId).orElse(null);
        if (parentRun == null) {
            return new ParentLink(parentSessionId, parentRunId, null, null, true, false, null);
        }
        entityManager.refresh(parentRun);
        if (!parentSessionId.toString().equals(parentRun.getSessionId())
                || !parentSession.getUserId().equals(parentRun.getUserId())
                || !parentSession.getWorkspaceId().equals(parentRun.getWorkspaceId())
                || !parentSession.getUserId().equals(childSessionLocator.getUserId())
                || !parentSession.getWorkspaceId().equals(childSessionLocator.getWorkspaceId())) {
            throw terminalInvariant("Live spawn parent ownership/provenance does not match", childRunId);
        }

        UUID parentOperationId = ledgerOperations.findIdByRunId(parentRunId.toString()).orElse(null);
        if (parentOperationId == null) {
            throw terminalInvariant("Live spawn parent has no LedgerOperation", childRunId);
        }
        ledgerOperations.findByIdForUpdate(parentOperationId)
                .orElseThrow(() -> terminalInvariant("Live spawn parent LedgerOperation is missing", childRunId));

        String childStatus = chatRuns.findStatusById(childRunId).orElse(null);
        if (isTerminal(childStatus)) {
            return new ParentLink(parentSessionId, parentRunId, parentOperationId,
                    null, false, true, childStatus);
        }
        List<UUID> parentItemIds = operationItems.findIdsByWaitingOnRunId(childRunId);
        if (parentItemIds.size() != 1) {
            childStatus = chatRuns.findStatusById(childRunId).orElse(null);
            if (isTerminal(childStatus)) {
                return new ParentLink(parentSessionId, parentRunId, parentOperationId,
                        null, false, true, childStatus);
            }
            throw terminalInvariant("Live spawn parent does not have exactly one waiting OperationItem", childRunId);
        }
        UUID parentItemId = parentItemIds.getFirst();
        var parentItem = operationItems.findByIdForUpdate(parentItemId)
                .orElseThrow(() -> terminalInvariant("Live spawn parent OperationItem is missing", childRunId));
        entityManager.refresh(parentItem);
        if (!parentOperationId.toString().equals(parentItem.getOperationId())
                || !childRunId.equals(parentItem.getWaitingOnRunId())
                || !"agent".equals(parentItem.getSource())
                || !"spawn_agent".equals(parentItem.getToolName())) {
            throw terminalInvariant("Live spawn parent waiting link does not match the child", childRunId);
        }
        return new ParentLink(parentSessionId, parentRunId, parentOperationId, parentItemId,
                false, false, null);
    }

    private void settleLedger(TerminalRequest request, UUID operationId, UUID runId) {
        switch (request.ledgerMode()) {
            case STREAM -> operationService.transitionOperationForTerminal(runId.toString(),
                    operationStatus(request.status()), request.errorCode(), request.errorDetail());
            case CANCELLATION -> {
                for (AttemptSettlement settlement : request.attemptSettlements()) {
                    operationService.settleCancellation(settlement.itemId(), settlement.attemptId(),
                            settlement.itemStatus(), settlement.errorCode());
                }
                operationService.settleRemainingOpenItems(operationId);
                operationService.transitionOperationForTerminal(runId.toString(), "cancelled",
                        request.errorCode(), request.errorDetail());
            }
            case RECONCILIATION -> operationService.reconcileStaleOperation(runId.toString(),
                    operationStatus(request.status()));
        }
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

    private static String operationStatus(String runStatus) {
        return switch (runStatus) {
            case "succeeded" -> "completed";
            case "partial", "failed" -> "failed";
            case "cancelled" -> "cancelled";
            case "ambiguous" -> "ambiguous";
            default -> throw new IllegalArgumentException("Unsupported terminal Run status: " + runStatus);
        };
    }

    private static String parentErrorCode(TerminalRequest request) {
        if (request.errorCode() != null) {
            return request.errorCode();
        }
        return "partial".equals(request.status()) ? "PARTIAL_RESULT" : null;
    }

    private CpApiException terminalInvariant(String detail, UUID runId) {
        logger.error("[LIFECYCLE] service=cp event=terminal_invariant_failed runId={} detail={}", runId, detail);
        return new CpApiException(HttpStatus.CONFLICT, "RUN_TERMINAL_INVARIANT_VIOLATION", detail);
    }

    private static boolean isTerminal(String status) {
        return List.of("succeeded", "partial", "failed", "cancelled", "ambiguous").contains(status);
    }
}
