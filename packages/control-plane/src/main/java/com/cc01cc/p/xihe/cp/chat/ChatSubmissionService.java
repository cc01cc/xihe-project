package com.cc01cc.p.xihe.cp.chat;

import jakarta.persistence.EntityManager;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.InboxRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionFollowUpItemRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.ContextTemplateService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * Atomic Chat submission boundary for ChatRun and user Message.
 * Agent dispatch starts only after this transaction has committed.
 */
@Service
public class ChatSubmissionService {
    public static final String SPAWN_TOOL_NAME = "spawn_agent";

    private static final int MAX_SPAWN_ARGUMENTS_PREVIEW_LENGTH = 4096;
    private static final java.time.Duration LEASE_TTL = java.time.Duration.ofMinutes(10);
    private static final Logger logger = LoggerFactory.getLogger(ChatSubmissionService.class);

    private final ChatRunRepository chatRunRepository;
    private final InboxRepository inboxRepository;
    private final MessageRepository messageRepository;
    private final FileRepository fileRepository;
    private final McpInvocationRepository mcpInvocationRepository;
    private final SessionRepository sessionRepository;
    private final SessionFollowUpItemRepository followUpItemRepository;
    private final AgentPrincipalRepository agentPrincipalRepository;
    private final WorkspaceAgentRepository workspaceAgentRepository;
    private final GrantPrincipalPathResolver principalPathResolver;
    private final DbLockTimeout dbLockTimeout;
    private final ObjectMapper objectMapper;
    private final EventStoreRepository eventStoreRepository;
    private final AgentPrincipalService agentPrincipalService;
    private final ContextTemplateService contextTemplateService;
    private final com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService;
    private final EntityManager entityManager;
    private final ApprovalService approvalService;
    private final AuditLogger auditLogger;

    public ChatSubmissionService(ChatRunRepository chatRunRepository,
                                 InboxRepository inboxRepository,
                                 MessageRepository messageRepository,
                                 FileRepository fileRepository,
                                 McpInvocationRepository mcpInvocationRepository,
                                 SessionRepository sessionRepository,
                                 SessionFollowUpItemRepository followUpItemRepository,
                                 AgentPrincipalRepository agentPrincipalRepository,
                                 WorkspaceAgentRepository workspaceAgentRepository,
                                 GrantPrincipalPathResolver principalPathResolver,
                                 DbLockTimeout dbLockTimeout,
                                 ObjectMapper objectMapper,
                                   EventStoreRepository eventStoreRepository,
                                   AgentPrincipalService agentPrincipalService,
                                   ContextTemplateService contextTemplateService,
                                   com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService,
                                  EntityManager entityManager,
                                  ApprovalService approvalService,
                                  AuditLogger auditLogger) {
        this.chatRunRepository = chatRunRepository;
        this.inboxRepository = inboxRepository;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.mcpInvocationRepository = mcpInvocationRepository;
        this.sessionRepository = sessionRepository;
        this.followUpItemRepository = followUpItemRepository;
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.workspaceAgentRepository = workspaceAgentRepository;
        this.principalPathResolver = principalPathResolver;
        this.dbLockTimeout = dbLockTimeout;
        this.objectMapper = objectMapper;
        this.eventStoreRepository = eventStoreRepository;
        this.agentPrincipalService = agentPrincipalService;
        this.contextTemplateService = contextTemplateService;
        this.branchPathService = branchPathService;
        this.entityManager = entityManager;
        this.approvalService = approvalService;
        this.auditLogger = auditLogger;
    }

    @Transactional
    public Submission create(String runId, String sessionId, String userId, String workspaceId,
                             String branchId, String idempotencyKey, String requestHash, String provider,
                             String model, String toolMode, String providerConnectionId,
                             Long connectionRevision, String leaseOwner, String requestId,
                             String content, String attachmentsJson, List<String> attachmentIds) {
        return create(runId, sessionId, userId, workspaceId, branchId, null, idempotencyKey, requestHash,
                provider, model, toolMode, providerConnectionId, connectionRevision,
                leaseOwner, requestId, content, attachmentsJson, attachmentIds);
    }

