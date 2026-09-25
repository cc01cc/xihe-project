package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
    private static final Logger logger = LoggerFactory.getLogger(ChatSubmissionService.class);

    private final ChatRunRepository chatRunRepository;
    private final MessageRepository messageRepository;
    private final FileRepository fileRepository;
    private final OperationService operationService;
    private final OperationItemRepository operationItemRepository;
    private final SessionRepository sessionRepository;
    private final AgentPrincipalRepository agentPrincipalRepository;
    private final WorkspaceAgentRepository workspaceAgentRepository;
    private final GrantPrincipalPathResolver principalPathResolver;
    private final DbLockTimeout dbLockTimeout;
    private final ObjectMapper objectMapper;
    private final LedgerOperationRepository ledgerOperationRepository;
    private final EventStoreRepository eventStoreRepository;
    private final AgentPrincipalService agentPrincipalService;
    private final com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService;

    public ChatSubmissionService(ChatRunRepository chatRunRepository,
                                 MessageRepository messageRepository,
                                 FileRepository fileRepository,
                                 OperationService operationService,
                                 OperationItemRepository operationItemRepository,
                                 SessionRepository sessionRepository,
                                 AgentPrincipalRepository agentPrincipalRepository,
                                 WorkspaceAgentRepository workspaceAgentRepository,
                                 GrantPrincipalPathResolver principalPathResolver,
                                 DbLockTimeout dbLockTimeout,
                                 ObjectMapper objectMapper,
                                 LedgerOperationRepository ledgerOperationRepository,
                                 EventStoreRepository eventStoreRepository,
                                 AgentPrincipalService agentPrincipalService,
                                 com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService) {
        this.chatRunRepository = chatRunRepository;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.operationService = operationService;
        this.operationItemRepository = operationItemRepository;
        this.sessionRepository = sessionRepository;
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.workspaceAgentRepository = workspaceAgentRepository;
        this.principalPathResolver = principalPathResolver;
        this.dbLockTimeout = dbLockTimeout;
        this.objectMapper = objectMapper;
        this.ledgerOperationRepository = ledgerOperationRepository;
        this.eventStoreRepository = eventStoreRepository;
        this.agentPrincipalService = agentPrincipalService;
        this.branchPathService = branchPathService;
    }

    @Transactional
    public Submission create(String runId, String sessionId, String userId, String workspaceId,
                             String idempotencyKey, String requestHash, String provider,
                             String model, String toolMode, String providerConnectionId,
                             Long connectionRevision, String leaseOwner, String requestId,
                             String content, String attachmentsJson, List<String> attachmentIds) {
        return create(runId, sessionId, userId, workspaceId, null, idempotencyKey, requestHash,
                provider, model, toolMode, providerConnectionId, connectionRevision,
                leaseOwner, requestId, content, attachmentsJson, attachmentIds);
    }

    @Transactional
    public Submission create(String runId, String sessionId, String userId, String workspaceId,
                             String agentPrincipalId, String idempotencyKey, String requestHash,
                             String provider, String model, String toolMode, String providerConnectionId,
                             Long connectionRevision, String leaseOwner, String requestId,
                             String content, String attachmentsJson, List<String> attachmentIds) {
        return persist(ChatRun.ORIGIN_USER_SUBMISSION, runId, sessionId, userId, workspaceId,
                idempotencyKey, requestHash, provider, model, toolMode, providerConnectionId,
                connectionRevision, leaseOwner, requestId, content, attachmentsJson, attachmentIds,
                agentPrincipalId);
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
        // PLAN-0407 T2.5：先锁 parent Run（与 cancel 认领的条件更新争用同一行锁），
        // 锁序固定为 parent Run → spawn item → child Session，避免与取消路径交叉死锁。
        ChatRun parentRun = chatRunRepository.findByIdForUpdate(UUID.fromString(spawn.parentRunId()))
                .orElseThrow(() -> spawnProvenanceConflict("Parent run not found"));
        OperationItem event = operationItemRepository.findByIdForUpdate(spawn.spawnEventId())
                .orElseThrow(() -> spawnProvenanceConflict("Spawn event not found"));
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

        // PLAN-0407 T2.5：cancel 认领获胜（cancelling）或已终态的 parent run 不接受新 spawn；
        // 幂等 replay 已在上方返回，spawn 获胜后的重试仍拿回同一 child。
        requireActiveParentRunForSpawn(parentRun);

        return persist(ChatRun.ORIGIN_SPAWN, spawn.runId(), spawn.childSessionId(), spawn.userId(),
                spawn.workspaceId(), idempotencyKey, requestHash, spawn.provider(), spawn.model(),
                spawn.toolMode(), spawn.providerConnectionId(), spawn.connectionRevision(), spawn.leaseOwner(),
                spawn.requestId(), spawn.content(), attachments.json(), attachments.fileIds(), null);
    }

    @Transactional
    public SpawnResult createSpawnFromParent(String parentRunId, String toolCallId) {
        requireUuid(parentRunId, "parentRunId");
        requireUuid(toolCallId, "toolCallId");

        dbLockTimeout.apply();
        // PLAN-0407 T2.5：spawn 与 cancel 在 parent Run 上的共同序列化点（spawn 侧）。
        ChatRun parentRun = chatRunRepository.findByIdForUpdate(UUID.fromString(parentRunId))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_PARENT_RUN_NOT_FOUND",
                        "Parent run not found"));
        UUID parentOperationId = operationService.findOperationIdByRunId(parentRunId);
        if (parentOperationId == null) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_EVENT_NOT_FOUND",
                    "Parent run has no durable operation");
        }
        String operationId = parentOperationId.toString();
        OperationItem item = operationItemRepository
                .findByOperationIdAndSourceAndToolCallId(operationId, "agent", toolCallId)
                .orElseGet(() -> rejectUnmatchedSpawnItem(operationId, toolCallId));
        if (!"tool_call".equals(item.getKind())
                || !"agent".equals(item.getSource())
                || !SPAWN_TOOL_NAME.equals(item.getToolName())) {
            throw agentSpawnForbidden("Durable item is not an agent spawn_agent tool call");
        }

        dbLockTimeout.apply();
        item = operationItemRepository.findByIdForUpdate(item.getId())
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_EVENT_NOT_FOUND",
                        "Spawn item not found"));

        Session parentSession = sessionRepository.findById(UUID.fromString(parentRun.getSessionId()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_PARENT_RUN_NOT_FOUND",
                        "Parent run session not found"));

        String content = deriveSpawnContent(item.getArgumentsPreview());
        String requestHash = ChatRequestHash.calculate(objectMapper, content, parentRun.getProvider(),
                parentRun.getModel(), parentRun.getToolMode(), List.of(), Map.of());

        ChatRun existingSpawn = chatRunRepository
                .findByUserIdAndIdempotencyKeyAndOrigin(parentRun.getUserId(), item.getId().toString(),
                        ChatRun.ORIGIN_SPAWN)
                .orElse(null);
        if (existingSpawn != null) {
            if (!requestHash.equals(existingSpawn.getRequestHash())) {
                throw idempotencyConflict();
            }
            Session existingSession = sessionRepository
                    .findById(UUID.fromString(existingSpawn.getSessionId()))
                    .orElseThrow(() -> new IllegalStateException("Spawn session is missing"));
            return new SpawnResult(existingSession.getId().toString(), existingSpawn.getId().toString(),
                    existingSession.getAgentPrincipalId(), parentRun.getWorkspaceId());
        }

        // PLAN-0407 T2.5：cancel 获胜拒绝新 spawn——门在 child Session 创建之前，
        // 拒绝路径零写入（行锁内状态不可能并发变化）。
        requireActiveParentRunForSpawn(parentRun);

        if (parentSession.getAgentPrincipalId() == null || parentSession.getAgentPermissionsSnapshot() == null) {
            throw agentSessionForbidden();
        }

        Session childSession = new Session(parentRun.getWorkspaceId(), parentRun.getUserId(),
                parentSession.getTitle());
        childSession.setId(UUID.randomUUID());
        childSession.setKind(Session.KIND_SPAWN);
        childSession.setSpawnedFromSessionId(parentSession.getId());
        childSession.setSpawnedFromRunId(parentRun.getId());
        childSession.setSpawnedAt(Instant.now());
        childSession.setAgentPrincipalId(parentSession.getAgentPrincipalId());
        childSession.setAgentPermissionsSnapshot(parentSession.getAgentPermissionsSnapshot().deepCopy());
        childSession.setModelProvider(parentSession.getModelProvider());
        childSession.setModelName(parentSession.getModelName());
        childSession.setProviderConnectionId(parentSession.getProviderConnectionId());
        childSession.setConnectionRevision(parentSession.getConnectionRevision());
        childSession.setApprovalMode(parentSession.getApprovalMode());
        sessionRepository.save(childSession);

        SpawnSubmission submission = new SpawnSubmission(
                UUID.randomUUID().toString(), childSession.getId().toString(), parentRun.getUserId(),
                parentRun.getWorkspaceId(), parentSession.getId().toString(), parentRunId, item.getId(),
                parentRun.getProvider(), parentRun.getModel(), parentRun.getToolMode(),
                parentRun.getProviderConnectionId(), parentRun.getConnectionRevision(), null,
                UUID.randomUUID().toString(), content, List.of());
        Submission created = createSpawn(submission);
        return new SpawnResult(childSession.getId().toString(), created.run().getId().toString(),
                childSession.getAgentPrincipalId(), parentRun.getWorkspaceId());
    }

    private OperationItem rejectUnmatchedSpawnItem(String operationId, String toolCallId) {
        if (operationItemRepository.existsByOperationIdAndToolCallId(operationId, toolCallId)) {
            throw agentSpawnForbidden("Durable item is not an agent spawn tool call of this parent run");
        }
        if (operationItemRepository.existsBySourceAndToolCallId("agent", toolCallId)) {
            throw agentSpawnForbidden("Durable item belongs to a different parent run");
        }
        throw new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_EVENT_NOT_FOUND", "Spawn item not found");
    }

    private String deriveSpawnContent(String argumentsPreview) {
        if (argumentsPreview == null || argumentsPreview.isBlank()) {
            return "";
        }
        try {
            JsonNode args = objectMapper.readTree(argumentsPreview);
            if (args != null && args.isObject()) {
                for (String field : List.of("prompt", "content", "message", "task")) {
                    JsonNode value = args.get(field);
                    if (value != null && value.isTextual() && !value.textValue().isBlank()) {
                        return value.textValue();
                    }
                }
            }
        } catch (JsonProcessingException e) {
            logger.debug("Spawn arguments preview is not parseable: {}", e.getMessage());
        }
        return "";
    }

    private static CpApiException agentSpawnForbidden(String detail) {
        return new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", detail);
    }

    /**
     * PLAN-0407 T2.5：spawn 准入门。调用方必须已持 parent Run 行锁
     * （{@link ChatRunRepository#findByIdForUpdate}）——与 cancel 的条件更新在同一行
     * 序列化：cancel 先认领则此处拒绝，spawn 先提交则 cancel 的传播看到已提交 child。
     * 只放行在途且未被认领的状态；幂等 replay 在本门之前返回。
     */
    private static void requireActiveParentRunForSpawn(ChatRun parentRun) {
        if (!ChatRunRepository.ACTIVE_LEASE_STATUSES.contains(parentRun.getStatus())) {
            throw new CpApiException(HttpStatus.CONFLICT, "SPAWN_PARENT_RUN_NOT_ACTIVE",
                    "Parent run no longer accepts spawn: " + parentRun.getStatus());
        }
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
                               List<String> attachmentIds, String requestedPrincipalId) {
        bindOrValidateAgentSession(sessionId, userId, workspaceId, requestedPrincipalId);
        rejectConcurrentSubmission(sessionId, userId, idempotencyKey);
        // PLAN-0410 T1.3: resolve the durable branch binding BEFORE any row is
        // written — a missing/failed branch resolution aborts the whole
        // submission instead of leaving a half-created Run/Message pair. M1 has
        // no branch selector, so Run and Message share the Session root.
        String branchId = branchPathService.ensureRootBranchId(sessionId);

        ChatRun chatRun = new ChatRun(
                runId, sessionId, userId, workspaceId, idempotencyKey, requestHash,
                provider, model, toolMode, "accepted");
        chatRun.setOrigin(origin);
        chatRun.setBranchId(branchId);
        chatRun.setLeaseOwner(leaseOwner);
        chatRun.setLeaseExpiresAt(Instant.now().plus(LEASE_TTL));
        chatRun.setProviderConnectionId(providerConnectionId);
        chatRun.setConnectionRevision(connectionRevision);
        chatRunRepository.save(chatRun);

        Message userMessage = new Message(sessionId, MessageRole.USER, content);
        userMessage.setRunId(runId);
        userMessage.setBranchId(branchId);
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

    /**
     * 锁内纵深防御（Session 行锁已由 {@link #bindOrValidateAgentSession} 持有）：
     * ChatController 的 {@code activeRuns} 只是 JVM 内单飞守卫，绕过 controller 的
     * 调用方（未来 caller、多实例）仍可能重复建 run。在插入 ChatRun 之前复查
     * 幂等键与在途（非终态）run，命中都按 CHAT_IN_PROGRESS 409 拒绝——幂等键
     * 命中时让重试方下一次在 controller 层拿到 replay，而不是撞唯一约束 500。
     */
    private void rejectConcurrentSubmission(String sessionId, String userId, String idempotencyKey) {
        if (idempotencyKey != null && chatRunRepository
                .findByUserIdAndSessionIdAndIdempotencyKey(userId, sessionId, idempotencyKey).isPresent()) {
            throw new CpApiException(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS",
                    "Idempotency-Key already has a run for this session");
        }
        if (chatRunRepository.existsBySessionIdAndStatusIn(
                sessionId, ChatRunCancellationService.NON_TERMINAL_STATUSES)) {
            throw new CpApiException(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS",
                    "A chat run is already active for this session");
        }
    }

    private void bindOrValidateAgentSession(String sessionId, String userId, String workspaceId,
                                            String requestedPrincipalId) {
        UUID sessionUuid = UUID.fromString(sessionId);
        dbLockTimeout.apply();
        Session session = sessionRepository.findByIdForUpdate(sessionUuid)
                .filter(candidate -> userId.equals(candidate.getUserId())
                        && workspaceId.equals(candidate.getWorkspaceId())
                        && !candidate.isArchived())
                .orElseThrow(ChatSubmissionService::agentSessionForbidden);

        if (session.getAgentPrincipalId() == null) {
            if (requestedPrincipalId == null || requestedPrincipalId.isBlank()) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "A principal-null Session cannot start an Agent Chat without an explicit principal");
            }
            if (session.getAgentPermissionsSnapshot() != null
                    || chatRunRepository.existsBySessionId(sessionId)
                    || messageRepository.existsBySessionId(sessionId)
                    || ledgerOperationRepository.existsBySessionIdAndActorType(sessionId, "user")
                    || eventStoreRepository.existsBySessionId(sessionId)) {
                throw new CpApiException(HttpStatus.CONFLICT, "SESSION_PRINCIPAL_BINDING_CONFLICT",
                        "Only an empty, unbound Session can be assigned an Agent principal");
            }
            com.fasterxml.jackson.databind.JsonNode cap = agentPrincipalService.resolveSessionCap(
                    requestedPrincipalId, workspaceId);
            try {
                int updated = sessionRepository.bindAgentPrincipalIfNull(sessionUuid, requestedPrincipalId,
                        objectMapper.writeValueAsString(cap));
                if (updated != 1) {
                    throw new CpApiException(HttpStatus.CONFLICT, "SESSION_PRINCIPAL_BINDING_CONFLICT",
                            "Session was concurrently bound to an Agent principal");
                }
            } catch (JsonProcessingException e) {
                throw new IllegalStateException("Unable to serialize Agent Session permission cap", e);
            }
            session.setAgentPrincipalId(requestedPrincipalId);
            session.setAgentPermissionsSnapshot(cap);
        } else if (requestedPrincipalId != null
                && !session.getAgentPrincipalId().equals(requestedPrincipalId)) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_PRINCIPAL_MISMATCH",
                    "agentPrincipalId does not match the Session principal");
        }
        if (session.getAgentPermissionsSnapshot() == null) {
            throw agentSessionForbidden();
        }

        GrantPrincipalPathResolver.AgentPath path;
        try {
            path = principalPathResolver.resolveAgent(userId, workspaceId, sessionId);
        } catch (IllegalArgumentException e) {
            throw agentSessionForbidden();
        }

        boolean activePrincipal = agentPrincipalRepository.findById(path.principalId())
                .filter(principal -> principal.getDisabledAt() == null)
                .isPresent();
        boolean workspaceBound = workspaceAgentRepository.findById(
                new WorkspaceAgentId(path.principalId(), UUID.fromString(workspaceId))).isPresent();
        if (!activePrincipal || !workspaceBound) {
            throw agentSessionForbidden();
        }
    }

    private static CpApiException agentSessionForbidden() {
        return new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                "An active Agent principal bound to this Workspace is required");
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

    public record SpawnResult(String sessionId, String runId, String principalId, String workspaceId) {}

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
