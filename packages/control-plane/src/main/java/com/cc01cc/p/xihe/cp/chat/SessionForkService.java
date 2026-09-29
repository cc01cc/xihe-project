package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionForkRequest;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.files.SessionForkRecoveryService;
import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionForkRequestRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import jakarta.persistence.EntityManager;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.UUID;

@Service
public class SessionForkService {

    private static final Logger logger = LoggerFactory.getLogger(SessionForkService.class);

    private final TransactionTemplate newTransaction;
    private final SessionRepository sessions;
    private final SessionForkRequestRepository forkRequests;
    private final MessageRepository messages;
    private final FileRepository files;
    private final ChatRunRepository runs;
    private final EventStoreService eventStore;
    private final ContextService contextService;
    private final BranchPathService branchPathService;
    private final SessionService sessionService;
    private final ChatAttachmentService attachmentService;
    private final SessionForkRecoveryService recoveryService;
    private final DbLockTimeout dbLockTimeout;
    private final ObjectMapper objectMapper;
    private final EntityManager entityManager;

    public SessionForkService(PlatformTransactionManager transactionManager,
                              SessionRepository sessions,
                              SessionForkRequestRepository forkRequests,
                              MessageRepository messages,
                              FileRepository files,
                              ChatRunRepository runs,
                              EventStoreService eventStore,
                              ContextService contextService,
                              BranchPathService branchPathService,
                              SessionService sessionService,
                              ChatAttachmentService attachmentService,
                              SessionForkRecoveryService recoveryService,
                              DbLockTimeout dbLockTimeout,
                              ObjectMapper objectMapper,
                              EntityManager entityManager) {
        this.newTransaction = new TransactionTemplate(transactionManager);
        this.newTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.sessions = sessions;
        this.forkRequests = forkRequests;
        this.messages = messages;
        this.files = files;
        this.runs = runs;
        this.eventStore = eventStore;
        this.contextService = contextService;
        this.branchPathService = branchPathService;
        this.sessionService = sessionService;
        this.attachmentService = attachmentService;
        this.recoveryService = recoveryService;
        this.dbLockTimeout = dbLockTimeout;
        this.objectMapper = objectMapper;
        this.entityManager = entityManager;
    }