    @Transactional
    public Submission create(String runId, String sessionId, String userId, String workspaceId,
                             String branchId, String agentPrincipalId, String idempotencyKey, String requestHash,
                             String provider, String model, String toolMode, String providerConnectionId,
                             Long connectionRevision, String leaseOwner, String requestId,
                             String content, String attachmentsJson, List<String> attachmentIds) {
        return persist(ChatRun.ORIGIN_USER_SUBMISSION, runId, sessionId, userId, workspaceId,
                branchId, idempotencyKey, requestHash, provider, model, toolMode, providerConnectionId,
                connectionRevision, leaseOwner, requestId, content, attachmentsJson, attachmentIds,
                agentPrincipalId, false);
    }

    /** Creates a queue child atomically without treating its own outstanding item as a normal Chat conflict. */
    @Transactional
    public Submission createFollowUp(String runId, String sessionId, String userId, String workspaceId,
                                    String branchId, String idempotencyKey, String requestHash, String provider,
                                    String model, String toolMode, String providerConnectionId,
                                    Long connectionRevision, String leaseOwner, String requestId,
                                    String content, String attachmentsJson, List<String> attachmentIds,
                                    String agentPrincipalId) {
        return persist(ChatRun.ORIGIN_USER_SUBMISSION, runId, sessionId, userId, workspaceId,
                branchId, idempotencyKey, requestHash, provider, model, toolMode, providerConnectionId,
                connectionRevision, leaseOwner, requestId, content, attachmentsJson, attachmentIds,
                agentPrincipalId, true);
    }

    /** Persists an assistant response and links it to its Run in the existing order. */
    public String persistAssistantResponse(String sessionId, String runId, String assistantContent) {
        // Preserve the existing repository commit boundaries by keeping this method non-transactional.
        Message assistantMessage = new Message(sessionId, MessageRole.ASSISTANT, assistantContent);
        assistantMessage.setRunId(runId);
        var ownerRun = chatRunRepository.findById(UUID.fromString(runId));
        ownerRun.ifPresent(run -> assistantMessage.setBranchId(run.getBranchId()));
        messageRepository.save(assistantMessage);
        ownerRun.ifPresent(run -> {
            run.setAssistantMessageId(assistantMessage.getId().toString());
            chatRunRepository.save(run);
        });
        return assistantMessage.getId().toString();
    }

