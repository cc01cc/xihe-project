package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunGuidance;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunGuidanceRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import jakarta.persistence.EntityManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0528: single transition owner for Run-scoped Guidance records.
 *
 * <p>Frozen wire/state contract: {@code spec/cp-guidance-contract.md}. Status
 * changes only go through this service; terminal-expired migration happens in
 * the Run terminal transaction (see ChatRunTerminalService) so a crashing CP
 * can never leave a terminal run with pending guidance. Logs never carry the
 * guidance body (untrusted request content).
 */
@Service
public class ChatRunGuidanceService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunGuidanceService.class);

    /** Run statuses that admit guidance submission (frozen: spec §3.1). */
    private static final java.util.Set<String> SUBMITTABLE_RUN_STATUSES =
            java.util.Set.of("running", "streaming", "awaiting_approval");

    static final int MAX_BODY_LENGTH = 8000;
    static final String ERROR_RUN_NOT_ACTIVE = "GUIDANCE_RUN_NOT_ACTIVE";
    static final String ERROR_ALREADY_TERMINAL_EXPIRED = "GUIDANCE_ALREADY_TERMINAL_EXPIRED";

    private final ChatRunGuidanceRepository guidance;
    private final ChatRunRepository runs;
    private final SessionRepository sessions;
    private final DbLockTimeout dbLockTimeout;
    private final EntityManager entityManager;

    ChatRunGuidanceService(ChatRunGuidanceRepository guidance,
                           ChatRunRepository runs,
                           SessionRepository sessions,
                           DbLockTimeout dbLockTimeout,
                           EntityManager entityManager) {
        this.guidance = guidance;
        this.runs = runs;
        this.sessions = sessions;
        this.dbLockTimeout = dbLockTimeout;
        this.entityManager = entityManager;
    }

    public record SubmitResult(ChatRunGuidance record, boolean replayed) {
    }

    @Transactional
    public SubmitResult submit(String runIdValue, String userId, String workspaceId,
                               String idempotencyKey, String content) {
        if (idempotencyKey == null || idempotencyKey.isBlank() || idempotencyKey.length() > 128) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "GUIDANCE_IDEMPOTENCY_KEY_REQUIRED",
                    "Idempotency-Key header is required");
        }
        if (content == null || content.isBlank()) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "GUIDANCE_CONTENT_REQUIRED",
                    "Guidance content must not be blank");
        }
        if (content.length() > MAX_BODY_LENGTH) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "GUIDANCE_CONTENT_TOO_LONG",
                    "Guidance content exceeds " + MAX_BODY_LENGTH + " characters");
        }
        UUID runUuid = parseUuid(runIdValue, "runId");
        UUID userUuid = parseUuid(userId, "userId");

        ChatRun observed = runs.findById(runUuid).orElseThrow(ChatRunGuidanceService::runNotFound);
        UUID sessionUuid = UUID.fromString(observed.getSessionId());

        ChatRunGuidance replay = guidance.findByRunIdAndIdempotencyKey(runUuid, idempotencyKey).orElse(null);
        if (replay != null) {
            return new SubmitResult(replay, true);
        }

        dbLockTimeout.apply();
        Session session = sessions.findByIdForUpdate(sessionUuid)
                .filter(candidate -> userId.equals(candidate.getUserId())
                        && workspaceId.equals(candidate.getWorkspaceId()) && !candidate.isArchived())
                .orElseThrow(ChatRunGuidanceService::forbidden);
        entityManager.refresh(session);
        if (session.getDeleteRequestedAt() != null) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_DELETING", "Session is being deleted");
        }

        ChatRun run = runs.findByIdForUpdate(runUuid).orElseThrow(ChatRunGuidanceService::runNotFound);
        entityManager.refresh(run);
        if (!session.getId().toString().equals(run.getSessionId())) {
            throw forbidden();
        }
        requireRunActive(run);

        ChatRunGuidance record = new ChatRunGuidance(UUID.randomUUID(), sessionUuid, runUuid,
                UUID.fromString(run.getBranchId()), userUuid, content,
                guidance.findMaxSequence(runUuid) + 1, idempotencyKey);
        record.markCreatedNow();
        try {
            guidance.saveAndFlush(record);
        } catch (DataIntegrityViolationException race) {
            // Unique (run_id, idempotency_key): concurrent replay wins.
            ChatRunGuidance winner = guidance.findByRunIdAndIdempotencyKey(runUuid, idempotencyKey)
                    .orElseThrow(() -> race);
            return new SubmitResult(winner, true);
        }
        logger.info("[LIFECYCLE] service=cp event=guidance_submitted runId={} guidanceId={} sequence={} status={}",
                runUuid, record.getId(), record.getSequence(), record.getStatus());
        return new SubmitResult(record, false);
    }

    @Transactional(readOnly = true)
    public List<ChatRunGuidance> snapshot(String runIdValue, String userId, String workspaceId) {
        UUID runUuid = parseUuid(runIdValue, "runId");
        ChatRun run = runs.findById(runUuid).orElseThrow(ChatRunGuidanceService::runNotFound);
        requireRunOwner(run, userId, workspaceId);
        return guidance.findByRunIdOrderBySequenceAsc(runUuid);
    }

    @Transactional(readOnly = true)
    public List<ChatRunGuidance> pendingForAgent(String runIdValue) {
        UUID runUuid = parseUuid(runIdValue, "runId");
        if (runs.findById(runUuid).isEmpty()) {
            throw runNotFound();
        }
        return guidance.findByRunIdAndStatusOrderBySequenceAsc(runUuid, ChatRunGuidance.STATUS_PENDING);
    }

    public record ConsumeResult(ChatRunGuidance record, boolean firstConsumption) {
    }

    @Transactional
    public ConsumeResult consume(String runIdValue, String guidanceIdValue) {
        UUID runUuid = parseUuid(runIdValue, "runId");
        UUID guidanceUuid = parseUuid(guidanceIdValue, "guidanceId");

        ChatRunGuidance record = guidance.findByIdAndRunId(guidanceUuid, runUuid)
                .orElseThrow(ChatRunGuidanceService::runNotFound);
        if (ChatRunGuidance.STATUS_TERMINAL_EXPIRED.equals(record.getStatus())) {
            throw new CpApiException(HttpStatus.CONFLICT, ERROR_ALREADY_TERMINAL_EXPIRED,
                    "Guidance expired before consumption; stop retrying and do not inject");
        }
        dbLockTimeout.apply();
        ChatRunGuidance locked = guidance.findByIdForUpdate(guidanceUuid).orElseThrow(
                ChatRunGuidanceService::runNotFound);
        boolean first = locked.markConsumed();
        guidance.saveAndFlush(locked);
        if (first) {
            logger.info("[LIFECYCLE] service=cp event=guidance_consumed runId={} guidanceId={} status={}",
                    runUuid, locked.getId(), locked.getStatus());
        }
        return new ConsumeResult(locked, first);
    }

    /**
     * Terminal settlement: pending → terminal_expired, called inside the run
     * terminal transaction (same-transaction invariant, spec §2).
     */
    @Transactional
    public void settleTerminal(UUID runUuid) {
        List<ChatRunGuidance> pending =
                guidance.findByRunIdAndStatusOrderBySequenceAsc(runUuid, ChatRunGuidance.STATUS_PENDING);
        for (ChatRunGuidance record : pending) {
            record.markTerminalExpired();
        }
        if (!pending.isEmpty()) {
            guidance.saveAll(pending);
            logger.info("[LIFECYCLE] service=cp event=guidance_terminal_expired runId={} expired={}",
                    runUuid, pending.size());
        }
    }

    /** One-shot startup sweep: expire guidance left pending on already-terminal runs. */
    @Transactional
    public int recoverPendingOnTerminalRuns() {
        List<ChatRunGuidance> stale = guidance.findByRunIdInAndStatus(
                runs.findIdsByStatusIn(ChatRunRepository.TERMINAL_STATUSES),
                ChatRunGuidance.STATUS_PENDING);
        for (ChatRunGuidance record : stale) {
            record.markTerminalExpired();
        }
        if (!stale.isEmpty()) {
            guidance.saveAll(stale);
        }
        return stale.size();
    }

    private void requireRunActive(ChatRun run) {
        if (!SUBMITTABLE_RUN_STATUSES.contains(run.getStatus())) {
            throw new CpApiException(HttpStatus.CONFLICT, ERROR_RUN_NOT_ACTIVE,
                    "Run is not accepting guidance: " + run.getStatus());
        }
    }

    private void requireRunOwner(ChatRun run, String userId, String workspaceId) {
        Session session = sessions.findById(UUID.fromString(run.getSessionId())).orElseThrow(
                ChatRunGuidanceService::forbidden);
        if (!userId.equals(session.getUserId()) || !workspaceId.equals(session.getWorkspaceId())) {
            throw forbidden();
        }
    }

    private static CpApiException runNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "GUIDANCE_RUN_NOT_FOUND", "Run not found");
    }

    private static CpApiException forbidden() {
        return new CpApiException(HttpStatus.FORBIDDEN, "GUIDANCE_FORBIDDEN", "Not permitted");
    }

    private static UUID parseUuid(String value, String label) {
        try {
            return UUID.fromString(value);
        } catch (RuntimeException invalid) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "GUIDANCE_RUN_NOT_FOUND", label + " not found");
        }
    }
}