    public ForkResult fork(String sourceSessionId, String userId, String workspaceId,
                           String sourceBranchId, String anchorMessageId, String idempotencyKey) {
        String normalizedKey = normalizeIdempotencyKey(idempotencyKey);
        UUID sourceUuid = parseUuid(sourceSessionId, "sourceSessionId");
        UUID branchUuid = parseUuid(sourceBranchId, "sourceBranchId");
        UUID anchorUuid = parseUuid(anchorMessageId, "anchorMessageId");
        String requestHash = requestHash(sourceUuid, branchUuid, anchorUuid);

        SessionForkRequest prior = forkRequests.findBySourceSessionIdAndIdempotencyKey(
                sourceUuid, normalizedKey).orElse(null);
        if (prior != null && SessionForkRequest.COMPLETED.equals(prior.getState())) {
            ForkResult replay = replayChild(prior.getChildSessionId(), userId, workspaceId);
            if (!requestHash.equals(prior.getRequestHash())) {
                throw idempotencyConflict();
            }
            return replay;
        }

        sessionService.requireCurrent(sourceUuid.toString(), userId, workspaceId);
        if (prior != null) {
            if (!requestHash.equals(prior.getRequestHash())) {
                throw idempotencyConflict();
            }
            if (SessionForkRequest.COMPLETED.equals(prior.getState())) {
                return replayChild(prior.getChildSessionId(), userId, workspaceId);
            }
            if (SessionForkRequest.COPYING.equals(prior.getState())) {
                throw idempotencyInProgress();
            }
            if (SessionForkRequest.CLEANUP_PENDING.equals(prior.getState())
                    && !retryCleanup(prior.getChildSessionId())) {
                throw cleanupPending();
            }
        }

        RequestClaim claim;
        try {
            claim = newTransaction.execute(status -> reserveRequest(
                    sourceUuid, userId, workspaceId, branchUuid, anchorUuid, normalizedKey, requestHash));
        } catch (CannotAcquireLockException e) {
            throw new CpApiException(HttpStatus.CONFLICT, "FORK_REQUEST_IN_PROGRESS",
                    "The source Session is being changed; retry the fork request", e);
        }
        if (claim == null) {
            throw new IllegalStateException("Fork request reservation returned no result");
        }

        if (claim.kind() == ClaimKind.REPLAY) {
            return replayChild(claim.childSessionId(), userId, workspaceId);
        }
        if (claim.kind() == ClaimKind.IN_PROGRESS) {
            throw idempotencyInProgress();
        }
        if (claim.kind() == ClaimKind.CLEANUP_PENDING) {
            if (!retryCleanup(claim.childSessionId())) {
                throw cleanupPending();
            }
            try {
                claim = newTransaction.execute(status -> reserveRequest(
                        sourceUuid, userId, workspaceId, branchUuid, anchorUuid, normalizedKey, requestHash));
            } catch (CannotAcquireLockException e) {
                throw idempotencyInProgress();
            }
            if (claim == null) {
                throw new IllegalStateException("Fork retry reservation returned no result");
            }
            if (claim.kind() == ClaimKind.REPLAY) {
                return replayChild(claim.childSessionId(), userId, workspaceId);
            }
            if (claim.kind() == ClaimKind.IN_PROGRESS || claim.kind() == ClaimKind.CLEANUP_PENDING) {
                throw idempotencyInProgress();
            }
        }

        RequestClaim publishClaim = claim;
        try {
            Session child = newTransaction.execute(status -> {
                try {
                    return publishChild(publishClaim);
                } catch (RequestRowBusyException e) {
                    throw e;
                } catch (RuntimeException e) {
                    throw new ForkPublishFailure(e);
                }
            });
            if (child == null) {
                throw new IllegalStateException("Fork publication returned no child Session");
            }
            return new ForkResult(child, false);
        } catch (RequestRowBusyException e) {
            throw idempotencyInProgress();
        } catch (ForkPublishFailure e) {
            return failAndRecover(publishClaim, e.original(), userId, workspaceId);
        } catch (CannotAcquireLockException e) {
            // The transaction itself could not be started/committed. Cleanup is
            // safe because the request-row body either never started or rolled back.
            return failAndRecover(publishClaim, e, userId, workspaceId);
        } catch (RuntimeException e) {
            return failAndRecover(publishClaim, e, userId, workspaceId);
        }
    }

    private RequestClaim reserveRequest(UUID sourceSessionId, String userId, String workspaceId,
                                        UUID sourceBranchId, UUID anchorMessageId,
                                        String idempotencyKey, String requestHash) {
        dbLockTimeout.apply();
        Session source = sessions.findByIdForUpdate(sourceSessionId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
        entityManager.refresh(source);
        if (source.isArchived() || !userId.equals(source.getUserId()) || !workspaceId.equals(source.getWorkspaceId())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
        if (source.getAgentPrincipalId() == null || source.getAgentPrincipalId().isBlank()) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_PRINCIPAL_REQUIRED",
                    "A fork requires a stable AgentPrincipal on the source Session");
        }

        var existing = forkRequests.findBySourceSessionIdAndIdempotencyKeyForUpdate(
                sourceSessionId, idempotencyKey).orElse(null);
        if (existing != null) {
            if (!requestHash.equals(existing.getRequestHash())) {
                throw idempotencyConflict();
            }
            if (SessionForkRequest.COMPLETED.equals(existing.getState())) {
                return RequestClaim.replay(existing.getChildSessionId());
            }
            if (SessionForkRequest.COPYING.equals(existing.getState())) {
                return RequestClaim.inProgress(existing.getChildSessionId());
            }
            if (SessionForkRequest.CLEANUP_PENDING.equals(existing.getState())) {
                return RequestClaim.cleanupPending(existing.getChildSessionId());
            }
            if (!SessionForkRequest.RETRYABLE.equals(existing.getState())) {
                throw new IllegalStateException("Unknown fork request state " + existing.getState());
            }
            BranchPathService.AnchorResolution anchor = resolveAnchor(
                    sourceSessionId, workspaceId, sourceBranchId, anchorMessageId);
            existing.setState(SessionForkRequest.COPYING);
            existing.setLastErrorCode(null);
            forkRequests.saveAndFlush(existing);
            return RequestClaim.copy(existing.getChildSessionId(), sourceSessionId, userId, workspaceId,
                    sourceBranchId, anchor, requestHash);
        }

        BranchPathService.AnchorResolution anchor = resolveAnchor(
                sourceSessionId, workspaceId, sourceBranchId, anchorMessageId);
        UUID childSessionId = UUID.randomUUID();
        SessionForkRequest request = new SessionForkRequest(
                childSessionId, sourceSessionId, idempotencyKey, requestHash, childSessionId.toString());
        forkRequests.saveAndFlush(request);
        return RequestClaim.copy(childSessionId, sourceSessionId, userId, workspaceId,
                sourceBranchId, anchor, requestHash);
    }

