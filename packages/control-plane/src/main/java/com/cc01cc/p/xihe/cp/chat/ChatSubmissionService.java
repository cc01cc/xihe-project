package com.cc01cc.p.xihe.cp.chat;

import jakarta.persistence.EntityManager;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.InboxRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionFollowUpItemRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * Atomic Chat submission boundary for ChatRun and user Message.
 * Agent dispatch starts only after this transaction has committed.
 */
@Service
public class ChatSubmissionService {

    @org.springframework.beans.factory.annotation.Autowired
    private com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService apiRequestTemplates;
    public static final String SPAWN_TOOL_NAME = "spawn_agent";

    private static final int MAX_SPAWN_ARGUMENTS_PREVIEW_LENGTH = 4096;
    private static final java.time.Duration LEASE_TTL = java.time.Duration.ofMinutes(10);
    private static final Logger logger = LoggerFactory.getLogger(ChatSubmissionService.class);

    private final ChatRunRepository chatRunRepository;
    private final InboxRepository inboxRepository;
    private final MessageRepository messageRepository;
    private final SessionRepository sessionRepository;
    private final SessionFollowUpItemRepository followUpItemRepository;
    private final GrantPrincipalPathResolver principalPathResolver;
    private final DbLockTimeout dbLockTimeout;
    private final ObjectMapper objectMapper;
    private final AgentPrincipalService agentPrincipalService;
    private final com.cc01cc.p.xihe.cp.service.SessionParticipantService sessionParticipantService;
    private final com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService;
    private final EntityManager entityManager;
    private final ApprovalService approvalService;
    private final DelegationBudgetService delegationBudgetService;
    private final AuditLogger auditLogger;
    // PLAN-0470 (decision #16): cross-domain admission reads go through the
    // MCP/Context owner services inside this transaction — no direct repos.
    private final McpInvocationService mcpInvocationService;
    private final EventStoreService eventStoreService;
    // PLAN-0470 (decision #23): the attachment->Message link write is owned
    // by Files (ChatAttachmentService); this service no longer holds FileRepository.
    private final com.cc01cc.p.xihe.cp.files.ChatAttachmentService chatAttachmentService;
    private final ObjectProvider<WakeChainService> wakeChainService;
    private final ToolCallSnapshotService toolCallSnapshotService;
    // PLAN-0628 M2a (D28-35): the skills listing frozen in the same admission transaction.
    private final com.cc01cc.p.xihe.cp.skill.SkillCatalogSnapshotService skillCatalogSnapshots;
    // PLAN-0645 D45-01: the Session's bounded-concurrency admission gate (replaces single-flight).
    private final SessionRunConcurrencyGate runConcurrencyGate;

    public ChatSubmissionService(ChatRunRepository chatRunRepository,
                                 InboxRepository inboxRepository,
                                 MessageRepository messageRepository,
                                 SessionRepository sessionRepository,
                                 SessionFollowUpItemRepository followUpItemRepository,
                                 GrantPrincipalPathResolver principalPathResolver,
                                 DbLockTimeout dbLockTimeout,
                                 ObjectMapper objectMapper,
                                 AgentPrincipalService agentPrincipalService,
                                 com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService,
                                 EntityManager entityManager,
                                 ApprovalService approvalService,
                                 AuditLogger auditLogger,
                                 McpInvocationService mcpInvocationService,
                                 EventStoreService eventStoreService,
                                 com.cc01cc.p.xihe.cp.files.ChatAttachmentService chatAttachmentService,
                                 ObjectProvider<WakeChainService> wakeChainService,
                                 ToolCallSnapshotService toolCallSnapshotService,
                                 com.cc01cc.p.xihe.cp.service.SessionParticipantService sessionParticipantService,
                                 DelegationBudgetService delegationBudgetService,
                                 com.cc01cc.p.xihe.cp.skill.SkillCatalogSnapshotService skillCatalogSnapshots,
                                 SessionRunConcurrencyGate runConcurrencyGate) {
        this.chatRunRepository = chatRunRepository;
        this.inboxRepository = inboxRepository;
        this.messageRepository = messageRepository;
        this.sessionRepository = sessionRepository;
        this.followUpItemRepository = followUpItemRepository;
        this.principalPathResolver = principalPathResolver;
        this.dbLockTimeout = dbLockTimeout;
        this.objectMapper = objectMapper;
        this.agentPrincipalService = agentPrincipalService;
        this.sessionParticipantService = sessionParticipantService;
        this.branchPathService = branchPathService;
        this.entityManager = entityManager;
        this.approvalService = approvalService;
        this.delegationBudgetService = delegationBudgetService;
        this.auditLogger = auditLogger;
        this.mcpInvocationService = mcpInvocationService;
        this.eventStoreService = eventStoreService;
        this.chatAttachmentService = chatAttachmentService;
        // PLAN-0632 native: an @Lazy injection point forces a runtime CGLIB proxy whose
        // CGLIB$FACTORY_DATA static field is not reflection-reachable (MissingReflection
        // RegistrationError at context init). ObjectProvider breaks the same construction
        // cycle without any proxy: the bean resolves on first use, from the context.
        this.wakeChainService = wakeChainService;
        this.toolCallSnapshotService = toolCallSnapshotService;
        this.skillCatalogSnapshots = skillCatalogSnapshots;
        this.runConcurrencyGate = runConcurrencyGate;
    }

