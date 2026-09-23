package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Atomic Chat submission boundary for ChatRun, user Message and Ledger root.
 * Agent dispatch starts only after this transaction has committed.
 */
@Service
public class ChatSubmissionService {
    public static final String SPAWN_TOOL_NAME = "spawn_agent";


    private static final java.time.Duration LEASE_TTL = java.time.Duration.ofMinutes(10);

    private final ChatRunRepository chatRunRepository;
    private final MessageRepository messageRepository;
    private final FileRepository fileRepository;
    private final OperationService operationService;
    private final OperationItemRepository operationItemRepository;
    private final SessionRepository sessionRepository;
    private final DbLockTimeout dbLockTimeout;
    private final ObjectMapper objectMapper;

    public ChatSubmissionService(ChatRunRepository chatRunRepository,
                                 MessageRepository messageRepository,
                                 FileRepository fileRepository,
                                 OperationService operationService,
                                 OperationItemRepository operationItemRepository,
                                 SessionRepository sessionRepository,
                                 DbLockTimeout dbLockTimeout,
                                 ObjectMapper objectMapper) {
        this.chatRunRepository = chatRunRepository;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.operationService = operationService;
        this.operationItemRepository = operationItemRepository;
        this.sessionRepository = sessionRepository;
        this.dbLockTimeout = dbLockTimeout;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public Submission create(String runId, String sessionId, String userId, String workspaceId,
                             String idempotencyKey, String requestHash, String provider,
                             String model, String toolMode, String providerConnectionId,
                             Long connectionRevision, String leaseOwner, String requestId,
                             String content, String attachmentsJson, List<String> attachmentIds) {
        return persist(ChatRun.ORIGIN_USER_SUBMISSION, runId, sessionId, userId, workspaceId,
                idempotencyKey, requestHash, provider, model, toolMode, providerConnectionId,
                connectionRevision, leaseOwner, requestId, content, attachmentsJson, attachmentIds);
    }

    /**
     * Creates a derived child run directly inside CP. This deliberately does not
     * pass through ChatController's browser SSE subscription gate.
     */
    @Transactional
    public Submission createSpawn(SpawnSubmission spawn) {
        if (spawn.spawnEventId() == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "spawnEventId is required");
        }
        requireUuid(spawn.runId(), "runId");
        requireUuid(spawn.childSessionId(), "childSessionId");
        requireUuid(spawn.parentSessionId(), "parentSessionId");
        requireUuid(spawn.parentRunId(), "parentRunId");
        if (isBlank(spawn.userId()) || isBlank(spawn.workspaceId()) || isBlank(spawn.requestId())) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "spawn user, workspace and request id are required");
        }

        dbLockTimeout.apply();
        OperationItem event = operationItemRepository.findByIdForUpdate(spawn.spawnEventId())
                .orElseThrow(() -> spawnProvenanceConflict("Spawn event not found"));
        ChatRun parentRun = chatRunRepository.findById(UUID.fromString(spawn.parentRunId()))
                .orElseThrow(() -> spawnProvenanceConflict("Parent run not found"));
        UUID parentOperationId = operationService.findOperationIdByRunId(spawn.parentRunId());
        if (parentOperationId == null
                || !parentOperationId.toString().equals(event.getOperationId())
                || !"agent".equals(event.getSource())
                || !"tool_call".equals(event.getKind())
                || !SPAWN_TOOL_NAME.equals(event.getToolName())
                || !spawn.parentSessionId().equals(parentRun.getSessionId())
                || !spawn.userId().equals(parentRun.getUserId())
                || !spawn.workspaceId().equals(parentRun.getWorkspaceId())) {
            throw spawnProvenanceConflict("Spawn event does not belong to the supplied parent run");
        }

        Session childSession = sessionRepository.findById(UUID.fromString(spawn.childSessionId()))
                .orElseThrow(() -> spawnProvenanceConflict("Child session not found"));
        if (!spawn.userId().equals(childSession.getUserId())
                || !spawn.workspaceId().equals(childSession.getWorkspaceId())
                || !UUID.fromString(spawn.parentSessionId()).equals(childSession.getSpawnedFromSessionId())
                || !UUID.fromString(spawn.parentRunId()).equals(childSession.getSpawnedFromRunId())
                || childSession.getSpawnedAt() == null
                || !Session.KIND_SPAWN.equals(childSession.getKind())) {
            throw spawnProvenanceConflict("Child session provenance does not match the parent run");
        }

        SpawnAttachments attachments = normalizeSpawnAttachments(spawn);
        String requestHash = ChatRequestHash.calculate(objectMapper, spawn.content(), spawn.provider(),
                spawn.model(), spawn.toolMode(), attachments.fileIds(), Map.of());

        String idempotencyKey = spawn.spawnEventId().toString();
        ChatRun existingSpawn = chatRunRepository.findByUserIdAndIdempotencyKeyAndOrigin(
                spawn.userId(), idempotencyKey, ChatRun.ORIGIN_SPAWN).orElse(null);
        if (existingSpawn != null) {
            if (!requestHash.equals(existingSpawn.getRequestHash())) {
                throw idempotencyConflict();
            }
            return replay(existingSpawn);
        }

        ChatRun sameSessionRun = chatRunRepository.findByUserIdAndSessionIdAndIdempotencyKey(
                spawn.userId(), spawn.childSessionId(), idempotencyKey).orElse(null);
        if (sameSessionRun != null) {
            throw idempotencyConflict();
        }

        return persist(ChatRun.ORIGIN_SPAWN, spawn.runId(), spawn.childSessionId(), spawn.userId(),
                spawn.workspaceId(), idempotencyKey, requestHash, spawn.provider(), spawn.model(),
                spawn.toolMode(), spawn.providerConnectionId(), spawn.connectionRevision(), spawn.leaseOwner(),
                spawn.requestId(), spawn.content(), attachments.json(), attachments.fileIds());
    }

    private SpawnAttachments normalizeSpawnAttachments(SpawnSubmission spawn) {
        Set<String> seen = new HashSet<>();
        List<String> fileIds = new ArrayList<>();
        List<Map<String, Object>> attachmentRefs = new ArrayList<>();
        for (String fileId : spawn.attachmentIds()) {
            UUID attachmentId;
            try {
                attachmentId = UUID.fromString(fileId);
            } catch (RuntimeException e) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Attachment id must be a UUID");
            }
            String canonicalId = attachmentId.toString();
            if (!seen.add(canonicalId)) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Duplicate spawn attachment id");
            }
            File file = fileRepository.findById(attachmentId)
                    .orElseThrow(() -> new CpApiException(
                            HttpStatus.BAD_REQUEST, "ATTACHMENT_NOT_FOUND", "Attachment not found"));
            if (!spawn.childSessionId().equals(file.getSessionId())
                    || !spawn.workspaceId().equals(file.getWorkspaceId())
                    || !spawn.userId().equals(file.getUserId())) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "Spawn attachments must belong to the child session");
            }
            fileIds.add(canonicalId);
            Map<String, Object> reference = new LinkedHashMap<>();
            reference.put("fileId", canonicalId);
            reference.put("name", file.getFilename());
            reference.put("type", file.getMimeType());
            reference.put("size", file.getSizeBytes());
            attachmentRefs.add(reference);
        }
        if (attachmentRefs.isEmpty()) {
            return new SpawnAttachments(null, List.of());
        }
        try {
            return new SpawnAttachments(objectMapper.writeValueAsString(attachmentRefs), List.copyOf(fileIds));
        } catch (Exception e) {
            throw new IllegalStateException("Unable to serialize normalized spawn attachments", e);
        }
    }

    private Submission persist(String origin, String runId, String sessionId, String userId, String workspaceId,
                              String idempotencyKey, String requestHash, String provider, String model,
                              String toolMode, String providerConnectionId, Long connectionRevision,
                              String leaseOwner, String requestId, String content, String attachmentsJson,
                              List<String> attachmentIds) {
        ChatRun chatRun = new ChatRun(
                runId, sessionId, userId, workspaceId, idempotencyKey, requestHash,
                provider, model, toolMode, "accepted");
        chatRun.setOrigin(origin);
        chatRun.setLeaseOwner(leaseOwner);
        chatRun.setLeaseExpiresAt(Instant.now().plus(LEASE_TTL));
        chatRun.setProviderConnectionId(providerConnectionId);
        chatRun.setConnectionRevision(connectionRevision);
        chatRunRepository.save(chatRun);

        Message userMessage = new Message(sessionId, MessageRole.USER, content);
        userMessage.setRunId(runId);
        userMessage.setAttachments(attachmentsJson);
        messageRepository.save(userMessage);
        chatRun.setUserMessageId(userMessage.getId().toString());
        chatRunRepository.save(chatRun);

        for (String fileId : attachmentIds) {
            File file = fileRepository.findById(java.util.UUID.fromString(fileId))
                    .orElseThrow(() -> new IllegalStateException("Attachment disappeared during Chat submission"));
            file.setMessageId(userMessage.getId().toString());
            fileRepository.save(file);
        }

        OperationService.OperationStartResult operation = operationService.startOperation(
                userId, sessionId, workspaceId, runId, requestId,
                "chat", "ui", "user", userId, idempotencyKey, "Chat operation");
        return new Submission(chatRun, userMessage, operation);
    }

    private Submission replay(ChatRun run) {
        Message message = messageRepository.findById(UUID.fromString(run.getUserMessageId()))
                .orElseThrow(() -> new IllegalStateException("ChatRun user message is missing"));
        UUID operationId = operationService.findOperationIdByRunId(run.getId().toString());
        if (operationId == null) {
            throw new IllegalStateException("ChatRun operation root is missing");
        }
        return new Submission(run, message, new OperationService.OperationStartResult(operationId, true));
    }

    private static void requireUuid(String value, String field) {
        try {
            UUID.fromString(value);
        } catch (RuntimeException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", field + " must be a UUID");
        }
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static CpApiException spawnProvenanceConflict(String detail) {
        return new CpApiException(HttpStatus.CONFLICT, "SPAWN_PROVENANCE_CONFLICT", detail);
    }

    private static CpApiException idempotencyConflict() {
        return new CpApiException(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_CONFLICT",
                "Spawn event id was already used for a different request");
    }

    public record Submission(ChatRun run, Message userMessage,
                             OperationService.OperationStartResult operation) {}

    public record SpawnSubmission(String runId, String childSessionId, String userId, String workspaceId,
                                  String parentSessionId, String parentRunId, UUID spawnEventId,
                                  String provider, String model, String toolMode,
                                  String providerConnectionId, Long connectionRevision, String leaseOwner,
                                  String requestId, String content, List<String> attachmentIds) {
        public SpawnSubmission {
            attachmentIds = attachmentIds == null ? List.of() : List.copyOf(attachmentIds);
        }
    }

    private record SpawnAttachments(String json, List<String> fileIds) {}
}
