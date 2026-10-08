package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem;
import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.SessionFollowUpItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import jakarta.persistence.EntityManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.Function;

/** Durable owner for the Session-scoped Follow-up FIFO. */
@Service
public class FollowUpQueueService {
    private static final Logger logger = LoggerFactory.getLogger(FollowUpQueueService.class);
    public static final int CAPACITY_LIMIT = 5;
    static final int MAX_ADMISSION_RETRIES = 1;
    private static final String PAUSE_STALE_ANCHOR = "anchor_unavailable";
    private static final long LEASE_RECHECK_MARGIN_MILLIS = 50;
    private static final Set<String> SUCCESS_TRIGGER_STATUSES = Set.of("succeeded", "partial", "failed");
    private static final Set<String> TERMINAL_STATUSES = Set.of(
            "succeeded", "partial", "failed", "cancelled", "ambiguous");

    private final SessionRepository sessions;
    private final SessionFollowUpItemRepository items;
    private final ChatRunRepository runs;
    private final FileRepository files;
    private final BranchPathService branches;
    private final DbLockTimeout lockTimeout;
    private final ObjectMapper mapper;
    private final EntityManager entityManager;
    private final ApplicationEventPublisher events;
    private final TaskScheduler taskScheduler;

    public FollowUpQueueService(SessionRepository sessions,
                                SessionFollowUpItemRepository items,
                                ChatRunRepository runs,
                                FileRepository files,
                                BranchPathService branches,
                                 DbLockTimeout lockTimeout,
                                 ObjectMapper mapper,
                                 EntityManager entityManager,
                                 ApplicationEventPublisher events,
                                 TaskScheduler taskScheduler) {
        this.sessions = sessions;
        this.items = items;
        this.runs = runs;
        this.files = files;
        this.branches = branches;
        this.lockTimeout = lockTimeout;
        this.mapper = mapper;
        this.entityManager = entityManager;
        this.events = events;
        this.taskScheduler = taskScheduler;
    }