    private BranchPathService.AnchorResolution resolveAnchor(UUID sourceSessionId, String workspaceId,
                                                             UUID sourceBranchId, UUID anchorMessageId) {
        BranchPathService.BranchVisibility visibility = branchPathService.resolveVisibility(
                sourceSessionId.toString(), sourceBranchId.toString());
        BranchPathService.AnchorResolution anchor = branchPathService.resolveAnchor(
                sourceSessionId.toString(), workspaceId, anchorMessageId.toString());
        if (!visibility.isVisible(anchor.branchId(), anchor.cursor())) {
            throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_INVALID",
                    "The anchor message is not visible on the selected source branch path");
        }
        return anchor;
    }

    private Session publishChild(RequestClaim claim) {
        dbLockTimeout.apply();
        SessionForkRequest request;
        try {
            request = forkRequests.findByChildSessionIdForUpdate(claim.childSessionId())
                    .orElseThrow(() -> new IllegalStateException("Reserved fork request disappeared"));
        } catch (CannotAcquireLockException e) {
            throw new RequestRowBusyException(e);
        }
        if (SessionForkRequest.COMPLETED.equals(request.getState())) {
            return sessionService.requireCurrent(claim.childSessionId().toString(), claim.userId(), claim.workspaceId());
        }
        if (!SessionForkRequest.COPYING.equals(request.getState())) {
            throw new CpApiException(HttpStatus.CONFLICT, "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                    "Fork request is not ready to publish");
        }
        if (!claim.requestHash().equals(request.getRequestHash())) {
            throw idempotencyConflict();
        }

        Session source = sessions.findById(claim.sourceSessionId())
                .filter(candidate -> !candidate.isArchived()
                        && claim.userId().equals(candidate.getUserId())
                        && claim.workspaceId().equals(candidate.getWorkspaceId()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
        BranchPathService.AnchorResolution currentAnchor = resolveAnchor(
                claim.sourceSessionId(), claim.workspaceId(),
                UUID.fromString(claim.sourceBranchId()), UUID.fromString(claim.anchorMessageId()));
        if (currentAnchor.cursor() != claim.anchorCursor()
                || !currentAnchor.runId().equals(claim.anchorRunId())) {
            throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_UNAVAILABLE",
                    "The source anchor changed while the fork was being prepared");
        }

        List<Message> sourceMessages = visibleSourceMessages(claim, source);
        ObjectNode seed = contextService.buildForkSeed(
                claim.sourceSessionId().toString(), claim.sourceBranchId(), claim.anchorCursor());
        seed.put("contextEpoch", UUID.randomUUID().toString());

        Session child = sessionService.createForkSession(
                claim.sourceSessionId().toString(), claim.childSessionId(), claim.anchorRunId(),
                claim.userId(), claim.workspaceId());
        entityManager.refresh(child);
        String childSessionId = child.getId().toString();
        String childRootBranchId = branchPathService.ensureRootBranchId(childSessionId);

        Map<UUID, List<File>> sourceFilesByMessage = new HashMap<>();
        if (!sourceMessages.isEmpty()) {
            List<String> sourceMessageIds = sourceMessages.stream()
                    .map(message -> message.getId().toString())
                    .toList();
            for (File sourceFile : files.findByMessageIdsForUpdateOrderByIdAsc(sourceMessageIds)) {
                sourceFilesByMessage.computeIfAbsent(UUID.fromString(sourceFile.getMessageId()), ignored -> new ArrayList<>())
                        .add(sourceFile);
            }
        }

        for (Message sourceMessage : sourceMessages) {
            Message childMessage = new Message(childSessionId, sourceMessage.getRole(), sourceMessage.getContent());
            childMessage.setRunId(sourceMessage.getRunId());
            childMessage.setBranchId(childRootBranchId);
            childMessage = messages.saveAndFlush(childMessage);
            childMessage.setAttachments(copyAttachments(sourceMessage, childMessage, claim,
                    sourceFilesByMessage.getOrDefault(sourceMessage.getId(), List.of())));
            messages.save(childMessage);
        }

        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("source_session_id", claim.sourceSessionId().toString());
        payload.put("anchor_message_id", claim.anchorMessageId());
        payload.set("summary_seed", seed);
        eventStore.append(childSessionId, claim.workspaceId(), claim.userId(),
                "session.forked", payload, null, null);
        request.setState(SessionForkRequest.COMPLETED);
        request.setLastErrorCode(null);
        forkRequests.save(request);
        logger.info("[LIFECYCLE] service=cp event=session_forked childSessionId={} sourceSessionId={} messageCount={}",
                childSessionId, claim.sourceSessionId(), sourceMessages.size());
        return child;
    }

    private List<Message> visibleSourceMessages(RequestClaim claim, Session source) {
        BranchPathService.BranchVisibility visibility = branchPathService.resolveVisibility(
                claim.sourceSessionId().toString(), claim.sourceBranchId());
        Map<Long, UUID> messageIdBySequence = new TreeMap<>();
        Map<UUID, ChatRun> runCache = new HashMap<>();
        List<ContextEvent> pathEvents = eventStore.read(claim.sourceSessionId().toString(), 0L, visibility);
        for (ContextEvent event : pathEvents) {
            if (event.getSequence() > claim.anchorCursor() || event.getCorrelationId() == null
                    || event.getCorrelationId().isBlank()) {
                continue;
            }
            if (!"prompt.admitted".equals(event.getEventType())
                    && !"assistant.responded".equals(event.getEventType())) {
                continue;
            }
            UUID runId = UUID.fromString(event.getCorrelationId());
            ChatRun run = runCache.computeIfAbsent(runId, id -> runs.findById(id)
                    .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT,
                            "BRANCH_ANCHOR_UNAVAILABLE", "A visible context event has no durable Run")));
            if (!claim.sourceSessionId().toString().equals(run.getSessionId())
                    || !Objects.equals(runId.toString(), event.getCorrelationId())
                    || !Objects.equals(run.getBranchId(), event.getBranchId())) {
                throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_UNAVAILABLE",
                        "A visible context event does not match its durable Run branch");
            }
            String messageId = "prompt.admitted".equals(event.getEventType())
                    ? run.getUserMessageId() : run.getAssistantMessageId();
            if (messageId == null || messageId.isBlank()) {
                throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_UNAVAILABLE",
                        "A visible prompt/assistant event has no durable Message row");
            }
            messageIdBySequence.put(event.getSequence(), UUID.fromString(messageId));
        }

        Map<UUID, Message> messagesById = new HashMap<>();
        for (Message message : messages.findBySessionIdOrderByCreatedAtAsc(claim.sourceSessionId().toString())) {
            messagesById.put(message.getId(), message);
        }
        List<Message> visible = new ArrayList<>();
        if (Session.KIND_FORK.equals(source.getKind()) && hasChildSeed(pathEvents)) {
            String rootBranchId = branchPathService.resolvePath(
                    claim.sourceSessionId().toString(), claim.sourceBranchId());
            for (Message message : messagesById.values()) {
                if (!rootBranchId.equals(message.getBranchId())) {
                    continue;
                }
                if (message.getRunId() == null || message.getRunId().isBlank()) {
                    visible.add(message);
                    continue;
                }
                ChatRun messageRun;
                try {
                    messageRun = runs.findById(UUID.fromString(message.getRunId())).orElse(null);
                } catch (IllegalArgumentException invalidRunId) {
                    messageRun = null;
                }
                if (messageRun == null || !claim.sourceSessionId().toString().equals(messageRun.getSessionId())) {
                    // A fork child stores its copied prefix in the root branch. The Run IDs on those
                    // SQL Message rows are lineage only and may be SET NULL when the source is deleted.
                    visible.add(message);
                }
            }
            visible.sort(java.util.Comparator.comparing(Message::getCreatedAt)
                    .thenComparing(Message::getId));
        }
        for (Map.Entry<Long, UUID> entry : messageIdBySequence.entrySet()) {
            Message message = messagesById.get(entry.getValue());
            if (message == null
                    || !claim.sourceSessionId().toString().equals(message.getSessionId())) {
                throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_UNAVAILABLE",
                        "A visible context message is missing from the source Session");
            }
            if (message.getRunId() == null) {
                throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_UNAVAILABLE",
                        "A visible Message has no durable Run");
            }
            ChatRun run = runCache.get(UUID.fromString(message.getRunId()));
            if (run == null || !Objects.equals(message.getBranchId(), run.getBranchId())) {
                throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_UNAVAILABLE",
                        "A visible Message does not match its Run branch");
            }
            visible.add(message);
        }
        return visible;
    }

    private boolean hasChildSeed(List<ContextEvent> events) {
        for (ContextEvent event : events) {
            if (!"session.forked".equals(event.getEventType())) {
                continue;
            }
            try {
                JsonNode payload = objectMapper.readTree(event.getPayload());
                if (payload.path("summary_seed").isObject()) {
                    return true;
                }
            } catch (JsonProcessingException e) {
                throw new IllegalStateException("Fork lineage event payload is invalid", e);
            }
        }
        return false;
    }

    private String copyAttachments(Message sourceMessage, Message childMessage, RequestClaim claim,
                                   List<File> sourceFiles) {
        if (sourceFiles.isEmpty()) {
            if (sourceMessage.getAttachments() != null && !sourceMessage.getAttachments().isBlank()) {
                try {
                    List<AttachmentInfo> metadata = objectMapper.readValue(sourceMessage.getAttachments(),
                            new TypeReference<>() { });
                    if (!metadata.isEmpty()) {
                        throw new CpApiException(HttpStatus.CONFLICT, "FORK_SOURCE_ATTACHMENT_CHANGED",
                                "A source attachment is missing its durable File row");
                    }
                } catch (JsonProcessingException e) {
                    throw new CpApiException(HttpStatus.CONFLICT, "FORK_SOURCE_ATTACHMENT_CHANGED",
                            "Source attachment metadata is invalid", e);
                }
            }
            return sourceMessage.getAttachments();
        }

        List<AttachmentInfo> childAttachments = new ArrayList<>();
        for (File sourceFile : sourceFiles) {
            File childFile = attachmentService.copyForFork(
                    sourceFile.getId(), claim.sourceSessionId().toString(), sourceMessage.getId().toString(),
                    claim.childSessionId().toString(), childMessage.getId().toString(),
                    claim.userId(), claim.workspaceId());
            childAttachments.add(new AttachmentInfo(childFile.getId().toString(), childFile.getFilename(),
                    childFile.getMimeType(), childFile.getSizeBytes(), "/api/v1/files/" + childFile.getId()));
        }
        try {
            return objectMapper.writeValueAsString(childAttachments);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize copied fork attachments", e);
        }
    }

    private boolean retryCleanup(UUID childSessionId) {
        try {
            return recoveryService.retryCleanup(childSessionId);
        } catch (CannotAcquireLockException e) {
            return false;
        }
    }

    private boolean cleanupAfterFailure(UUID childSessionId, RuntimeException failure) {
        boolean cleaned = retryCleanup(childSessionId);
        SessionForkRequest request = forkRequests.findById(childSessionId).orElse(null);
        if (request != null && SessionForkRequest.COMPLETED.equals(request.getState())) {
            return true;
        }
        if (!cleaned) {
            logger.error("[LIFECYCLE] service=cp event=fork_cleanup_required childSessionId={} failureType={}",
                    childSessionId, failure.getClass().getSimpleName());
        }
        return cleaned;
    }

    private ForkResult failAndRecover(RequestClaim claim, RuntimeException failure,
                                      String userId, String workspaceId) {
        boolean cleaned;
        try {
            cleaned = cleanupAfterFailure(claim.childSessionId(), failure);
        } catch (RuntimeException cleanupFailure) {
            logger.error("[LIFECYCLE] service=cp event=fork_cleanup_reconcile_failed childSessionId={} "
                            + "exceptionType={}",
                    claim.childSessionId(), cleanupFailure.getClass().getSimpleName());
            cleaned = false;
        }
        SessionForkRequest request = forkRequests.findById(claim.childSessionId()).orElse(null);
        if (request != null && SessionForkRequest.COMPLETED.equals(request.getState())) {
            return replayChild(claim.childSessionId(), userId, workspaceId);
        }
        if (!cleaned) {
            throw cleanupPending();
        }
        if (failure instanceof CpApiException apiException) {
            throw apiException;
        }
        if (failure instanceof CannotAcquireLockException) {
            throw forkInProgress();
        }
        logger.error("[LIFECYCLE] service=cp event=session_fork_failed sourceSessionId={} childSessionId={} "
                        + "exceptionType={}",
                claim.sourceSessionId(), claim.childSessionId(), failure.getClass().getSimpleName());
        throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                "Fork failed; retry with the same Idempotency-Key");
    }

    private ForkResult replayChild(UUID childSessionId, String userId, String workspaceId) {
        Session child = sessionService.requireCurrent(childSessionId.toString(), userId, workspaceId);
        return new ForkResult(child, true);
    }

    private static String normalizeIdempotencyKey(String key) {
        if (key == null || key.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "IDEMPOTENCY_KEY_REQUIRED",
                    "Idempotency-Key is required to fork a Session");
        }
        String normalized = key.trim();
        if (normalized.length() > 128) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Idempotency-Key exceeds 128 characters");
        }
        return normalized;
    }

    private static UUID parseUuid(String value, String field) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", field + " must be a UUID", e);
        }
    }

    private static String requestHash(UUID sourceSessionId, UUID sourceBranchId, UUID anchorMessageId) {
        String canonical = sourceSessionId + "\u0000" + sourceBranchId + "\u0000" + anchorMessageId;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private static CpApiException idempotencyConflict() {
        return new CpApiException(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_CONFLICT",
                "Idempotency-Key was already used with a different fork request");
    }

    private static CpApiException idempotencyInProgress() {
        return new CpApiException(HttpStatus.CONFLICT, "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                "A fork request with this key is still in progress; retry with the same key");
    }

    private static CpApiException forkInProgress() {
        return new CpApiException(HttpStatus.CONFLICT, "FORK_REQUEST_IN_PROGRESS",
                "The source Session is being changed; retry the fork request");
    }

    private static CpApiException cleanupPending() {
        return new CpApiException(HttpStatus.SERVICE_UNAVAILABLE, "FORK_CLEANUP_PENDING",
                "Fork cleanup is pending; retry with the same Idempotency-Key");
    }

    private static String safeDetail(RuntimeException failure) {
        if (failure instanceof CpApiException apiException) {
            return apiException.getMessage();
        }
        return "Fork failed; retry with the same Idempotency-Key";
    }

    public record ForkResult(Session session, boolean replayed) { }

    private enum ClaimKind {
        COPY,
        REPLAY,
        IN_PROGRESS,
        CLEANUP_PENDING
    }

    private record RequestClaim(ClaimKind kind, UUID childSessionId, UUID sourceSessionId,
                                String userId, String workspaceId, String sourceBranchId,
                                String anchorMessageId, String anchorRunId, long anchorCursor,
                                String requestHash) {
        private static RequestClaim copy(UUID childSessionId, UUID sourceSessionId, String userId,
                                         String workspaceId, UUID sourceBranchId,
                                         BranchPathService.AnchorResolution anchor,
                                         String requestHash) {
            return new RequestClaim(ClaimKind.COPY, childSessionId, sourceSessionId, userId, workspaceId,
                    sourceBranchId.toString(), anchor.messageId(), anchor.runId(), anchor.cursor(), requestHash);
        }

        private static RequestClaim replay(UUID childSessionId) {
            return new RequestClaim(ClaimKind.REPLAY, childSessionId, null, null, null,
                    null, null, null, 0L, null);
        }

        private static RequestClaim inProgress(UUID childSessionId) {
            return new RequestClaim(ClaimKind.IN_PROGRESS, childSessionId, null, null, null,
                    null, null, null, 0L, null);
        }

        private static RequestClaim cleanupPending(UUID childSessionId) {
            return new RequestClaim(ClaimKind.CLEANUP_PENDING, childSessionId, null, null, null,
                    null, null, null, 0L, null);
        }
    }

    private static final class RequestRowBusyException extends RuntimeException {
        private RequestRowBusyException(Throwable cause) {
            super(cause);
        }
    }

    private static final class ForkPublishFailure extends RuntimeException {
        private final RuntimeException original;

        private ForkPublishFailure(RuntimeException original) {
            super(original);
            this.original = original;
        }

        private RuntimeException original() {
            return original;
        }
    }
}
