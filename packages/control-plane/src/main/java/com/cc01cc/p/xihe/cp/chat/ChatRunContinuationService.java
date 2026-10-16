package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.checkpoint.AgentGraphCheckpointService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.mcp.LineageInvocationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.EntityManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Atomic admission boundary for checkpoint-based ChatRun continuation. */
@Service
class ChatRunContinuationService {
    private static final Logger logger = LoggerFactory.getLogger(ChatRunContinuationService.class);

    private final ChatRunRepository runs;
    private final SessionRepository sessions;
    private final MessageRepository messages;
    private final AgentGraphCheckpointService checkpoints;
    private final LineageInvocationService lineageInvocations;
    private final ContinuationRuntimeJobGate runtimeJobGate;
    private final DbLockTimeout dbLockTimeout;
    private final EntityManager entityManager;
    private final ObjectMapper objectMapper;
    private final ApplicationEventPublisher eventPublisher;

    ChatRunContinuationService(ChatRunRepository runs,
                               SessionRepository sessions,
                               MessageRepository messages,
                               AgentGraphCheckpointService checkpoints,
                               LineageInvocationService lineageInvocations,
                               ContinuationRuntimeJobGate runtimeJobGate,
                               DbLockTimeout dbLockTimeout,
                               EntityManager entityManager,
                               ObjectMapper objectMapper,
                               ApplicationEventPublisher eventPublisher) {
        this.runs = runs;
        this.sessions = sessions;
        this.messages = messages;
        this.checkpoints = checkpoints;
        this.lineageInvocations = lineageInvocations;
        this.runtimeJobGate = runtimeJobGate;
        this.dbLockTimeout = dbLockTimeout;
        this.entityManager = entityManager;
        this.objectMapper = objectMapper;
        this.eventPublisher = eventPublisher;
    }

    @Transactional
    ContinuationResult continueRun(String sourceRunIdValue, String userId, String workspaceId,
                                  String idempotencyKey, ChatRunContinuationRequest request) {
        UUID sourceRunUuid = parseSourceRunId(sourceRunIdValue);
        ChatRun observedSource = runs.findById(sourceRunUuid).orElseThrow(ChatRunContinuationService::runNotFound);
        requireSourceOwner(observedSource, userId, workspaceId);

        dbLockTimeout.apply();
        Session session = sessions.findByIdForUpdate(UUID.fromString(observedSource.getSessionId()))
                .filter(candidate -> userId.equals(candidate.getUserId())
                        && workspaceId.equals(candidate.getWorkspaceId()) && !candidate.isArchived())
                .orElseThrow(ChatRunContinuationService::forbidden);
        entityManager.refresh(session);
        if (session.getDeleteRequestedAt() != null) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_DELETING", "Session is being deleted");
        }

        ChatRun source = runs.findByIdForUpdate(sourceRunUuid)
                .orElseThrow(ChatRunContinuationService::runNotFound);
        entityManager.refresh(source);
        requireSourceOwner(source, userId, workspaceId);
        if (!session.getId().toString().equals(source.getSessionId())) {
            throw forbidden();
        }
        String branchId = canonicalUuid(source.getBranchId(), "source branch");
        String requestHash = ChatRunContinuationHash.calculate(objectMapper, userId, workspaceId,
                session.getId().toString(), source.getId().toString(), request, branchId);

        ChatRun existing = runs.findByUserIdAndSessionIdAndIdempotencyKey(
                userId, session.getId().toString(), idempotencyKey).orElse(null);
        if (existing != null) {
            return replayOrReject(existing, source, requestHash, request.mode());
        }

        if (!"ambiguous".equals(source.getStatus()) || !"CP_RESTARTED".equals(source.getErrorCode())) {
            throw new CpApiException(HttpStatus.CONFLICT, "CONTINUATION_SOURCE_INELIGIBLE",
                    "Only a CP_RESTARTED ambiguous source Run can be continued");
        }
        if (runs.existsBySessionIdAndStatusIn(source.getSessionId(), ChatRunCancellationService.NON_TERMINAL_STATUSES)) {
            throw new CpApiException(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS",
                    "A chat run is already active for this Session");
        }

        AgentGraphCheckpointService.ContinuationCheckpointView checkpoint =
                checkpoints.findLatestSafeCheckpointForSourceRun(source.getId().toString(),
                        new AgentGraphCheckpointService.OwnerRequest(
                                source.getSessionId(), userId, workspaceId));
        if (checkpoint == null) {
            throw new CpApiException(HttpStatus.CONFLICT, "CONTINUATION_CHECKPOINT_MISSING",
                    "No safe checkpoint is available for this source Run");
        }
        requireCheckpointBinding(checkpoint, source, branchId);
        if (checkpoint.eventSequence() != checkpoint.currentVisibleBranchHead()) {
            throw sourceStale();
        }