    @Order(Ordered.LOWEST_PRECEDENCE)
    @EventListener(ApplicationReadyEvent.class)
    @Transactional
    public void recoverQueueOnStartup(ApplicationReadyEvent event) {
        int pausedMissingChildren = 0;
        for (String sessionId : items.findDistinctSessionsWithMissingAdmittedChild()) {
            lockTimeout.apply();
            Session session = sessions.findByIdForUpdate(parseUuid(sessionId, "sessionId")).orElse(null);
            if (session == null) {
                continue;
            }
            entityManager.refresh(session);
            if (session.isArchived() || session.getDeleteRequestedAt() != null) {
                continue;
            }
            List<SessionFollowUpItem> missing = items.findAdmittedItemsWithMissingChildForUpdate(sessionId);
            if (missing.isEmpty()) {
                continue;
            }
            long firstMissingSequence = missing.getFirst().getQueueSequence();
            List<SessionFollowUpItem> queue = outstanding(sessionId);
            for (SessionFollowUpItem item : queue) {
                if (item.getQueueSequence() < firstMissingSequence
                        || (!SessionFollowUpItem.STATUS_ADMITTED.equals(item.getStatus())
                            && !SessionFollowUpItem.STATUS_QUEUED.equals(item.getStatus())
                            && !SessionFollowUpItem.STATUS_PAUSED.equals(item.getStatus()))) {
                    continue;
                }
                item.setStatus(SessionFollowUpItem.STATUS_PAUSED);
                item.setPauseReason(SessionFollowUpItem.PAUSE_CHILD_MISSING);
                item.setPauseRunId(null);
            }
            items.saveAll(queue);
            pausedMissingChildren += missing.size();
        }

        List<String> queuedHeads = items.findDistinctQueuedHeadSessionIds(
                SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
        queuedHeads.forEach(sessionId -> publishAfterCommit(new FollowUpQueueWakeupEvent(sessionId)));
        logger.info("[LIFECYCLE] service=cp event=follow_up_queue_recovery_completed "
                        + "pausedMissingChildren={} queuedHeadSessions={} readyEvent={}",
                pausedMissingChildren, queuedHeads.size(), event.getClass().getSimpleName());
    }

    @Transactional
    public EnqueueResult enqueue(String sessionId, String userId, String workspaceId,
                                 String idempotencyKey, FollowUpCreateRequest request) {
        Session session = lockAuthorizedSession(sessionId, userId, workspaceId);
        validateIdempotencyKey(idempotencyKey);
        boolean unboundProvider = session.getProviderConnectionId() == null;
        Map<String, Integer> timeouts = validateRequest(request, unboundProvider);

        String hash = requestHash(sessionId, request, timeouts, unboundProvider);
        SessionFollowUpItem previous = items.findBySessionIdAndIdempotencyKey(sessionId, idempotencyKey)
                .orElse(null);
        if (previous != null) {
            if (!hash.equals(previous.getRequestHash())) {
                throw conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was used for a different request");
            }
            return new EnqueueResult(snapshotLocked(sessionId), true);
        }

        List<SessionFollowUpItem> outstanding = outstanding(sessionId);
        boolean activeRun = runs.existsBySessionIdAndStatusIn(sessionId, ChatRunRepository.ACTIVE_LEASE_STATUSES);
        if (outstanding.isEmpty() && !activeRun) {
            throw conflict("FOLLOW_UP_NOT_AVAILABLE", "Follow-up requires an active Run or outstanding queue");
        }
        if (outstanding.size() >= CAPACITY_LIMIT) {
            throw conflict("FOLLOW_UP_QUEUE_FULL", "Session Follow-up queue is full");
        }

        String branchId = canonicalBranchId(sessionId, request.branchId());
        List<File> attachments = validateAttachmentOwnership(
                session, request.attachments(), false);
        SessionFollowUpItem item = SessionFollowUpItem.create();
        item.setId(UUID.randomUUID());
        item.setSessionId(sessionId);
        item.setQueueSequence(items.findMaxQueueSequence(sessionId) + 1);
        item.setIdempotencyKey(idempotencyKey);
        item.setRequestHash(hash);
        item.setContent(request.content());
        item.setAttachmentRefs(attachmentRefs(attachments));
        item.setBranchId(UUID.fromString(branchId));
        item.setToolMode(request.toolMode() == null || request.toolMode().isBlank() ? "none" : request.toolMode());
        item.setToolTimeouts(mapper.valueToTree(timeouts));
        item.setProvider(unboundProvider ? request.provider() : null);
        item.setModel(unboundProvider ? request.model() : null);
        ChatRun anchor = runs.findFirstBySessionIdOrderByCreatedAtDescIdDesc(sessionId).orElse(null);
        item.setAnchorRunId(anchor == null ? null : anchor.getId());
        item.setStatus(SessionFollowUpItem.STATUS_QUEUED);
        items.saveAndFlush(item);
        publishAfterCommit(new FollowUpQueueWakeupEvent(sessionId));
        return new EnqueueResult(snapshotLocked(sessionId), false);
    }

    @Transactional(readOnly = true)
    public FollowUpQueueSnapshot snapshot(String sessionId, String userId, String workspaceId) {
        requireAuthorizedSession(sessionId, userId, workspaceId);
        return snapshotLocked(sessionId);
    }

    @Transactional
    public FollowUpQueueSnapshot withdraw(String sessionId, String userId, String workspaceId, UUID itemId) {
        lockAuthorizedSession(sessionId, userId, workspaceId);
        SessionFollowUpItem item = items.findBySessionIdAndIdForUpdate(sessionId, itemId)
                .orElseThrow(() -> notFound("FOLLOW_UP_NOT_FOUND", "Follow-up item not found"));
        if (SessionFollowUpItem.STATUS_WITHDRAWN.equals(item.getStatus())) {
            return snapshotLocked(sessionId);
        }
        if (SessionFollowUpItem.STATUS_ADMITTED.equals(item.getStatus()) || item.getChildRunId() != null) {
            throw conflict("FOLLOW_UP_ALREADY_ADMITTED", "An admitted Follow-up cannot be withdrawn");
        }
        if (!SessionFollowUpItem.STATUS_QUEUED.equals(item.getStatus())
                && !SessionFollowUpItem.STATUS_PAUSED.equals(item.getStatus())) {
            throw conflict("FOLLOW_UP_NOT_WITHDRAWABLE", "Follow-up item is no longer withdrawable");
        }
        withdrawRow(item);
        items.save(item);
        publishAfterCommit(new FollowUpQueueWakeupEvent(sessionId));
        return snapshotLocked(sessionId);
    }

    @Transactional
    public ContinueResult continueQueue(String sessionId, String userId, String workspaceId) {
        lockAuthorizedSession(sessionId, userId, workspaceId);
        List<SessionFollowUpItem> outstanding = outstanding(sessionId);
        boolean changed = false;
        for (SessionFollowUpItem item : outstanding) {
            if (!SessionFollowUpItem.STATUS_PAUSED.equals(item.getStatus())) {
                continue;
            }
            boolean childWasAdmitted = item.getChildRunId() != null
                    || SessionFollowUpItem.PAUSE_CHILD_MISSING.equals(item.getPauseReason());
            item.setPauseReason(null);
            item.setPauseRunId(null);
            if (childWasAdmitted) {
                item.setStatus(SessionFollowUpItem.STATUS_COMPLETED);
                item.setCompletedAt(Instant.now());
            } else {
                item.setStatus(SessionFollowUpItem.STATUS_QUEUED);
                item.setPauseReason("continued_after_terminal");
            }
            changed = true;
        }
        if (changed) {
            items.saveAll(outstanding);
            publishAfterCommit(new FollowUpQueueWakeupEvent(sessionId));
        }
        return new ContinueResult(snapshotLocked(sessionId), changed);
    }

    /**
     * Applies a committed ChatRun terminal outcome to the FIFO. It is safe to
     * invoke repeatedly; QueueItem status transitions are the idempotency fence.
     */
    @Transactional
    public FollowUpQueueSnapshot settleTerminal(String sessionId, String runId, String status) {
        UUID runUuid = parseUuid(runId, "runId");
        Session session = lockSession(sessionId);
        ChatRun run = runs.findByIdForUpdate(runUuid).orElse(null);
        if (run == null || !sessionId.equals(run.getSessionId()) || !TERMINAL_STATUSES.contains(status)) {
            return snapshotLocked(sessionId);
        }
        entityManager.refresh(run);
        if (!status.equals(run.getStatus())) {
            return snapshotLocked(sessionId);
        }
        List<SessionFollowUpItem> outstanding = outstanding(sessionId);
        SessionFollowUpItem consumedChild = outstanding.stream()
                .filter(item -> runUuid.equals(item.getChildRunId())
                        && SessionFollowUpItem.STATUS_ADMITTED.equals(item.getStatus()))
                .findFirst().orElse(null);
        if ("cancelled".equals(status) || "ambiguous".equals(status)) {
            String reason = consumedChild == null
                    ? ("cancelled".equals(status) ? SessionFollowUpItem.PAUSE_PARENT_CANCELLED
                            : SessionFollowUpItem.PAUSE_PARENT_AMBIGUOUS)
                    : ("cancelled".equals(status) ? SessionFollowUpItem.PAUSE_CHILD_CANCELLED
                            : SessionFollowUpItem.PAUSE_CHILD_AMBIGUOUS);
            for (SessionFollowUpItem item : outstanding) {
                if (SessionFollowUpItem.STATUS_ADMITTED.equals(item.getStatus())
                        && !item.equals(consumedChild)) {
                    continue;
                }
                item.setStatus(SessionFollowUpItem.STATUS_PAUSED);
                item.setPauseReason(reason);
                item.setPauseRunId(runUuid);
            }
            items.saveAll(outstanding);
            return snapshotLocked(sessionId);
        }

        if (consumedChild != null) {
            consumedChild.setStatus(SessionFollowUpItem.STATUS_COMPLETED);
            consumedChild.setCompletedAt(Instant.now());
        }
        SessionFollowUpItem next = outstanding.stream()
                .filter(item -> !item.equals(consumedChild)
                        && (SessionFollowUpItem.STATUS_QUEUED.equals(item.getStatus())
                            || SessionFollowUpItem.STATUS_PAUSED.equals(item.getStatus())))
                .findFirst().orElse(null);
        if (next != null && SUCCESS_TRIGGER_STATUSES.contains(status)) {
            next.setAnchorRunId(runUuid);
            next.setPauseReason(null);
            next.setPauseRunId(null);
        }
        items.saveAll(outstanding);
        return snapshotLocked(sessionId);
    }

    /**
     * Calls the supplied existing CP admission path while the Session and queue
     * head are locked. The callback must create Message + ChatRun + Operation in
     * this transaction and return their durable identifiers.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public AdmissionResult admitHead(String sessionId, Function<AdmissionContext, ChildAdmission> admission) {
        Session session = lockSession(sessionId);
        List<SessionFollowUpItem> outstanding = outstanding(sessionId);
        SessionFollowUpItem head = outstanding.isEmpty() ? null : outstanding.getFirst();
        if (head == null || !SessionFollowUpItem.STATUS_QUEUED.equals(head.getStatus())) {
            return new AdmissionResult(false, null, null, snapshotLocked(sessionId));
        }
        if (outstanding.size() > 1 && outstanding.get(1).getQueueSequence() < head.getQueueSequence()) {
            throw new IllegalStateException("Follow-up FIFO ordering invariant was violated");
        }
        String blocked = headIneligibility(head);
        if (blocked != null) {
            if ("anchor_not_terminal".equals(blocked)) {
                return new AdmissionResult(false, null, blocked, snapshotLocked(sessionId));
            }
            pauseQueue(outstanding, head.getAnchorRunId(), blocked);
            return new AdmissionResult(false, null, blocked, snapshotLocked(sessionId));
        }
        AdmissionAttachments attachments;
        try {
            attachments = revalidateAttachmentsForAdmission(session, head);
            branches.resolveVisibility(sessionId, head.getBranchId().toString());
        } catch (CpApiException staleReference) {
            String reason = staleReference.getCode() != null && staleReference.getCode().startsWith("BRANCH_")
                    ? SessionFollowUpItem.PAUSE_BRANCH_UNAVAILABLE
                    : SessionFollowUpItem.PAUSE_ATTACHMENT_UNAVAILABLE;
            pauseQueue(outstanding, head.getAnchorRunId(), reason);
            return new AdmissionResult(false, null, reason, snapshotLocked(sessionId));
        }

        ChildAdmission created = admission.apply(new AdmissionContext(session, head, attachments));
        if (created == null || created.runId() == null || created.messageId() == null) {
            throw new IllegalStateException("Chat admission callback returned incomplete durable identifiers");
        }
        Map<String, Integer> timeouts = mapper.convertValue(
                head.getToolTimeouts(), new TypeReference<Map<String, Integer>>() {});
        head.setStatus(SessionFollowUpItem.STATUS_ADMITTED);
        head.setChildRunId(created.runId());
        head.setChildMessageId(created.messageId());
        head.setAdmittedAt(Instant.now());
        head.setPauseReason(null);
        head.setPauseRunId(null);
        head.setContent(null);
        head.setAttachmentRefs(mapper.createArrayNode());
        head.setToolTimeouts(mapper.createObjectNode());
        items.saveAndFlush(head);
        publishAfterCommit(new FollowUpChildAdmittedEvent(
                sessionId, head.getId(), created.runId().toString(), timeouts));
        return new AdmissionResult(true, created.runId(), null, snapshotLocked(sessionId));
    }

    /** Rechecks logical File refs immediately before normal Chat admission. */
    @Transactional(readOnly = true)
    public AdmissionAttachments revalidateAttachmentsForAdmission(String sessionId, String userId,
                                                                  String workspaceId, UUID itemId) {
        Session session = requireAuthorizedSession(sessionId, userId, workspaceId);
        SessionFollowUpItem item = items.findBySessionIdAndIdForUpdate(sessionId, itemId)
                .orElseThrow(() -> notFound("FOLLOW_UP_NOT_FOUND", "Follow-up item not found"));
        return revalidateAttachmentsForAdmission(session, item);
    }

    private AdmissionAttachments revalidateAttachmentsForAdmission(Session session, SessionFollowUpItem item) {
        List<String> ids = attachmentIds(item.getAttachmentRefs());
        List<File> attached = validateAttachmentOwnership(session, ids, true);
        return new AdmissionAttachments(List.copyOf(ids), List.copyOf(attached), attachmentInfos(item.getAttachmentRefs()));
    }

    private String headIneligibility(SessionFollowUpItem head) {
        if (head.getAnchorRunId() == null) {
            return PAUSE_STALE_ANCHOR;
        }
        ChatRun anchor = runs.findById(head.getAnchorRunId()).orElse(null);
        if (anchor == null || !head.getSessionId().equals(anchor.getSessionId())) {
            return PAUSE_STALE_ANCHOR;
        }
        boolean explicitlyContinued = "continued_after_terminal".equals(head.getPauseReason());
        if ("cancelled".equals(anchor.getStatus())) {
            return explicitlyContinued ? null : SessionFollowUpItem.PAUSE_PARENT_CANCELLED;
        }
        if ("ambiguous".equals(anchor.getStatus())) {
            return explicitlyContinued ? null : SessionFollowUpItem.PAUSE_PARENT_AMBIGUOUS;
        }
        if (!SUCCESS_TRIGGER_STATUSES.contains(anchor.getStatus())) {
            return "anchor_not_terminal";
        }
        return null;
    }

    private void pauseQueue(List<SessionFollowUpItem> queue, UUID pauseRunId, String reason) {
        for (SessionFollowUpItem item : queue) {
            if (SessionFollowUpItem.STATUS_ADMITTED.equals(item.getStatus()) && item.getChildRunId() != null) {
                continue;
            }
            item.setStatus(SessionFollowUpItem.STATUS_PAUSED);
            item.setPauseRunId(pauseRunId);
            item.setPauseReason(reason);
        }
        items.saveAll(queue);
    }

    private Session lockAuthorizedSession(String sessionId, String userId, String workspaceId) {
        requireTenant(userId, workspaceId);
        Session session = lockSession(sessionId);
        if (!userId.equals(session.getUserId()) || !workspaceId.equals(session.getWorkspaceId())
                || session.isArchived()) {
            throw notFound("SESSION_NOT_FOUND", "Session not found");
        }
        if (session.getDeleteRequestedAt() != null) {
            throw conflict("SESSION_DELETING", "Session is being deleted");
        }
        return session;
    }

    private Session requireAuthorizedSession(String sessionId, String userId, String workspaceId) {
        requireTenant(userId, workspaceId);
        UUID sessionUuid = parseUuid(sessionId, "sessionId");
        Session session = sessions.findById(sessionUuid)
                .filter(row -> userId.equals(row.getUserId()) && workspaceId.equals(row.getWorkspaceId())
                        && !row.isArchived() && row.getDeleteRequestedAt() == null)
                .orElseThrow(() -> notFound("SESSION_NOT_FOUND", "Session not found"));
        return session;
    }

    private Session lockSession(String sessionId) {
        lockTimeout.apply();
        Session session = sessions.findByIdForUpdate(parseUuid(sessionId, "sessionId"))
                .orElseThrow(() -> notFound("SESSION_NOT_FOUND", "Session not found"));
        entityManager.refresh(session);
        if (session.isArchived()) {
            throw notFound("SESSION_NOT_FOUND", "Session not found");
        }
        if (session.getDeleteRequestedAt() != null) {
            throw conflict("SESSION_DELETING", "Session is being deleted");
        }
        return session;
    }

    private static void requireTenant(String userId, String workspaceId) {
        if (userId == null || workspaceId == null
                || !userId.equals(TenantContext.getUserId())
                || !workspaceId.equals(TenantContext.getWorkspaceId())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
    }

    private List<SessionFollowUpItem> outstanding(String sessionId) {
        return items.findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                sessionId, SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
    }

    private FollowUpQueueSnapshot snapshotLocked(String sessionId) {
        List<SessionFollowUpItem> rows = items.findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                sessionId, List.of(SessionFollowUpItem.STATUS_QUEUED, SessionFollowUpItem.STATUS_PAUSED,
                        SessionFollowUpItem.STATUS_ADMITTED, SessionFollowUpItem.STATUS_COMPLETED,
                        SessionFollowUpItem.STATUS_WITHDRAWN));
        List<FollowUpItemView> views = new ArrayList<>(rows.size());
        long count = 0;
        boolean paused = false;
        String pauseReason = null;
        for (SessionFollowUpItem row : rows) {
            boolean outstanding = SessionFollowUpItemRepository.OUTSTANDING_STATUSES.contains(row.getStatus());
            if (outstanding) {
                count++;
            }
            if (SessionFollowUpItem.STATUS_PAUSED.equals(row.getStatus())) {
                paused = true;
                if (pauseReason == null) {
                    pauseReason = row.getPauseReason();
                }
            }
            views.add(new FollowUpItemView(row.getId(), row.getQueueSequence(), row.getStatus(), row.getContent(),
                    attachmentInfos(row.getAttachmentRefs()), row.getBranchId(), row.getAnchorRunId(),
                    row.getPauseReason(), row.getChildRunId(), row.getChildMessageId(),
                    row.getCreatedAt(), row.getUpdatedAt()));
        }
        String state = paused ? "paused" : count == 0 ? "empty" : "queued";
        return new FollowUpQueueSnapshot(sessionId, state, count, CAPACITY_LIMIT, pauseReason, List.copyOf(views));
    }

    private List<File> validateAttachmentOwnership(Session session, List<String> ids, boolean admission) {
        List<File> result = new ArrayList<>();
        Set<UUID> seen = new java.util.HashSet<>();
        for (String id : ids == null ? List.<String>of() : ids) {
            UUID uuid = parseUuid(id, "attachmentId");
            if (!seen.add(uuid)) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Duplicate attachment id");
            }
            File file = files.findById(uuid)
                    .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT, "ATTACHMENT_NOT_FOUND",
                            "Follow-up attachment is no longer available"));
            if (!session.getId().toString().equals(file.getSessionId())
                    || !session.getWorkspaceId().equals(file.getWorkspaceId())
                    || !session.getUserId().equals(file.getUserId())
                    || (admission && file.getMessageId() != null)) {
                throw new CpApiException(HttpStatus.CONFLICT, "ATTACHMENT_NOT_AVAILABLE",
                        "Follow-up attachment is no longer available to this Session");
            }
            result.add(file);
        }
        return result;
    }

    private ArrayNode attachmentRefs(List<File> attachments) {
        ArrayNode refs = mapper.createArrayNode();
        for (File file : attachments) {
            refs.add(file.getId().toString());
        }
        return refs;
    }

    private List<AttachmentInfo> attachmentInfos(JsonNode refs) {
        List<String> ids = attachmentIds(refs);
        if (ids.isEmpty()) {
            return List.of();
        }
        Map<UUID, File> filesById = new LinkedHashMap<>();
        files.findAllById(ids.stream().map(id -> UUID.fromString(id)).toList())
                .forEach(file -> filesById.put(file.getId(), file));
        List<AttachmentInfo> result = new ArrayList<>(ids.size());
        for (String id : ids) {
            File file = filesById.get(UUID.fromString(id));
            if (file != null) {
                result.add(new AttachmentInfo(file.getId().toString(), file.getFilename(),
                        file.getMimeType(), file.getSizeBytes(), "/api/v1/files/" + file.getId()));
            }
        }
        return List.copyOf(result);
    }

    private static List<String> attachmentIds(JsonNode refs) {
        List<String> result = new ArrayList<>();
        if (refs != null && refs.isArray()) {
            refs.forEach(ref -> result.add(canonicalUuid(ref.asText(), "attachmentId")));
        }
        return List.copyOf(result);
    }

    private String canonicalBranchId(String sessionId, String requestedBranchId) {
        String value;
        try {
            value = UUID.fromString(requestedBranchId).toString();
        } catch (IllegalArgumentException invalid) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "branchId must be a UUID");
        }
        branches.resolveVisibility(sessionId, value);
        return value;
    }

    private String requestHash(String sessionId, FollowUpCreateRequest request,
                               Map<String, Integer> timeouts, boolean unboundSession) {
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("sessionId", sessionId);
        canonical.put("content", request.content());
        canonical.put("attachments", canonicalAttachmentIds(request.attachments()));
        canonical.put("branchId", canonicalUuid(request.branchId(), "branchId"));
        canonical.put("toolMode", request.toolMode() == null || request.toolMode().isBlank()
                ? "none" : request.toolMode());
        if (!timeouts.isEmpty()) {
            canonical.put("toolTimeouts", new TreeMap<>(timeouts));
        }
        if (unboundSession) {
            canonical.put("provider", request.provider() == null ? "" : request.provider());
            canonical.put("model", request.model() == null ? "" : request.model());
        }
        try {
            byte[] bytes = mapper.writeValueAsBytes(canonical);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (JsonProcessingException | NoSuchAlgorithmException e) {
            throw new IllegalStateException("Unable to hash Follow-up request", e);
        }
    }

    private static List<String> canonicalAttachmentIds(List<String> ids) {
        if (ids == null) {
            return List.of();
        }
        return ids.stream().map(id -> canonicalUuid(id, "attachmentId")).toList();
    }

    private static String canonicalUuid(String value, String field) {
        try {
            return UUID.fromString(value).toString();
        } catch (RuntimeException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", field + " must be a UUID");
        }
    }

    private static Map<String, Integer> validateRequest(FollowUpCreateRequest request, boolean unboundProvider) {
        if (request == null || request.content() == null || request.content().isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "content is required");
        }
        if (unboundProvider && (request.provider() == null) != (request.model() == null)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "provider and model must be provided together");
        }
        if (request.branchId() == null || request.branchId().isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "branchId is required");
        }
        if (request.attachments() != null && request.attachments().size() > 20) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Too many attachments");
        }
        Map<String, Integer> timeouts = new LinkedHashMap<>();
        if (request.toolTimeouts() != null) {
            for (Map.Entry<String, Integer> entry : request.toolTimeouts().entrySet()) {
                String tool = entry.getKey() == null ? "" : entry.getKey().trim();
                Integer seconds = entry.getValue();
                if (tool.isEmpty() || seconds == null || seconds < 1
                        || seconds > ToolTimeoutPolicy.MAX_BUDGET_SECONDS) {
                    throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                            "toolTimeouts values require a nonblank tool name and integer seconds from 1 to "
                                    + ToolTimeoutPolicy.MAX_BUDGET_SECONDS);
                }
                if (timeouts.putIfAbsent(tool, seconds) != null) {
                    throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                            "toolTimeouts contains duplicate tool names after trimming");
                }
            }
        }
        return Map.copyOf(timeouts);
    }

    private static void validateIdempotencyKey(String key) {
        if (key == null || key.isBlank() || key.length() > 128) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Idempotency-Key must contain 1 to 128 characters");
        }
    }

    private static void withdrawRow(SessionFollowUpItem item) {
        item.setStatus(SessionFollowUpItem.STATUS_WITHDRAWN);
        item.setWithdrawnAt(Instant.now());
        item.setContent(null);
        item.setAttachmentRefs(null);
    }

    private static UUID parseUuid(String value, String field) {
        try {
            return UUID.fromString(value);
        } catch (RuntimeException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", field + " must be a UUID");
        }
    }

    private static CpApiException conflict(String code, String detail) {
        return new CpApiException(HttpStatus.CONFLICT, code, detail);
    }

    private static CpApiException notFound(String code, String detail) {
        return new CpApiException(HttpStatus.NOT_FOUND, code, detail);
    }

    void publishAfterCommit(Object event) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            publishEventOrDeferWake(event);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                publishEventOrDeferWake(event);
            }
        });
    }

    private void publishEventOrDeferWake(Object event) {
        if (!(event instanceof FollowUpQueueWakeupEvent wake)) {
            events.publishEvent(event);
            return;
        }
        Instant now = Instant.now();
        Instant leaseExpiry = runs.findLatestLeaseExpiryAfter(wake.sessionId(), now);
        if (leaseExpiry == null) {
            events.publishEvent(event);
            return;
        }
        Instant retryAt = leaseExpiry.plusMillis(LEASE_RECHECK_MARGIN_MILLIS);
        try {
            var scheduled = taskScheduler.schedule(() -> publishEventOrDeferWake(wake), retryAt);
            if (scheduled == null) {
                throw new IllegalStateException("Task scheduler rejected Follow-up lease retry");
            }
            logger.info("[LIFECYCLE] service=cp event=follow_up_wakeup_deferred sessionId={} retryAt={}",
                    wake.sessionId(), retryAt);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_wakeup_schedule_failed sessionId={} retryAt={}",
                    wake.sessionId(), retryAt, e);
            throw e;
        }
    }

    void scheduleAdmissionRetry(FollowUpQueueWakeupEvent failedEvent) {
        if (failedEvent.retryAttempt() >= MAX_ADMISSION_RETRIES) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_admission_retry_exhausted "
                            + "sessionId={} retryAttempt={}",
                    failedEvent.sessionId(), failedEvent.retryAttempt());
            return;
        }

        FollowUpQueueWakeupEvent retry = new FollowUpQueueWakeupEvent(
                failedEvent.sessionId(), failedEvent.retryAttempt() + 1);
        Instant retryAt = Instant.now().plusMillis(LEASE_RECHECK_MARGIN_MILLIS);
        try {
            var scheduled = taskScheduler.schedule(() -> events.publishEvent(retry), retryAt);
            if (scheduled == null) {
                throw new IllegalStateException("Task scheduler rejected Follow-up admission retry");
            }
            logger.warn("[LIFECYCLE] service=cp event=follow_up_admission_retry_scheduled "
                            + "sessionId={} retryAttempt={} retryAt={}",
                    failedEvent.sessionId(), retry.retryAttempt(), retryAt);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_admission_retry_schedule_failed "
                            + "sessionId={} retryAttempt={} retryAt={}",
                    failedEvent.sessionId(), retry.retryAttempt(), retryAt, e);
            try {
                events.publishEvent(retry);
            } catch (RuntimeException fallbackFailure) {
                logger.error("[LIFECYCLE] service=cp event=follow_up_admission_retry_fallback_failed "
                                + "sessionId={} retryAttempt={}",
                        failedEvent.sessionId(), retry.retryAttempt(), fallbackFailure);
            }
        }
    }

    public record AdmissionAttachments(List<String> fileIds, List<File> files, List<AttachmentInfo> references) {}
    public record AdmissionContext(Session session, SessionFollowUpItem item, AdmissionAttachments attachments) {}
    public record ChildAdmission(UUID runId, UUID messageId) {}
    public record AdmissionResult(boolean admitted, UUID childRunId, String blockedReason,
                                  FollowUpQueueSnapshot snapshot) {}
    public record EnqueueResult(FollowUpQueueSnapshot snapshot, boolean replayed) {}
    public record ContinueResult(FollowUpQueueSnapshot snapshot, boolean changed) {}
}