    @Transactional(readOnly = true)
    public SpawnInvocation prepareSpawnInvocation(String parentRunId, String toolCallId) {
        requireUuid(parentRunId, "parentRunId");
        requireUuid(toolCallId, "toolCallId");

        ChatRun parentRun = chatRunRepository.findById(UUID.fromString(parentRunId))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_PARENT_RUN_NOT_FOUND",
                        "Parent run or session not found"));
        Session parentSession = sessionRepository.findById(UUID.fromString(parentRun.getSessionId()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_PARENT_RUN_NOT_FOUND",
                        "Parent run or session not found"));
        if (parentSession.isArchived()
                || !parentSession.getUserId().equals(parentRun.getUserId())
                || !parentSession.getWorkspaceId().equals(parentRun.getWorkspaceId())) {
            throw spawnProvenanceConflict("Spawn parent Session and Run do not match");
        }
        requireWorkspaceSpawn(parentRun, parentSession);

        // PLAN-0464 T2.1: spawn provenance is the Chat domain (Run/Session) plus
        // the 0463 execution-domain invocation row, never a Ledger item.
        McpInvocation invocation = requireSpawnInvocation(parentRunId, toolCallId);
        validateSpawnInvocation(parentRunId, invocation);
        String content = deriveSpawnContent(invocation.getArgumentsPreview());
        return new SpawnInvocation(parentRunId, toolCallId, parentSession.getId().toString(),
                invocation.getId(), parentRun.getUserId(), parentRun.getWorkspaceId(),
                parentSession.getAgentPrincipalId(), createSpawnAuthorizationBody(content));
    }

    public void validateSpawnMcpArguments(SpawnInvocation invocation, String mcpBody) {
        if (mcpBody == null || mcpBody.isBlank()) {
            throw invalidSpawnArguments();
        }
        try {
            JsonNode request = objectMapper.reader()
                    .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .readTree(mcpBody);
            JsonNode params = request == null ? null : request.get("params");
            JsonNode requestArguments = params == null ? null : params.get("arguments");
            JsonNode expectedBody = objectMapper.readTree(invocation.authorizationBody());
            JsonNode expectedArguments = expectedBody.path("params").path("arguments");
            if (request == null || !"tools/call".equals(request.path("method").asText())
                    || params == null || !SPAWN_TOOL_NAME.equals(params.path("name").asText())
                    || requestArguments == null || !requestArguments.isObject()
                    || requestArguments.size() != 1 || !requestArguments.equals(expectedArguments)) {
                throw new CpApiException(HttpStatus.CONFLICT, "SPAWN_ARGUMENTS_CHANGED",
                        "MCP spawn arguments do not match the durable Agent tool call");
            }
        } catch (JsonProcessingException e) {
            logger.warn("[LIFECYCLE] service=cp event=spawn_mcp_arguments_rejected failureType={}",
                    e.getClass().getSimpleName());
            throw invalidSpawnArguments();
        }
    }

    @Transactional
    public SpawnResult createSpawnFromParent(String parentRunId, String toolCallId,
                                            SpawnAuthorization authorization) {
        requireUuid(parentRunId, "parentRunId");
        requireUuid(toolCallId, "toolCallId");
        if (authorization == null || authorization.authorizationBody() == null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Spawn authorization is required");
        }

        LockedSpawnParent lockedParent = lockSpawnParent(parentRunId, null, null, null,
                () -> new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_PARENT_RUN_NOT_FOUND",
                        "Parent run or session not found"));
        ChatRun parentRun = lockedParent.run();
        Session parentSession = lockedParent.session();
        requireWorkspaceSpawn(parentRun, parentSession);
        // Admission runs before any durable read: a terminal/dead parent run
        // rejects the spawn with the domain conflict code, not a lookup miss.
        requireActiveParentRunForSpawn(parentRun);

        // PLAN-0464 T2.1: provenance comes from the 0463 invocation row plus the
        // locked Chat domain, never from a Ledger root/item.
        McpInvocation invocation = requireSpawnInvocation(parentRunId, toolCallId);
        validateSpawnInvocation(parentRunId, invocation);

        String content = deriveSpawnContent(invocation.getArgumentsPreview());
        String authorizationBody = createSpawnAuthorizationBody(content);
        if (!authorizationBody.equals(authorization.authorizationBody())) {
            throw new CpApiException(HttpStatus.CONFLICT, "SPAWN_ARGUMENTS_CHANGED",
                    "Durable spawn arguments changed after authorization");
        }
        String requestHash = ChatRequestHash.calculate(objectMapper, content, parentRun.getProvider(),
                parentRun.getModel(), parentRun.getToolMode(), List.of(), Map.of());

        // The spawn idempotency key is the canonical tool call id: a stable
        // execution-domain identity instead of a retired Ledger row id.
        String idempotencyKey = toolCallId;
        ChatRun existingSpawn = chatRunRepository
                .findByUserIdAndIdempotencyKeyAndOrigin(parentRun.getUserId(), idempotencyKey,
                        ChatRun.ORIGIN_SPAWN)
                .orElse(null);
        if (existingSpawn != null) {
            if (!requestHash.equals(existingSpawn.getRequestHash())) {
                throw idempotencyConflict();
            }
            if (!parentRunId.equals(existingSpawn.getWaitingOnRunId())
                    || !toolCallId.equals(existingSpawn.getWaitingToolCallId())) {
                throw spawnProvenanceConflict("Existing child run is not linked from its parent spawn call");
            }
            Session existingSession = sessionRepository
                    .findByIdForUpdate(UUID.fromString(existingSpawn.getSessionId()))
                    .orElseThrow(() -> new IllegalStateException("Spawn session is missing"));
            entityManager.refresh(existingSession);
            return new SpawnResult(existingSession.getId().toString(), existingSpawn.getId().toString(),
                    existingSession.getAgentPrincipalId(), parentRun.getWorkspaceId());
        }

        // PLAN-0407 T2.5：cancel 获胜拒绝新 spawn——门在 child Session 创建之前，
        // 拒绝路径零写入。PLAN-0464 把同一门提到 invocation 读取之前，使死 run
        // 报 admission conflict 而不是 lookup miss（行锁内状态不可能并发变化）。

        if (parentSession.getAgentPrincipalId() == null || parentSession.getAgentPermissionsSnapshot() == null) {
            throw agentSessionForbidden();
        }

        JsonNode childPermissions = agentPrincipalService.deriveSpawnChildCap(
                parentSession.getAgentPermissionsSnapshot(), parentSession.getAgentPrincipalId(),
                parentRun.getWorkspaceId());
        if (authorization.approvalGrantId() != null
                && !approvalService.consumeApprovedGrant(authorization.approvalGrantId(), parentRun.getUserId(),
                        parentRun.getWorkspaceId(), parentSession.getId().toString(), SPAWN_TOOL_NAME,
                        authorizationBody)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "APPROVAL_GRANT_INVALID",
                    "Spawn approval grant is invalid or no longer usable");
        }

        Session childSession = new Session(parentRun.getWorkspaceId(), parentRun.getUserId(),
                parentSession.getTitle());
        childSession.setId(UUID.randomUUID());
        childSession.setKind(Session.KIND_SPAWN);
        childSession.setSpawnedFromSessionId(parentSession.getId());
        childSession.setSpawnedFromRunId(parentRun.getId());
        childSession.setSpawnedAt(Instant.now());
        childSession.setAgentPrincipalId(parentSession.getAgentPrincipalId());
        childSession.setAgentPermissionsSnapshot(childPermissions);
        childSession.setModelProvider(parentSession.getModelProvider());
        childSession.setModelName(parentSession.getModelName());
        childSession.setProviderConnectionId(parentSession.getProviderConnectionId());
        childSession.setConnectionRevision(parentSession.getConnectionRevision());
        childSession.setApprovalMode(parentSession.getApprovalMode());
        childSession.setContextTemplateLayer(parentSession.getContextTemplateLayer());
        childSession.setContextTemplateId(parentSession.getContextTemplateId());
        childSession.setContextTemplateVersion(parentSession.getContextTemplateVersion());
        sessionRepository.save(childSession);

        String requestId = UUID.randomUUID().toString();
        String childRunId = UUID.randomUUID().toString();
        String childBranchId = branchPathService.ensureRootBranchId(childSession.getId().toString());
        Submission created = persist(ChatRun.ORIGIN_SPAWN, childRunId, childSession.getId().toString(),
                parentRun.getUserId(), parentRun.getWorkspaceId(), childBranchId, idempotencyKey,
                requestHash,
                parentRun.getProvider(), parentRun.getModel(), parentRun.getToolMode(),
                parentRun.getProviderConnectionId(), parentRun.getConnectionRevision(), null, requestId,
                content, "[]", List.of(), childSession.getAgentPrincipalId(), false);
        // PLAN-0464 T2.1: the waiting link lives on the child run row itself.
        ChatRun childRun = created.run();
        childRun.setWaitingOnRunId(parentRun.getId().toString());
        childRun.setWaitingToolCallId(invocation.getToolCallId());
        chatRunRepository.save(childRun);

        com.fasterxml.jackson.databind.node.ObjectNode detail = objectMapper.createObjectNode();
        detail.put("authorizationAction", "SPAWN_AGENT");
        detail.put("parentSessionId", parentSession.getId().toString());
        detail.put("parentRunId", parentRun.getId().toString());
        detail.put("parentToolCallId", invocation.getToolCallId());
        detail.put("parentInvocationId", invocation.getId().toString());
        detail.put("childSessionId", childSession.getId().toString());
        detail.put("childRunId", created.run().getId().toString());
        detail.put("agentPrincipalId", childSession.getAgentPrincipalId());
        if (authorization.approvalGrantId() != null) {
            detail.put("approvalRequestId", authorization.approvalGrantId());
        }
        auditLogger.recordDurableChange(parentRun.getUserId(), parentRun.getWorkspaceId(),
                "agent_spawn_created", "chat_session", childSession.getId().toString(), detail.toString());

        return new SpawnResult(childSession.getId().toString(), created.run().getId().toString(),
                childSession.getAgentPrincipalId(), parentRun.getWorkspaceId());
    }

    private LockedSpawnParent lockSpawnParent(String parentRunId,
                                              String expectedParentSessionId,
                                              String expectedUserId,
                                              String expectedWorkspaceId,
                                              Supplier<CpApiException> missingParent) {
        dbLockTimeout.apply();
        UUID parentRunUuid = UUID.fromString(parentRunId);
        ChatRun locator = chatRunRepository.findById(parentRunUuid).orElseThrow(missingParent);
        UUID parentSessionUuid = UUID.fromString(locator.getSessionId());

        Session parentSession = sessionRepository.findByIdForUpdate(parentSessionUuid)
                .orElseThrow(missingParent);
        entityManager.refresh(parentSession);

        ChatRun parentRun = chatRunRepository.findByIdForUpdate(parentRunUuid).orElseThrow(missingParent);
        entityManager.refresh(parentRun);
        if (!parentSessionUuid.equals(parentSession.getId())
                || !parentSessionUuid.equals(UUID.fromString(parentRun.getSessionId()))) {
            throw missingParent.get();
        }
        if (parentSession.isArchived()
                || !parentSession.getUserId().equals(parentRun.getUserId())
                || !parentSession.getWorkspaceId().equals(parentRun.getWorkspaceId())
                || (expectedParentSessionId != null
                        && !parentSessionUuid.toString().equals(expectedParentSessionId))
                || (expectedUserId != null && !expectedUserId.equals(parentRun.getUserId()))
                || (expectedWorkspaceId != null && !expectedWorkspaceId.equals(parentRun.getWorkspaceId()))) {
            throw spawnProvenanceConflict("Spawn parent Session and Run do not match the request");
        }
        return new LockedSpawnParent(parentSession, parentRun);
    }

    private String deriveSpawnContent(String argumentsPreview) {
        if (argumentsPreview == null || argumentsPreview.isBlank()
                || argumentsPreview.length() >= MAX_SPAWN_ARGUMENTS_PREVIEW_LENGTH) {
            throw invalidSpawnArguments();
        }
        try {
            JsonNode args = objectMapper.reader()
                    .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .readTree(argumentsPreview);
            JsonNode prompt = args == null ? null : args.get("prompt");
            if (args == null || !args.isObject() || args.size() != 1
                    || prompt == null || !prompt.isTextual() || prompt.textValue().isBlank()) {
                throw invalidSpawnArguments();
            }
            return prompt.textValue();
        } catch (JsonProcessingException e) {
            logger.warn("[LIFECYCLE] service=cp event=spawn_arguments_rejected failureType={}",
                    e.getClass().getSimpleName());
            throw invalidSpawnArguments();
        }
    }

    private String createSpawnAuthorizationBody(String content) {
        com.fasterxml.jackson.databind.node.ObjectNode body = objectMapper.createObjectNode();
        body.put("jsonrpc", "2.0");
        body.put("method", "tools/call");
        body.put("id", 1);
        com.fasterxml.jackson.databind.node.ObjectNode params = body.putObject("params");
        params.put("name", SPAWN_TOOL_NAME);
        params.putObject("arguments").put("prompt", content);
        return body.toString();
    }

    /**
     * PLAN-0464 T2.1: resolves the durable spawn tool call from the execution
     * domain. A tool call that exists under another parent run is a cross-parent
     * reference (403); a tool call that does not exist at all is missing (404).
     */
    private McpInvocation requireSpawnInvocation(String parentRunId, String toolCallId) {
        return mcpInvocationRepository
                .findByRunIdAndToolCallIdAndSource(parentRunId, toolCallId, McpInvocation.SOURCE_AGENT)
                .orElseGet(() -> rejectUnmatchedSpawnInvocation(toolCallId));
    }

    private McpInvocation rejectUnmatchedSpawnInvocation(String toolCallId) {
        if (mcpInvocationRepository.findBySourceAndToolCallId(McpInvocation.SOURCE_AGENT, toolCallId).isPresent()) {
            throw agentSpawnForbidden("Durable invocation belongs to a different parent run");
        }
        throw new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_EVENT_NOT_FOUND", "Spawn item not found");
    }

    /** PLAN-0464 T2.1: invocation-side equivalent of the retired item check. */
    private void validateSpawnInvocation(String parentRunId, McpInvocation invocation) {
        if (!parentRunId.equals(invocation.getRunId())
                || !McpInvocation.SOURCE_AGENT.equals(invocation.getSource())
                || !SPAWN_TOOL_NAME.equals(invocation.getToolName())) {
            throw agentSpawnForbidden(
                    "Durable invocation is not an agent spawn_agent tool call of this parent run");
        }
    }

    private void requireWorkspaceSpawn(ChatRun parentRun, Session parentSession) {
        if (!"workspace".equals(parentRun.getToolMode())) {
            throw agentSpawnForbidden("spawn_agent is available only to workspace-mode runs");
        }
        if (parentSession.getAgentPrincipalId() == null || parentSession.getAgentPermissionsSnapshot() == null) {
            throw agentSessionForbidden();
        }
    }

    private static CpApiException invalidSpawnArguments() {
        return new CpApiException(HttpStatus.BAD_REQUEST, "SPAWN_ARGUMENTS_INVALID",
                "Durable spawn arguments must be a complete prompt-only object below the preview limit");
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

    private Submission persist(String origin, String runId, String sessionId, String userId, String workspaceId,
                               String requestedBranchId, String idempotencyKey, String requestHash,
                                String provider, String model,
                                String toolMode, String providerConnectionId, Long connectionRevision,
                                String leaseOwner, String requestId, String content, String attachmentsJson,
                                List<String> attachmentIds, String requestedPrincipalId,
                                boolean followUpAdmission) {
        Session session = bindOrValidateAgentSession(sessionId, userId, workspaceId, requestedPrincipalId);
        if (session.getDeleteRequestedAt() != null) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_DELETING",
                    "Session deletion is in progress");
        }
        if (!followUpAdmission && followUpItemRepository.countBySessionIdAndStatusIn(
                sessionId, SessionFollowUpItemRepository.OUTSTANDING_STATUSES) > 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "FOLLOW_UP_QUEUE_NOT_EMPTY",
                    "Follow-up queue must be drained before sending a normal Chat message");
        }
        rejectConcurrentSubmission(sessionId, userId, idempotencyKey, followUpAdmission);
        if (requestedBranchId == null || requestedBranchId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "branchId is required");
        }
        // PLAN-0410 T1.3: resolve the explicitly selected durable branch before
        // any Run/Message row is written; a missing path aborts the transaction.
        String branchId = branchPathService.resolveVisibility(sessionId, requestedBranchId).currentBranchId();

        ChatRun chatRun = new ChatRun(
                runId, sessionId, userId, workspaceId, idempotencyKey, requestHash,
                provider, model, toolMode, "accepted");
        chatRun.setOrigin(origin);
        chatRun.setBranchId(branchId);
        // PLAN-0414 T1.4: admission fixes one atomic Context Template snapshot
        // from the Session binding; template edits cannot mutate a live Run.
        chatRun.setContextTemplateSnapshot(contextTemplateService.resolveSnapshot(
                session.getContextTemplateLayer(), session.getContextTemplateId().toString(),
                session.getContextTemplateVersion(), userId, workspaceId));
        chatRun.setLeaseOwner(leaseOwner);
        chatRun.setLeaseExpiresAt(Instant.now().plus(LEASE_TTL));
        chatRun.setProviderConnectionId(providerConnectionId);
        chatRun.setConnectionRevision(connectionRevision);
        // PLAN-0464 T1.1: ChatRun is the only admission root. Conflicts are owned
        // by the chat_runs unique indexes; a race that slips past the in-memory
        // and locked pre-checks surfaces on this insert and maps to the same 409.
        try {
            chatRunRepository.saveAndFlush(chatRun);
        } catch (DataIntegrityViolationException e) {
            throw admissionConflict(e);
        }

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

        int claimedNotices = inboxRepository.claimPendingForRun(UUID.fromString(sessionId), UUID.fromString(runId));
        if (claimedNotices > 0) {
            logger.info("[LIFECYCLE] service=cp event=derived_inbox_claimed sessionId={} runId={} count={}",
                    sessionId, runId, claimedNotices);
        }
        return new Submission(chatRun, userMessage);
    }

    /** Unique-index admission conflicts are 409s, never 500s (V2 equivalence). */
    private static CpApiException admissionConflict(DataIntegrityViolationException e) {
        String reason = e.getMostSpecificCause() != null
                ? e.getMostSpecificCause().getMessage() : e.getMessage();
        logger.warn("[LIFECYCLE] service=cp event=chat_admission_conflict reason={}", reason);
        if (reason != null && reason.contains("spawn_event_idempotency")) {
            return idempotencyConflict();
        }
        return new CpApiException(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS",
                "Idempotency-Key already has a run for this session");
    }

    /**
     * 锁内纵深防御（Session 行锁已由 {@link #bindOrValidateAgentSession} 持有）：
     * ChatController 的 {@code activeRuns} 只是 JVM 内单飞守卫，绕过 controller 的
     * 调用方（未来 caller、多实例）仍可能重复建 run。在插入 ChatRun 之前复查
     * 幂等键与在途（非终态）run，命中都按 CHAT_IN_PROGRESS 409 拒绝——幂等键
     * 命中时让重试方下一次在 controller 层拿到 replay，而不是撞唯一约束 500。
     */
    private void rejectConcurrentSubmission(String sessionId, String userId, String idempotencyKey,
                                            boolean followUpAdmission) {
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
        // PLAN-0442 合规收窄（A类）：契约 §85 要求 Follow-up dispatcher 在 admission 前
        // 确认“DB 无活动 Run/未过期 Run lease”；普通 Chat 的冻结基线（M0/design #6）只有
        // 非终态单飞拒绝——terminal 后等待 releaseRun 清 lease 的毫秒窗口不构成“并发”，
        // 把它一并拒绝会收紧普通 Chat 语义并打破既有 terminalize→二次 create 流程。
        if (followUpAdmission && chatRunRepository
                .existsBySessionIdAndLeaseOwnerIsNotNullAndLeaseExpiresAtAfter(sessionId, Instant.now())) {
            throw new CpApiException(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS",
                    "The previous chat run is still releasing its session lease");
        }
    }

    private Session bindOrValidateAgentSession(String sessionId, String userId, String workspaceId,
                                               String requestedPrincipalId) {
        UUID sessionUuid = UUID.fromString(sessionId);
        dbLockTimeout.apply();
        Session session = sessionRepository.findByIdForUpdate(sessionUuid)
                .filter(candidate -> userId.equals(candidate.getUserId())
                        && workspaceId.equals(candidate.getWorkspaceId())
                        && !candidate.isArchived())
                .orElseThrow(ChatSubmissionService::agentSessionForbidden);
        entityManager.refresh(session);
        if (session.getDeleteRequestedAt() != null) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_DELETING",
                    "Session is being deleted");
        }

        if (session.getAgentPrincipalId() == null) {
            if (requestedPrincipalId == null || requestedPrincipalId.isBlank()) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "A principal-null Session cannot start an Agent Chat without an explicit principal");
            }
            if (session.getAgentPermissionsSnapshot() != null
                    || chatRunRepository.existsBySessionId(sessionId)
                    || messageRepository.existsBySessionId(sessionId)
                    || mcpInvocationRepository.existsBySessionId(sessionId)
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
        return session;
    }

    private static CpApiException agentSessionForbidden() {
        return new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                "An active Agent principal bound to this Workspace is required");
    }

    private Submission replay(ChatRun run) {
        Message message = messageRepository.findById(UUID.fromString(run.getUserMessageId()))
                .orElseThrow(() -> new IllegalStateException("ChatRun user message is missing"));
        return new Submission(run, message);
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

    /** PLAN-0464 T1.1: the ChatRun row is the only durable root of a submission. */
    public record Submission(ChatRun run, Message userMessage) {}

    public record SpawnResult(String sessionId, String runId, String principalId, String workspaceId) {}

    public record SpawnInvocation(String parentRunId, String toolCallId, String parentSessionId,
                                  UUID mcpInvocationId, String userId,
                                  String workspaceId, String principalId, String authorizationBody) {
        @Override
        public String toString() {
            return "SpawnInvocation[parentRunId=" + parentRunId + ", toolCallId=" + toolCallId
                    + ", mcpInvocationId=" + mcpInvocationId + "]";
        }
    }

    public record SpawnAuthorization(String authorizationBody, String approvalGrantId, String policySummary) {
        @Override
        public String toString() {
            return "SpawnAuthorization[approvalGrantId=" + approvalGrantId + "]";
        }
    }

    private record LockedSpawnParent(Session session, ChatRun run) {}
}