        // Both domain owners participate while the Session and source Run locks
        // are held. Missing or ambiguous evidence rejects admission; CP never
        // infers safety from a terminal ChatRun/Job status alone.
        LineageInvocationService.ContinuationAdmission invocationAdmission =
                lineageInvocations.requireContinuationEligible(
                        source.getId().toString(), checkpoint.lineageId());
        List<String> completedToolCallIds = validateCompletedToolCallIds(
                invocationAdmission.completedToolCallIds());
        runtimeJobGate.requireEligible(source, invocationAdmission.lineageRunIds());

        ChatRun child = new ChatRun(UUID.randomUUID().toString(), source.getSessionId(), userId, workspaceId,
                idempotencyKey, requestHash, source.getProvider(), source.getModel(), source.getToolMode(), "accepted");
        child.setOrigin(ChatRun.ORIGIN_USER_SUBMISSION);
        child.setBranchId(branchId);
        child.setContextTemplateSnapshot(source.getContextTemplateSnapshot());
        child.setProviderConnectionId(source.getProviderConnectionId());
        child.setConnectionRevision(source.getConnectionRevision());
        child.setContinuationSourceRunId(source.getId().toString());
        child.setContinuationLineageId(checkpoint.lineageId());
        child.setContinuationThreadId(checkpoint.threadId());
        child.setContinuationCheckpointId(checkpoint.checkpointId());
        child.setContinuationEventSequence(checkpoint.eventSequence());
        child.setContinuationMode(request.mode());