    @Transactional
    public Submission create(String runId, String sessionId, String userId, String workspaceId,
                             String branchId, String idempotencyKey, String requestHash, String provider,
                             String model, String toolMode, String providerConnectionId,
                             Long connectionRevision, String leaseOwner, String requestId,
                             String content, String attachmentsJson, List<String> attachmentIds) {
        return create(runId, sessionId, userId, workspaceId, branchId, null, idempotencyKey, requestHash,
                provider, model, toolMode, providerConnectionId, connectionRevision,
                leaseOwner, requestId, content, attachmentsJson, attachmentIds, null);
    }

    @Transactional
    public Submission create(String runId, String sessionId, String userId, String workspaceId,
                             String branchId, String agentPrincipalId, String idempotencyKey, String requestHash,
                             String provider, String model, String toolMode, String providerConnectionId,
                             Long connectionRevision, String leaseOwner, String requestId,
                             String content, String attachmentsJson, List<String> attachmentIds) {
        return create(runId, sessionId, userId, workspaceId, branchId, agentPrincipalId, idempotencyKey,
                requestHash, provider, model, toolMode, providerConnectionId, connectionRevision,
                leaseOwner, requestId, content, attachmentsJson, attachmentIds, null);
    }

    @Transactional
    public Submission create(String runId, String sessionId, String userId, String workspaceId,
            String branchId, String agentPrincipalId, String idempotencyKey, String requestHash,
            String provider, String model, String toolMode, String providerConnectionId,
            Long connectionRevision, String leaseOwner, String requestId,
            String content, String attachmentsJson, List<String> attachmentIds,
            String asParticipantId) {
        Submission submission = persist(ChatRun.ORIGIN_USER_SUBMISSION, runId, sessionId, userId, workspaceId,
                branchId, idempotencyKey, requestHash, provider, model, toolMode, providerConnectionId,
                connectionRevision, leaseOwner, requestId, content, attachmentsJson, attachmentIds,
                agentPrincipalId, false, Message.VISIBILITY_USER);
        // R1 (PLAN-0623): record who answered. `asParticipantId` wins (already authorized by the
        // controller); otherwise the PRIMARY participant answers; a Session with neither keeps NULL —
        // the same "never invent a responder" rule the V92 backfill follows.
        UUID responder = sessionParticipantService.responderPrincipalIdFor(
                UUID.fromString(sessionId), asParticipantId);
        if (responder != null) {
            submission.run().setAgentPrincipalId(responder);
        }
        return submission;
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
                agentPrincipalId, true, Message.VISIBILITY_USER);
    }

    /**
     * PLAN-0489 决策 #7: durable ChatRun carrier for an idle-session scheduled
     * wakeup — same atomic ChatRun + user Message persist as a user submission
     * (status=accepted), provenance origin=scheduled, hung on the existing
     * target Session (never a spawn child). Lease/registry handoff is owned by
     * the dispatch caller, mirroring the spawn Run (leaseOwner stays null here).
     */
    @Transactional
    public Submission createScheduled(String runId, String sessionId, String userId, String workspaceId,
                                      String branchId, String idempotencyKey, String requestHash, String provider,
                                      String model, String toolMode, String providerConnectionId,
                                      Long connectionRevision, String leaseOwner, String requestId,
                                      String content, String attachmentsJson, List<String> attachmentIds,
                                      String agentPrincipalId) {
        return createScheduled(runId, sessionId, userId, workspaceId, branchId, idempotencyKey, requestHash,
                provider, model, toolMode, providerConnectionId, connectionRevision, leaseOwner, requestId,
                content, attachmentsJson, attachmentIds, agentPrincipalId, Message.VISIBILITY_USER);
    }

    /**
     * PLAN-0630 M5b / D3: the wake path persists its instruction with
     * {@link Message#VISIBILITY_INTERNAL}, so the prompt reaches the model without ever rendering
     * as a user turn in the conversation.
     */
    @Transactional
    public Submission createScheduled(String runId, String sessionId, String userId, String workspaceId,
                                      String branchId, String idempotencyKey, String requestHash, String provider,
                                      String model, String toolMode, String providerConnectionId,
                                      Long connectionRevision, String leaseOwner, String requestId,
                                      String content, String attachmentsJson, List<String> attachmentIds,
                                      String agentPrincipalId, String messageVisibility) {
        return persist(ChatRun.ORIGIN_SCHEDULED, runId, sessionId, userId, workspaceId,
                branchId, idempotencyKey, requestHash, provider, model, toolMode, providerConnectionId,
                connectionRevision, leaseOwner, requestId, content, attachmentsJson, attachmentIds,
                agentPrincipalId, false, messageVisibility);
    }

    /**
     * Persists an assistant response and links it to its Run in the existing order.
     *
     * <p>PLAN-0572 D1=A/D5: the Message carries a bounded snapshot of this Run's
     * tool calls; a terminal tool-only turn (blank assistant text) is persisted
     * when the snapshot is non-empty. Returns {@code null} when there is nothing
     * renderable to persist.</p>
     */
    public String persistAssistantResponse(String sessionId, String runId, String assistantContent) {
        // Preserve the existing repository commit boundaries by keeping this method non-transactional.
        String toolCalls = toolCallSnapshotService.snapshotJson(sessionId, runId);
        String content = assistantContent == null ? "" : assistantContent;
        if (content.isBlank() && toolCalls == null) {
            return null;
        }
        Message assistantMessage = new Message(sessionId, MessageRole.ASSISTANT, content);
        assistantMessage.setRunId(runId);
        assistantMessage.setToolCalls(toolCalls);
        var ownerRun = chatRunRepository.findById(UUID.fromString(runId));
        ownerRun.ifPresent(run -> assistantMessage.setBranchId(run.getBranchId()));
        messageRepository.save(assistantMessage);
        ownerRun.ifPresent(run -> {
            run.setAssistantMessageId(assistantMessage.getId().toString());
            chatRunRepository.save(run);
        });
        // PLAN-0624 M3: agent 产出里的提及开链（深度/环检查在 WakeChainService）。
        // ObjectProvider on the constructor (was @Lazy — see the assignment comment):
        // WakeChainService → WakeDispatchService →
        // SessionWakeupService → this service is a cycle; the proxy breaks it.
        wakeChainService.getObject().onAssistantContent(sessionId, runId, content);
        return assistantMessage.getId().toString();
    }

    public Optional<SubmissionReplay> findSubmissionReplay(String userId, String sessionId,
                                                            String idempotencyKey, String requestHash) {
        ChatRun existingRun = chatRunRepository
                .findByUserIdAndSessionIdAndIdempotencyKey(userId, sessionId, idempotencyKey)
                .orElse(null);
        if (existingRun == null) {
            return Optional.empty();
        }
        if (!ChatRun.ORIGIN_USER_SUBMISSION.equals(existingRun.getOrigin())) {
            throw new CpApiException(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_CONFLICT",
                    "Idempotency-Key belongs to a derived run");
        }
        if (!requestHash.equals(existingRun.getRequestHash())) {
            throw new CpApiException(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_CONFLICT",
                    "Idempotency-Key was already used for a different request");
        }
        return Optional.of(new SubmissionReplay(existingRun.getStatus(), existingRun.getOrigin(),
                existingRun.getSessionId(), existingRun.getId(), existingRun.getProviderConnectionId(),
                existingRun.getConnectionRevision(), existingRun.getUserMessageId(),
                existingRun.getTerminalOutcome(), existingRun.getErrorCode()));
    }

    public void persistRunStatus(ChatRun run, String status) {
        // Keep the status save at the same repository transaction boundary as the Controller path.
        run.setStatus(status);
        chatRunRepository.save(run);
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
        McpInvocationService.SpawnInvocationView invocation = requireSpawnInvocation(parentRunId, toolCallId);
        validateSpawnInvocation(parentRunId, invocation);
        String content = deriveSpawnContent(invocation.argumentsPreview());
        return new SpawnInvocation(parentRunId, toolCallId, parentSession.getId().toString(),
                invocation.id(), parentRun.getUserId(), parentRun.getWorkspaceId(),
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
        McpInvocationService.SpawnInvocationView invocation = requireSpawnInvocation(parentRunId, toolCallId);
        validateSpawnInvocation(parentRunId, invocation);

        String content = deriveSpawnContent(invocation.argumentsPreview());
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

        // PLAN-0630 M1: the delegation budget gate. Position is load-bearing (INV-8 + INV-1) and must
        // stay between the idempotency replay above and consumeApprovedGrant below:
        //   - BEFORE the replay: a retry of the SAME tool call would be refused by the budget, because
        //     the child it already created is the slot that makes the tree look full — the idempotency
        //     contract ("same toolCallId replays the existing run") would break.
        //   - AFTER consumeApprovedGrant: a refusal would burn the user's one-shot approval.
        // It also has to sit inside the parent Session+Run row locks (lockSpawnParent above), otherwise
        // two concurrent spawns both read a snapshot without each other and overshoot.
        delegationBudgetService.requireWithinBudget(parentSession, parentRun, toolCallId);

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
        // PLAN-0630 M1 (BL-192 / D23-13): a spawn child is a standard Session (README frozen ruling
        // #1), so it must own exactly one PRIMARY — the same rule as create (SessionService.java:139)
        // and fork (SessionService.java:173). Without it the child's roster is empty, so the 0624
        // mention/wake chain silently no-ops inside the sub-conversation (the agent there could never
        // wake anyone, and there was no "primary speaker" row either).
        // Existing spawn children are deliberately NOT backfilled: XH has no deployment surface
        // (0625 D25-19 precedent), so the fix covers new children only.
        sessionParticipantService.ensurePrimaryParticipant(childSession.getId(),
                childSession.getAgentPrincipalId());

        String requestId = UUID.randomUUID().toString();
        String childRunId = UUID.randomUUID().toString();
        String childBranchId = branchPathService.ensureRootBranchId(childSession.getId().toString());
        Submission created = persist(ChatRun.ORIGIN_SPAWN, childRunId, childSession.getId().toString(),
                parentRun.getUserId(), parentRun.getWorkspaceId(), childBranchId, idempotencyKey,
                requestHash,
                parentRun.getProvider(), parentRun.getModel(), parentRun.getToolMode(),
                parentRun.getProviderConnectionId(), parentRun.getConnectionRevision(), null, requestId,
                content, "[]", List.of(), childSession.getAgentPrincipalId(), false, Message.VISIBILITY_USER);
        // PLAN-0464 T2.1: the waiting link lives on the child run row itself.
        ChatRun childRun = created.run();
        childRun.setWaitingOnRunId(parentRun.getId().toString());
        childRun.setWaitingToolCallId(invocation.toolCallId());
        chatRunRepository.save(childRun);

        com.fasterxml.jackson.databind.node.ObjectNode detail = objectMapper.createObjectNode();
        detail.put("authorizationAction", "SPAWN_AGENT");
        detail.put("parentSessionId", parentSession.getId().toString());
        detail.put("parentRunId", parentRun.getId().toString());
        detail.put("parentToolCallId", invocation.toolCallId());
        detail.put("parentInvocationId", invocation.id().toString());
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

    /**
     * PLAN-0655: the canonical spawn body for a human-authored delegation task. The same shape the
     * MCP surface produces, so approval reuse keys (sessionId + tool + canonical hash) behave the
     * same on both surfaces — one grant can approve either channel without a second mechanism.
     */
    public String delegationAuthorizationBody(String task) {
        return createSpawnAuthorizationBody(task);
    }

    /**
     * PLAN-0655: create the delegated child Session + its first Run (task as the user Message).
     * INV-8 ordering mirrors createSpawnFromParent: idempotency replay, then the budget gate, then
     * the one-shot approval consume, then the rows — so a replay never re-pays the budget and a
     * budget refusal never burns the approval.
     *
     * <p>Provenance is complete by construction: the terminal-settlement path rejects a spawn child
     * without {@code spawned_from_{session,run}_id} + a waiting link (ChatRunTerminalService.
     * lockParentLink), so the child carries the parent session's latest run as its provenance anchor
     * and the idempotency key as the waiting tool-call id. The waiting link is bookkeeping only — the
     * human route never waits on the parent run.</p>
     */
    @Transactional
    public SpawnResult createDelegation(String parentRunId, String agentPrincipalId, String task,
                                        String idempotencyKey, SpawnAuthorization authorization) {
        requireUuid(parentRunId, "parentRunId");
        requireUuid(agentPrincipalId, "agentPrincipalId");
        if (task == null || task.isBlank() || task.length() > 4000) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "task must be 1..4000 characters");
        }
        if (authorization == null || authorization.authorizationBody() == null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Delegation authorization is required");
        }

        LockedSpawnParent lockedParent = lockSpawnParent(parentRunId, null, null, null,
                () -> new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_PARENT_RUN_NOT_FOUND",
                        "Parent run or session not found"));
        ChatRun parentRun = lockedParent.run();
        Session parentSession = lockedParent.session();

        // Idempotency replay first: a retry of the SAME key must not re-pay the budget.
        ChatRun existing = chatRunRepository
                .findByUserIdAndIdempotencyKeyAndOrigin(parentRun.getUserId(), idempotencyKey,
                        ChatRun.ORIGIN_SPAWN)
                .orElse(null);
        if (existing != null) {
            Session existingSession = sessionRepository
                    .findByIdForUpdate(UUID.fromString(existing.getSessionId()))
                    .orElseThrow(() -> new IllegalStateException("Delegation session is missing"));
            return new SpawnResult(existingSession.getId().toString(), existing.getId().toString(),
                    existingSession.getAgentPrincipalId(), existingSession.getWorkspaceId());
        }

        // INV-8: budget BEFORE the approval consume (below), inside the parent Session+Run locks.
        DelegationRefusedException budget = null;
        try {
            delegationBudgetService.requireWithinBudget(parentSession, parentRun, idempotencyKey);
        } catch (DelegationRefusedException refused) {
            budget = refused;
        }
        if (budget != null) {
            throw budget;
        }

        if (authorization.approvalGrantId() != null
                && !approvalService.consumeApprovedGrant(authorization.approvalGrantId(),
                        parentRun.getUserId(), parentRun.getWorkspaceId(),
                        parentSession.getId().toString(), SPAWN_TOOL_NAME,
                        authorization.authorizationBody())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "APPROVAL_GRANT_INVALID",
                    "Delegation approval grant is invalid or no longer usable");
        }

        // Chosen principal: must be visible/bound in this workspace; resolveCapFor fails closed with
        // its own 404/409 code, which the contract maps verbatim.
        JsonNode childPermissions = agentPrincipalService.resolveCapFor(
                UUID.fromString(agentPrincipalId), UUID.fromString(parentRun.getWorkspaceId()));

        String requestHash = ChatRequestHash.calculate(objectMapper, task,
                parentRun.getProvider(), parentRun.getModel(), parentRun.getToolMode(),
                List.of(), Map.of());

        Session childSession = new Session(parentRun.getWorkspaceId(), parentRun.getUserId(),
                parentSession.getTitle());
        childSession.setId(UUID.randomUUID());
        childSession.setKind(Session.KIND_SPAWN);
        childSession.setSpawnedFromSessionId(parentSession.getId());
        childSession.setSpawnedFromRunId(parentRun.getId());
        childSession.setSpawnedAt(Instant.now());
        childSession.setAgentPrincipalId(agentPrincipalId);
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
        sessionParticipantService.ensurePrimaryParticipant(childSession.getId(), agentPrincipalId);

        String requestId = UUID.randomUUID().toString();
        String childRunId = UUID.randomUUID().toString();
        String childBranchId = branchPathService.ensureRootBranchId(childSession.getId().toString());
        Submission created = persist(ChatRun.ORIGIN_SPAWN, childRunId, childSession.getId().toString(),
                parentRun.getUserId(), parentRun.getWorkspaceId(), childBranchId, idempotencyKey,
                requestHash, parentRun.getProvider(), parentRun.getModel(), parentRun.getToolMode(),
                parentRun.getProviderConnectionId(), parentRun.getConnectionRevision(), null, requestId,
                task, "[]", List.of(), agentPrincipalId, false, Message.VISIBILITY_USER);
        ChatRun childRun = created.run();
        childRun.setWaitingOnRunId(parentRun.getId().toString());
        // The waiting tool-call column is a 36-char uuid string, and settlement only compares it for
        // equality with the anchor — derive a stable uuid from the idempotency key instead of storing
        // the (longer) key itself. Stable: a replay recomputes the same value.
        childRun.setWaitingToolCallId(
                java.util.UUID.nameUUIDFromBytes(idempotencyKey.getBytes(java.nio.charset.StandardCharsets.UTF_8))
                        .toString());
        chatRunRepository.save(childRun);

        com.fasterxml.jackson.databind.node.ObjectNode detail = objectMapper.createObjectNode();
        detail.put("authorizationAction", "SPAWN_AGENT");
        detail.put("parentSessionId", parentSession.getId().toString());
        detail.put("parentRunId", parentRun.getId().toString());
        detail.put("childSessionId", childSession.getId().toString());
        detail.put("childRunId", childRun.getId().toString());
        detail.put("agentPrincipalId", agentPrincipalId);
        if (authorization.approvalGrantId() != null) {
            detail.put("approvalRequestId", authorization.approvalGrantId());
        }
        auditLogger.recordDurableChange(parentRun.getUserId(), parentRun.getWorkspaceId(),
                "agent_delegation_created", "chat_session", childSession.getId().toString(), detail.toString());

        return new SpawnResult(childSession.getId().toString(), childRun.getId().toString(),
                agentPrincipalId, parentRun.getWorkspaceId());
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
            if (args == null || !args.isObject()) {
                throw invalidSpawnArguments();
            }
            JsonNode prompt = args.get("prompt");
            boolean envelope = false;
            if (prompt == null && args.has("params")) {
                // BL-220 read-side tolerance: 旧行可能是整条 JSON-RPC 信封 —— CP MCP 代理侧
                // （McpProxyController 的 gate 写入）曾把 raw body 写进 preview，与 Agent 事件侧
                // 的纯参数双形状并存，导致本方法只认纯参数、预算闸永远到不了（0649 真栈实证）。
                // 写侧已统一为纯参数；这里再容忍一层，防第三方路径再写信封。信封必须真是
                // tools/call 且 params.arguments 是对象，method 不符即拒绝。
                JsonNode params = args.get("params");
                if (params != null && params.isObject()
                        && "tools/call".equals(args.path("method").asText(""))) {
                    JsonNode envelopeArguments = params.get("arguments");
                    if (envelopeArguments != null && envelopeArguments.isObject()) {
                        prompt = envelopeArguments.get("prompt");
                        envelope = prompt != null;
                    }
                }
            }
            // 纯参数形态保持原有严格度：必须恰好像 {"prompt": "..."} 一个键。
            if (prompt == null || !prompt.isTextual() || prompt.textValue().isBlank()
                    || (!envelope && args.size() != 1)) {
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
     * PLAN-0470 (decision #16): the read goes through the MCP owner service —
     * a bounded provenance view, never the invocation repository/entity.
     */
    private McpInvocationService.SpawnInvocationView requireSpawnInvocation(String parentRunId, String toolCallId) {
        return mcpInvocationService
                .findSpawnInvocation(parentRunId, toolCallId)
                .orElseGet(() -> rejectUnmatchedSpawnInvocation(toolCallId));
    }

    private McpInvocationService.SpawnInvocationView rejectUnmatchedSpawnInvocation(String toolCallId) {
        if (mcpInvocationService.existsAgentInvocation(toolCallId)) {
            throw agentSpawnForbidden("Durable invocation belongs to a different parent run");
        }
        throw new CpApiException(HttpStatus.NOT_FOUND, "SPAWN_EVENT_NOT_FOUND", "Spawn item not found");
    }

    /** PLAN-0464 T2.1: invocation-side equivalent of the retired item check. */
    private void validateSpawnInvocation(String parentRunId, McpInvocationService.SpawnInvocationView invocation) {
        if (!parentRunId.equals(invocation.runId())
                || !McpInvocation.SOURCE_AGENT.equals(invocation.source())
                || !SPAWN_TOOL_NAME.equals(invocation.toolName())) {
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
        return new CpApiException(HttpStatus.BAD_REQUEST, ToolRefusalCodes.SPAWN_ARGUMENTS_INVALID,
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
                                boolean followUpAdmission, String messageVisibility) {
        Session session = bindOrValidateAgentSession(sessionId, userId, workspaceId, requestedPrincipalId);
        var requestSnapshot = apiRequestTemplates.admissionSnapshot(session);
        provider = session.getModelProvider();
        model = session.getModelName();
        providerConnectionId = session.getProviderConnectionId();
        connectionRevision = session.getConnectionRevision();
        if (session.getDeleteRequestedAt() != null) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_DELETING",
                    "Session deletion is in progress");
        }
        if (!followUpAdmission && followUpItemRepository.countBySessionIdAndStatusIn(
                sessionId, SessionFollowUpItemRepository.OUTSTANDING_STATUSES) > 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "FOLLOW_UP_QUEUE_NOT_EMPTY",
                    "Follow-up queue must be drained before sending a normal Chat message");
        }
        rejectConcurrentSubmission(sessionId, userId, idempotencyKey);
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
        chatRun.setContextTemplateSnapshot(requestSnapshot);
        // PLAN-0628 M2a (D28-35/D28-39): the skills listing is frozen in the SAME transaction as
        // the template snapshot, so "which template" and "which capability set" belong to one
        // admission. The listing is scoped to the Session's bound Agent principal (the AGENT tier
        // of D28-14) — the same identity this Run's instructions are resolved from at dispatch.
        // A capture failure is recorded inside the document and never blocks the Run.
        chatRun.setSkillsSnapshot(freezeSkillsListing(requestSnapshot, session, userId, workspaceId));
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
        // PLAN-0630 M5b / D3: the wake instruction is model input, not a user-facing turn.
        userMessage.setVisibility(messageVisibility == null ? Message.VISIBILITY_USER : messageVisibility);
        userMessage.setRunId(runId);
        userMessage.setBranchId(branchId);
        userMessage.setAttachments(attachmentsJson);
        messageRepository.save(userMessage);
        chatRun.setUserMessageId(userMessage.getId().toString());
        chatRunRepository.save(chatRun);

        // PLAN-0470 (decision #23): Files owns the attachment->Message link;
        // same transaction, no physical deletion, no wire change.
        chatAttachmentService.linkToMessage(attachmentIds, userMessage.getId().toString());

        int claimedNotices = inboxRepository.claimPendingForRun(UUID.fromString(sessionId), UUID.fromString(runId));
        if (claimedNotices > 0) {
            logger.info("[LIFECYCLE] service=cp event=derived_inbox_claimed sessionId={} runId={} count={}",
                    sessionId, runId, claimedNotices);
        }
        return new Submission(chatRun, userMessage);
    }

    /**
     * PLAN-0628 M2a: the frozen listing document, or {@code null} when this template carries no
     * enabled listing component (the column then keeps its {@code {}} "not captured" default).
     */
    private com.fasterxml.jackson.databind.JsonNode freezeSkillsListing(
            com.fasterxml.jackson.databind.JsonNode requestSnapshot, Session session,
            String userId, String workspaceId) {
        return skillCatalogSnapshots.capture(requestSnapshot,
                optionalUuid(session.getAgentPrincipalId()), optionalUuid(userId),
                optionalUuid(workspaceId));
    }

    /**
     * A malformed identifier leaves the corresponding listing tier out instead of failing the Run:
     * this is a recording step, and admission has already validated the identifiers it cares about.
     */
    private static UUID optionalUuid(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException notAnId) {
            return null;
        }
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
     * 锁内准入判定（Session 行锁已由 {@link #bindOrValidateAgentSession} 持有）：
     * 在插入 ChatRun 之前复查幂等键与在途 run 计数。幂等键命中时按 CHAT_IN_PROGRESS
     * 拒绝，让重试方下一次在 controller 层拿到 replay，而不是撞唯一约束 500。
     *
     * <p>PLAN-0645 D45-01：原来的"每会话最多一条非终态 run"（单飞）改成
     * "非终态 run 计数 &lt; cap"（{@link SessionRunConcurrencyGate}）。判定仍在
     * Session 行锁内，因此跨请求/跨实例原子，且不需要 DB 约束（SQL 唯一索引无法表达
     * "≤N"）。{@code cap=1} 逐项复现冻结的单飞行为，即回滚开关。</p>
     *
     * <p>PLAN-0442 的"上一 run 仍在释放租约"检查已删除：它补偿的是 cap=1 下
     * "终态→releaseLease"的毫秒窗口；cap≥2 后它只会把并发重新堵回单飞。</p>
     */
    private void rejectConcurrentSubmission(String sessionId, String userId, String idempotencyKey) {
        if (idempotencyKey != null && chatRunRepository
                .findByUserIdAndSessionIdAndIdempotencyKey(userId, sessionId, idempotencyKey).isPresent()) {
            throw new CpApiException(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS",
                    "Idempotency-Key already has a run for this session");
        }
        runConcurrencyGate.requireSlot(sessionId);
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
                    || mcpInvocationService.hasInvocationForSession(sessionId)
                    || eventStoreService.hasEventsForSession(sessionId)) {
                throw new CpApiException(HttpStatus.CONFLICT, "SESSION_PRINCIPAL_BINDING_CONFLICT",
                        "Only an empty, unbound Session can be assigned an Agent principal");
            }
            com.fasterxml.jackson.databind.JsonNode cap = agentPrincipalService.resolveCapFor(
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
            // D23-13: binding the principal of a principal-null placeholder also creates its PRIMARY —
            // otherwise the placeholder would keep a conversation without a main participant forever.
            sessionParticipantService.ensurePrimaryParticipant(sessionUuid, requestedPrincipalId);
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

        try {
            agentPrincipalService.requireActiveWorkspaceBinding(path.principalId().toString(), workspaceId);
        } catch (CpApiException e) {
            // PLAN-0622 V15 (Lead ruling): a disabled principal is a state conflict (409), not a
            // permission problem. Masking it as 403 would tell the caller to ask for access it
            // already has.
            if ("AGENT_PRINCIPAL_DISABLED".equals(e.getCode())) {
                throw e;
            }
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

    public record SubmissionReplay(String status, String origin, String sessionId, UUID runId,
                                   String providerConnectionId, Long connectionRevision,
                                   String messageId, String terminalOutcome, String errorCode) {}

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