        try {
            runs.saveAndFlush(child);
        } catch (DataIntegrityViolationException e) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_continuation_admission_conflict failureType={}",
                    e.getClass().getSimpleName());
            throw new CpApiException(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_REUSED",
                    "Idempotency-Key already belongs to a different ChatRun", e);
        }

        if (ChatRunContinuationRequest.APPEND_USER_TURN.equals(request.mode())) {
            Message userMessage = new Message(source.getSessionId(), MessageRole.USER, request.content());
            userMessage.setRunId(child.getId().toString());
            userMessage.setBranchId(branchId);
            messages.save(userMessage);
            child.setUserMessageId(userMessage.getId().toString());
            runs.save(child);
        }

        eventPublisher.publishEvent(new ContinuationRunDispatchRequestedEvent(
                source.getId().toString(), child.getId().toString(),
                completedToolCallIds));
        return new ContinuationResult(child.getId().toString(), request.mode(), child.getStatus(), false,
                checkpoint.lineageId(), checkpoint.threadId(), checkpoint.checkpointId(),
                checkpoint.eventSequence(), branchId);
    }

    private ContinuationResult replayOrReject(ChatRun existing, ChatRun source,
                                              String requestHash, String mode) {
        String sourceRunId = source.getId().toString();
        if (!requestHash.equals(existing.getRequestHash())
                || !sourceRunId.equals(existing.getContinuationSourceRunId())
                || !mode.equals(existing.getContinuationMode())) {
            throw new CpApiException(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_REUSED",
                    "Idempotency-Key was already used for a different continuation request");
        }
        if (existing.getContinuationLineageId() == null || existing.getContinuationThreadId() == null
                || existing.getContinuationCheckpointId() == null || existing.getContinuationEventSequence() == null
                || !source.getBranchId().equals(existing.getBranchId())) {
            throw new CpApiException(HttpStatus.CONFLICT, "CONTINUATION_CHECKPOINT_INVALID",
                    "The idempotent child Run has incomplete continuation provenance");
        }
        ContinuationResult result = resultFrom(existing, true);
        if ("accepted".equals(existing.getStatus())) {
            if (!"ambiguous".equals(source.getStatus()) || !"CP_RESTARTED".equals(source.getErrorCode())) {
                throw new CpApiException(HttpStatus.CONFLICT, "CONTINUATION_SOURCE_INELIGIBLE",
                        "Only a CP_RESTARTED ambiguous source Run can be continued");
            }
            requireReplayCheckpointFresh(source, existing);
            LineageInvocationService.ContinuationAdmission admission = lineageInvocations
                    .requireContinuationEligible(sourceRunId, existing.getContinuationLineageId());
            List<String> completedToolCallIds = validateCompletedToolCallIds(admission.completedToolCallIds());
            runtimeJobGate.requireEligible(source, admission.lineageRunIds());
            eventPublisher.publishEvent(new ContinuationRunDispatchRequestedEvent(
                    sourceRunId, result.runId(), completedToolCallIds));
        }
        return result;
    }

    private void requireReplayCheckpointFresh(ChatRun source, ChatRun existing) {
        String branchId = canonicalUuid(source.getBranchId(), "source branch");
        AgentGraphCheckpointService.ContinuationCheckpointView checkpoint =
                checkpoints.findLatestSafeCheckpointForSourceRun(source.getId().toString(),
                        new AgentGraphCheckpointService.OwnerRequest(
                                source.getSessionId(), source.getUserId(), source.getWorkspaceId()));
        if (checkpoint == null) {
            throw new CpApiException(HttpStatus.CONFLICT, "CONTINUATION_CHECKPOINT_MISSING",
                    "No safe checkpoint is available for this source Run");
        }
        requireCheckpointBinding(checkpoint, source, branchId);
        if (!existing.getContinuationLineageId().equals(checkpoint.lineageId())
                || !existing.getContinuationThreadId().equals(checkpoint.threadId())
                || !existing.getContinuationCheckpointId().equals(checkpoint.checkpointId())) {
            throw new CpApiException(HttpStatus.CONFLICT, "CONTINUATION_CHECKPOINT_INVALID",
                    "The idempotent child Run no longer references the latest safe checkpoint");
        }
        if (existing.getContinuationEventSequence() != checkpoint.eventSequence()
                || checkpoint.eventSequence() != checkpoint.currentVisibleBranchHead()) {
            throw sourceStale();
        }
    }

    private static ContinuationResult resultFrom(ChatRun run, boolean replayed) {
        return new ContinuationResult(run.getId().toString(), run.getContinuationMode(), run.getStatus(), replayed,
                run.getContinuationLineageId(), run.getContinuationThreadId(), run.getContinuationCheckpointId(),
                run.getContinuationEventSequence(), run.getBranchId());
    }

    private static void requireCheckpointBinding(AgentGraphCheckpointService.ContinuationCheckpointView view,
                                                 ChatRun source, String branchId) {
        if (!source.getSessionId().equals(view.sessionId())
                || !source.getUserId().equals(view.userId())
                || !source.getWorkspaceId().equals(view.workspaceId())
                || !branchId.equals(view.branchId())
                || view.lineageId() == null || view.threadId() == null || view.checkpointId() == null
                || view.schemaVersion() != 1) {
            throw new CpApiException(HttpStatus.CONFLICT, "CONTINUATION_CHECKPOINT_INVALID",
                    "The source checkpoint does not match the source Run owner and branch");
        }
    }

    private static UUID parseSourceRunId(String value) {
        try {
            return UUID.fromString(value);
        } catch (RuntimeException e) {
            throw runNotFound();
        }
    }

    private static String canonicalUuid(String value, String field) {
        try {
            return UUID.fromString(value).toString();
        } catch (RuntimeException e) {
            throw new CpApiException(HttpStatus.CONFLICT, "CONTINUATION_CHECKPOINT_INVALID",
                    "The source Run has an invalid " + field, e);
        }
    }

    private static List<String> validateCompletedToolCallIds(List<String> ids) {
        if (ids == null || ids.size() > LineageInvocationService.MAX_COMPLETED_TOOL_CALL_IDS) {
            throw new CpApiException(HttpStatus.CONFLICT, "RECONCILIATION_REQUIRED",
                    "Completed tool-call evidence is missing or exceeds the safe continuation bound");
        }
        Set<String> unique = new java.util.HashSet<>();
        List<String> result = new ArrayList<>(ids.size());
        for (String id : ids) {
            if (id == null || id.isBlank()
                    || id.length() > LineageInvocationService.MAX_ORIGINATING_TOOL_CALL_ID_LENGTH
                    || id.indexOf('\0') >= 0 || id.chars().anyMatch(Character::isISOControl)
                    || !unique.add(id)) {
                throw new CpApiException(HttpStatus.CONFLICT, "RECONCILIATION_REQUIRED",
                        "Completed tool-call evidence is invalid");
            }
            result.add(id);
        }
        result.sort(String::compareTo);
        return List.copyOf(result);
    }

    private static void requireSourceOwner(ChatRun source, String userId, String workspaceId) {
        if (!userId.equals(source.getUserId()) || !workspaceId.equals(source.getWorkspaceId())) {
            throw forbidden();
        }
    }

    private static CpApiException runNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
    }

    private static CpApiException forbidden() {
        return new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                "Chat run or Session does not belong to current user/workspace");
    }

    private static CpApiException sourceStale() {
        return new CpApiException(HttpStatus.CONFLICT, "CONTINUATION_SOURCE_STALE",
                "The source branch advanced after the selected checkpoint");
    }

    record ContinuationResult(String runId, String mode, String status, boolean replayed,
                              String lineageId, String threadId, String checkpointId,
                              Long eventSequence, String branchId) {}
}
