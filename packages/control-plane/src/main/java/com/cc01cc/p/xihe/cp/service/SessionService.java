package com.cc01cc.p.xihe.cp.service;

import jakarta.persistence.EntityManager;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionForkRequest;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.chat.SessionProviderDefaults;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.SessionPolicyState;
import com.cc01cc.p.xihe.cp.provider.ProviderConnectionService;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.SessionForkRequestRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
public class SessionService {

    private static final Logger logger = LoggerFactory.getLogger(SessionService.class);

    /**
     * D-1236 (task-390): the only accepted value of the optional {@code scope} query parameter on
     * {@code GET /api/v1/sessions}. It selects the workspace-less ("独立会话") read face; any other
     * value is rejected by the controller with 400 INVALID_SCOPE.
     */
    public static final String SCOPE_WORKSPACELESS = "workspaceless";

    @org.springframework.beans.factory.annotation.Autowired
    private ApiRequestTemplateService apiRequestTemplates;

    @org.springframework.beans.factory.annotation.Autowired
    private SessionProviderDefaults sessionProviderDefaults;

    private final SessionRepository sessionRepository;
    private final SessionParticipantService sessionParticipantService;
    /** PLAN-0668 D1: single visibility primitive shared with the roster guard. */
    private final SessionReadAccess sessionReadAccess;
    private final SessionForkRequestRepository forkRequestRepository;
    private final SessionBranchRepository sessionBranchRepository;
    private final MessageRepository messageRepository;
    private final WorkspaceService workspaceService;
    private final WorkspaceBackendPolicy backendPolicy;
    private final ChatAttachmentService chatAttachmentService;
    private final ProviderConnectionService providerConnectionService;
    private final SessionPolicyState sessionPolicyState;
    private final DbLockTimeout dbLockTimeout;
    private final AgentPrincipalService agentPrincipalService;
    private final EntityManager entityManager;
    // PLAN-0470 (decision #15): cross-domain Session cleanup goes through the
    // Context/MCP/Policy owner services inside this delete transaction — the
    // Session coordinator never injects their repositories.
    private final ContextService contextService;
    private final McpInvocationService mcpInvocationService;
    private final GrantDefaultService grantDefaultService;

    public SessionService(SessionRepository sessionRepository,
                          SessionForkRequestRepository forkRequestRepository,
                          SessionBranchRepository sessionBranchRepository,
                          MessageRepository messageRepository,
                          WorkspaceService workspaceService,
                          ChatAttachmentService chatAttachmentService,
                          ProviderConnectionService providerConnectionService,
                          SessionPolicyState sessionPolicyState,
                          DbLockTimeout dbLockTimeout,
                          AgentPrincipalService agentPrincipalService,
                          EntityManager entityManager,
                          ContextService contextService,
                          McpInvocationService mcpInvocationService,
                          GrantDefaultService grantDefaultService,
                          WorkspaceBackendPolicy backendPolicy,
            SessionParticipantService sessionParticipantService,
            SessionReadAccess sessionReadAccess) {
        this.sessionRepository = sessionRepository;
        this.forkRequestRepository = forkRequestRepository;
        this.sessionBranchRepository = sessionBranchRepository;
        this.messageRepository = messageRepository;
        this.workspaceService = workspaceService;
        this.backendPolicy = backendPolicy;
        this.chatAttachmentService = chatAttachmentService;
        this.providerConnectionService = providerConnectionService;
        this.sessionPolicyState = sessionPolicyState;
        this.dbLockTimeout = dbLockTimeout;
        this.agentPrincipalService = agentPrincipalService;
        this.entityManager = entityManager;
        this.contextService = contextService;
        this.mcpInvocationService = mcpInvocationService;
        this.grantDefaultService = grantDefaultService;
        this.sessionParticipantService = sessionParticipantService;
        this.sessionReadAccess = sessionReadAccess;
    }

    @Transactional(readOnly = true)
    public List<Session> list(String userId, String workspaceId) {
        requireWorkspace(userId, workspaceId);
        return sessionRepository.findByWorkspaceIdAndUserIdAndArchivedFalseOrderByCreatedAtDesc(
                workspaceId, userId);
    }

    /**
     * PLAN-0668 D1/D5 read-face list: owner ∨ invited enabled HUMAN participant. Managers stay out
     * (D1b), and this deliberately does not replace the owner-only {@link #list} used by nothing
     * else after the controller switch (kept for call-site stability in tests/clients).
     */
    @Transactional(readOnly = true)
    public List<Session> listReadable(String userId, String workspaceId) {
        return listReadable(userId, workspaceId, null);
    }

    /**
     * D-1236 (task-390): {@code scope=workspaceless} switches to the user-level workspace-less read
     * face, which needs no workspace context. The workspace hard gate stays on the no-scope path, so
     * the behaviour without the parameter is unchanged. Unknown scope values never reach here (the
     * controller answers 400 INVALID_SCOPE first).
     */
    @Transactional(readOnly = true)
    public List<Session> listReadable(String userId, String workspaceId, String scope) {
        if (SCOPE_WORKSPACELESS.equals(scope)) {
            return listReadableWorkspaceless(userId);
        }
        requireWorkspace(userId, workspaceId);
        UUID actorId;
        try {
            actorId = UUID.fromString(userId);
        } catch (IllegalArgumentException malformedActor) {
            return List.of();
        }
        return sessionRepository.findReadableByWorkspaceIdAndActor(workspaceId, userId, actorId);
    }

    /**
     * D-1236: workspace-less sessions readable by the caller. No workspace gate — these rows have
     * {@code workspace_id IS NULL} by definition (V145), so requiring a workspace would make the
     * read face unreachable for exactly the sessions it exists to list.
     */
    private List<Session> listReadableWorkspaceless(String userId) {
        if (userId == null || userId.isBlank()) {
            throw CpApiException.workspaceContextRequired();
        }
        UUID actorId;
        try {
            actorId = UUID.fromString(userId);
        } catch (IllegalArgumentException malformedActor) {
            return List.of();
        }
        return sessionRepository.findReadableWorkspacelessByActor(userId, actorId);
    }

    @Transactional
    public Session create(String userId, String workspaceId, String title,
                          String modelProvider, String modelName) {
        return create(userId, workspaceId, title, modelProvider, modelName, null);
    }

    @Transactional
    public Session create(String userId, String workspaceId, String title,
                          String modelProvider, String modelName,
                          String providerConnectionId) {
        requireWorkspace(userId, workspaceId);
        return createWithId(UUID.randomUUID().toString(), userId, workspaceId,
                title, modelProvider, modelName, providerConnectionId);
    }

    /**
     * PLAN-0647 D-47-05: resolve a Session by ROW ownership (id + user_id, archived excluded).
     * The caller decides what the row's workspace means; this method never reads TenantContext.
     */
    @Transactional(readOnly = true)
    public Session requireOwnedSession(String sessionId, String userId) {
        UUID id;
        try {
            id = UUID.fromString(sessionId);
        } catch (RuntimeException malformed) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
        Session session = sessionRepository.findById(id)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND",
                        "Session not found"));
        if (userId == null || !userId.equals(session.getUserId()) || session.isArchived()) {
            // No existence oracle for non-owners: the same 404 as a missing row.
            throw new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
        return session;
    }

    /**
     * PLAN-0647 MVP (D-678/D-47-05): resolve a Session that lives outside any workspace.
     *
     * <p>A workspace Session answers 400 WORKSPACE_CONTEXT_REQUIRED instead of being adopted by
     * the interceptor's ThreadLocal fallback.</p>
     */
    @Transactional(readOnly = true)
    public Session requireOwnedWorkspaceLess(String sessionId, String userId) {
        Session session = requireOwnedSession(sessionId, userId);
        if (session.getWorkspaceId() != null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "WORKSPACE_CONTEXT_REQUIRED",
                    "This Session belongs to a workspace; send X-Workspace-Id");
        }
        return session;
    }

    @Transactional
    public Session createAgentSession(String userId, String workspaceId, String title,
                                      String modelProvider, String modelName,
                                      String providerConnectionId, String agentPrincipalId) {
        return createAgentSession(userId, workspaceId, title, modelProvider, modelName,
                providerConnectionId, agentPrincipalId, null);
    }

    @Transactional
    public Session createAgentSession(String userId, String workspaceId, String title,
                                      String modelProvider, String modelName,
                                      String providerConnectionId, String agentPrincipalId,
                                      ContextTemplateService.TemplateSelection templateSelection) {
        // PLAN-0647 D-678: a workspace-less session has no workspace binding to check. The workspace
        // branch below stays byte-identical for every existing caller.
        if (workspaceId != null) {
            requireWorkspace(userId, workspaceId);
        }
        if (agentPrincipalId == null || agentPrincipalId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "agentPrincipalId is required");
        }
        // D-686 (workspaceless): the snapshot is null and explicitly not applicable — no owner cap is
        // fabricated, because "no workspace" must not look like "workspace with zero permissions".
        // Every authorization reader turns null into a fail-closed refusal (GrantIntersectionEvaluator
        // throws -> GrantAuthorizationService catches -> false). A NULL never means "unrestricted".
        com.fasterxml.jackson.databind.JsonNode cap = workspaceId == null
                ? null
                : agentPrincipalService.resolveCapFor(agentPrincipalId, workspaceId);
        Session session = new Session(workspaceId, userId, normalizeTitle(title));
        session.setId(UUID.randomUUID());
        // PLAN-0689 A7/D-54: retained snapshot = the PRIMARY's cap at binding time; resolveCapFor
        // above carries the D-49 active-binding gate (fail-closed).
        session.setAgentPermissionsSnapshot(cap);
        // 2026-11-04 P0（task-24）：显式传值优先；只有三件套全空时才按权威顺序补默认
        // （agent 主体默认 → 生效 llm-provider profile）。补不到 ⇒ 400 PROVIDER_REQUIRED，
        // 裸会话从此是不允许落地的状态。
        if (isBlank(providerConnectionId) && isBlank(modelProvider) && isBlank(modelName)) {
            SessionProviderDefaults.Defaults defaults =
                    sessionProviderDefaults.resolve(userId, workspaceId, agentPrincipalId);
            modelProvider = defaults.modelProvider();
            modelName = defaults.modelName();
            providerConnectionId = defaults.providerConnectionId();
            logger.info("[LIFECYCLE] service=cp event=session_provider_defaults_applied "
                    + "agentPrincipalId={} source={} provider={} model={}",
                    agentPrincipalId, defaults.source(), modelProvider, modelName);
        }
        session.setModelProvider(modelProvider);
        session.setModelName(modelName);
        bindProviderConnection(session, userId, workspaceId, providerConnectionId, modelProvider);
        bindApiTemplate(session, templateSelection);
        Session saved = sessionRepository.save(session);
        // D23-13: the PRIMARY is part of creating a Session, not of the first message — same transaction.
        sessionParticipantService.ensurePrimaryParticipant(saved.getId(), agentPrincipalId);
        return saved;
    }

    /**
     * 2026-11-04 P0（task-24）：老数据补救——把已存在的"裸会话"按默认绑定重绑。
     *
     * <p>幂等：已完整绑定 ⇒ 原样返回；只有连接、缺模板 ⇒ 只补模板快照；完全裸 ⇒ 按
     * {@link com.cc01cc.p.xihe.cp.chat.SessionProviderDefaults} 补齐 connection/model/template。</p>
     *
     * <p>刻意<b>不</b>放宽 {@code admissionSnapshot} 的 gate，也不改
     * {@code ChatSubmissionService} 用 session 行覆盖 body 的语义 —— 老会话必须被真正写回绑定，
     * 而不是让投递路径替它猜。</p>
     */
    @Transactional
    public Session rebindDefaultBinding(String sessionId, String userId, String workspaceId) {
        Session session = requireCurrent(sessionId, userId, workspaceId);
        boolean hasConnection = !isBlank(session.getProviderConnectionId());
        boolean hasTemplate = session.getContextTemplateLayer() != null
                && session.getContextTemplateId() != null
                && session.getContextTemplateVersion() != null;
        if (hasConnection && hasTemplate) {
            return session;
        }
        if (hasConnection) {
            bindApiTemplate(session, null);
            return sessionRepository.save(session);
        }
        // PLAN-0689 A6 (R4 / design §3-B): the provider default is keyed by the conversation's default
        // responder, which is the PRIMARY participant — the Session column is a copy that A7 drops.
        // No PRIMARY (legacy/placeholder) keeps the previous NULL input: null means "no agent default",
        // so the chain falls through to the effective llm-provider profile and then fails closed with
        // PROVIDER_REQUIRED. It is not a fallback to another principal.
        UUID primaryPrincipalId = sessionParticipantService.responderPrincipalIdFor(session.getId(), null);
        SessionProviderDefaults.Defaults defaults = sessionProviderDefaults.resolve(userId, workspaceId,
                primaryPrincipalId == null ? null : primaryPrincipalId.toString());
        session.setModelProvider(defaults.modelProvider());
        session.setModelName(defaults.modelName());
        bindProviderConnection(session, userId, workspaceId, defaults.providerConnectionId(),
                defaults.modelProvider());
        bindApiTemplate(session, null);
        logger.info("[LIFECYCLE] service=cp event=session_provider_rebound sessionId={} source={}",
                sessionId, defaults.source());
        return sessionRepository.save(session);
    }

    @Transactional
    public Session createForkSession(String sourceSessionId, UUID childSessionId, String anchorRunId,
                                     String userId, String workspaceId) {
        Session source = requireCurrent(sourceSessionId, userId, workspaceId);
        // PLAN-0689 A6 (R4 / design §3-B): the fork inherits the source conversation's default
        // responder — its PRIMARY participant — not the Session column (A7 drops it). Missing PRIMARY
        // keeps the same fail-closed 409 below; a HUMAN primary is refused later by resolveCapFor.
        UUID sourcePrimaryPrincipalId = sessionParticipantService.responderPrincipalIdFor(source.getId(), null);
        String agentPrincipalId = sourcePrimaryPrincipalId == null ? null : sourcePrimaryPrincipalId.toString();
        if (agentPrincipalId == null || agentPrincipalId.isBlank()) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_PRINCIPAL_REQUIRED",
                    "A fork requires a stable AgentPrincipal on the source Session");
        }

        com.fasterxml.jackson.databind.JsonNode currentCap = agentPrincipalService.resolveCapFor(
                agentPrincipalId, workspaceId);
        Session child = new Session(workspaceId, userId, normalizeTitle("Fork of " + source.getTitle()));
        child.setId(childSessionId);
        // PLAN-0689 A7/D-54: same retained snapshot semantics as create; resolveCapFor above carries
        // the D-49 active-binding gate (fail-closed).
        child.setAgentPermissionsSnapshot(currentCap);
        child.setModelProvider(source.getModelProvider());
        child.setModelName(source.getModelName());
        child.setApprovalMode(source.getApprovalMode());
        child.setContextTemplateLayer(source.getContextTemplateLayer());
        child.setContextTemplateId(source.getContextTemplateId());
        child.setContextTemplateVersion(source.getContextTemplateVersion());
        child.setKind(Session.KIND_FORK);
        child.setSpawnedFromSessionId(source.getId());
        child.setSpawnedFromRunId(UUID.fromString(anchorRunId));
        child.setSpawnedAt(Instant.now());
        bindProviderConnection(child, userId, workspaceId,
                source.getProviderConnectionId(), source.getModelProvider());
        Session savedChild = sessionRepository.saveAndFlush(child);
        // D23-13: a fork is a new conversation too — it gets its own PRIMARY.
        sessionParticipantService.ensurePrimaryParticipant(savedChild.getId(), agentPrincipalId);
        return savedChild;
    }

    @Transactional
    public Session createWithId(String sessionId, String userId, String workspaceId, String title,
                                String modelProvider, String modelName) {
        return createWithId(sessionId, userId, workspaceId, title, modelProvider, modelName, null);
    }

    @Transactional
    public Session createWithId(String sessionId, String userId, String workspaceId, String title,
                                String modelProvider, String modelName,
                                String providerConnectionId) {
        requireWorkspace(userId, workspaceId);
        if (sessionId == null || sessionId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sessionId is required");
        }
        if (sessionRepository.findById(UUID.fromString(sessionId)).isPresent()) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_ALREADY_EXISTS", "Session already exists");
        }
        Session session = new Session(workspaceId, userId, normalizeTitle(title));
        session.setId(UUID.fromString(sessionId));
        session.setModelProvider(modelProvider);
        session.setModelName(modelName);
        bindProviderConnection(session, userId, workspaceId, providerConnectionId, modelProvider);
        bindApiTemplate(session, null);
        return sessionRepository.save(session);
    }

    @Transactional(readOnly = true)
    public Session requireCurrent(String sessionId, String userId, String workspaceId) {
        // PLAN-0668 D1: owner-only semantics preserved verbatim; the primitive lives in
        // SessionReadAccess so the read/roster guards cannot drift from it again.
        return sessionReadAccess.requireOwned(userId, workspaceId, sessionId);
    }

    /**
     * PLAN-0668 D1/D1b read face: owner or invited enabled HUMAN participant. Managers are
     * deliberately excluded (they keep the existing roster read only); 404 otherwise.
     */
    @Transactional(readOnly = true)
    public Session requireReadable(String sessionId, String userId, String workspaceId) {
        return sessionReadAccess.requireReadable(userId, workspaceId, sessionId);
    }

    @Transactional(readOnly = true)
    public Optional<String> findMcpSessionOwner(UUID sessionId, String workspaceId, String userId) {
        return sessionRepository.findById(sessionId)
                .filter(session -> !session.isArchived()
                        && workspaceId.equals(session.getWorkspaceId())
                        && (userId == null || userId.equals(session.getUserId())))
                .map(Session::getUserId);
    }

    @Transactional
    public Session lockCurrentForMutation(String sessionId, String userId, String workspaceId) {
        Session lockedSession = lockForDelete(sessionId, userId, workspaceId);
        if (lockedSession.getDeleteRequestedAt() != null) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_DELETING",
                    "Session is being deleted");
        }
        return lockedSession;
    }

    /**
     * PLAN-0409 design #22: record the durable delete intent inside the same
     * short lock as the copying precheck. Commits before any cancellation /
     * job-close side effect runs lock-free, so a later fork claim is rejected
     * with SESSION_DELETING instead of racing the final delete transaction.
     * Re-entrant: a retry of Session DELETE resumes from here. No undo path.
     */
    @Transactional
    public Session beginDeleteIntent(String sessionId, String userId, String workspaceId) {
        Session lockedSession = lockForDelete(sessionId, userId, workspaceId);
        if (lockedSession.getDeleteRequestedAt() == null) {
            lockedSession.setDeleteRequestedAt(Instant.now());
            sessionRepository.saveAndFlush(lockedSession);
        }
        return lockedSession;
    }

    private Session lockForDelete(String sessionId, String userId, String workspaceId) {
        requireWorkspace(userId, workspaceId);
        UUID sessionUuid = UUID.fromString(sessionId);
        dbLockTimeout.apply();
        Session lockedSession = sessionRepository.findByIdForUpdate(sessionUuid)
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
        entityManager.refresh(lockedSession);
        if (lockedSession.isArchived()
                || !userId.equals(lockedSession.getUserId())
                || !workspaceId.equals(lockedSession.getWorkspaceId())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
        if (forkRequestRepository.existsBySourceSessionIdAndState(
                lockedSession.getId(), SessionForkRequest.COPYING)) {
            throw new CpApiException(HttpStatus.CONFLICT, "FORK_REQUEST_IN_PROGRESS",
                    "Session cannot be mutated while a fork snapshot is copying");
        }
        return lockedSession;
    }

    @Transactional
    public Session update(String sessionId, String userId, String workspaceId,
                          String title, String modelProvider, String modelName) {
        return update(sessionId, userId, workspaceId, title, modelProvider, modelName, null);
    }

    @Transactional
    public Session update(String sessionId, String userId, String workspaceId,
                          String title, String modelProvider, String modelName,
                          String providerConnectionId) {
        Session session = lockCurrentForMutation(sessionId, userId, workspaceId);
        if (title != null) {
            if (title.isBlank()) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "title must not be blank");
            }
            session.setTitle(title.trim());
        }
        if (modelProvider != null) {
            session.setModelProvider(modelProvider.isBlank() ? null : modelProvider.trim());
        }
        if (modelName != null) {
            session.setModelName(modelName.isBlank() ? null : modelName.trim());
        }
        if (providerConnectionId != null) {
            bindProviderConnection(session, userId, workspaceId, providerConnectionId, modelProvider);
        }
        if (modelProvider != null || modelName != null || providerConnectionId != null) {
            bindApiTemplate(session, null);
        }
        return sessionRepository.save(session);
    }

    @Transactional
    public Session updateBinding(String sessionId, String userId, String workspaceId, String title,
                                 String provider, String model, String connectionId, Long revision,
                                 ContextTemplateService.TemplateSelection selection, boolean confirmed) {
        Session session = lockCurrentForMutation(sessionId, userId, workspaceId);
        if (title != null) {
            if (title.isBlank()) {
                throw ApiRequestTemplateService.invalid("title must not be blank");
            }
            session.setTitle(title.trim());
        }
        boolean binding = provider != null || model != null || connectionId != null || revision != null || selection != null;
        if (binding) {
            if (provider == null || model == null || model.isBlank() || connectionId == null || revision == null) {
                throw ApiRequestTemplateService.invalid("Complete model/Connection/revision bundle is required");
            }
            ProviderConnection target = apiRequestTemplates.lockConnection(connectionId);
            apiRequestTemplates.requireVisible(target, userId, workspaceId);
            apiRequestTemplates.requireChat(target);
            if (target.getRevision() != revision) {
                throw ApiRequestTemplateService.conflict("STALE_PROVIDER_CONNECTION", "Connection revision changed");
            }
            if (session.getProviderConnectionId() != null && session.getContextTemplateId() != null) {
                var previous = apiRequestTemplates.pinnedTemplate(session);
                boolean different = previous != null && (!previous.path("apiTypeId").asText().equals(target.getApiTypeId())
                        || previous.path("apiTypeVersion").asInt() != target.getApiTypeVersion());
                if (different && (!confirmed || selection == null)) {
                    throw ApiRequestTemplateService.invalid("Different API Type requires confirmation and target template");
                }
            }
            session.setModelProvider(provider);
            session.setModelName(model);
            bindProviderConnection(session, userId, workspaceId, connectionId, provider);
            bindApiTemplate(session, selection);
        }
        return sessionRepository.save(session);
    }

    @Transactional
    public Session updateApiTemplate(String sessionId, String userId, String workspaceId,
                                     String layer, String templateId, int version, Long revision) {
        Session session = lockCurrentForMutation(sessionId, userId, workspaceId);
        if (revision == null) {
            throw ApiRequestTemplateService.invalid("connectionRevision is required");
        }
        return updateBinding(sessionId, userId, workspaceId, null, session.getModelProvider(), session.getModelName(),
                session.getProviderConnectionId(), revision,
                new ContextTemplateService.TemplateSelection(layer, templateId, version), true);
    }

    private void bindApiTemplate(Session session, ContextTemplateService.TemplateSelection selection) {
        if (session.getProviderConnectionId() == null) {
            if (selection != null) {
                throw ApiRequestTemplateService.invalid("Select a Connection before a template");
            }
            return;
        }
        ProviderConnection connection = providerConnectionService.requireUsableForOwner(session.getProviderConnectionId(),
                session.getUserId(), session.getWorkspaceId());
        apiRequestTemplates.requireChat(connection);
        apiRequestTemplates.requireModel(connection, session.getModelName());
        com.fasterxml.jackson.databind.JsonNode ref = selection == null ? null :
                new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode().put("layer", selection.layer())
                        .put("templateId", selection.templateId()).put("version", selection.version());
        // PLAN-0647 D-678: a workspace-less session resolves the template chain user -> instance
        // (the workspace layer is skipped by the resolver when the id is null).
        var snapshot = apiRequestTemplates.resolve(connection, session.getModelName(), UUID.fromString(session.getUserId()),
                session.getWorkspaceId() == null ? null : UUID.fromString(session.getWorkspaceId()), ref);
        session.setContextTemplateLayer(snapshot.path("layer").asText());
        session.setContextTemplateId(UUID.fromString(snapshot.path("templateId").asText()));
        session.setContextTemplateVersion(snapshot.path("version").asInt());
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private void bindProviderConnection(
            Session session,
            String userId,
            String workspaceId,
            String providerConnectionId,
            String requestedProvider) {
        if (providerConnectionId == null || providerConnectionId.isBlank()) {
            if (requestedProvider == null && session.getModelName() == null) {
                return;
            }
            var candidates = apiRequestTemplates.effectiveConnections(userId, workspaceId, requestedProvider);
            if (candidates.isEmpty()) {
                // 2026-11-04 P0（task-24）：默认补齐解析不到可用连接 ⇒ 400 且原因可读。
                throw new CpApiException(HttpStatus.BAD_REQUEST, "PROVIDER_REQUIRED",
                        "No usable chat connection for provider '" + requestedProvider
                                + "'; configure a ready provider connection first");
            }
            if (candidates.size() > 1) {
                String available = candidates.stream()
                        .map(connection -> connection.getProviderId() + "/" + connection.getConnectionKey())
                        .limit(5)
                        .reduce((left, right) -> left + ", " + right)
                        .orElse("");
                throw new CpApiException(HttpStatus.BAD_REQUEST, "PROVIDER_CONNECTION_AMBIGUOUS",
                        "Multiple usable chat connections (" + candidates.size()
                                + "); pass providerConnectionId explicitly. Candidates: " + available);
            }
            providerConnectionId = candidates.getFirst().getId().toString();
        }
        try {
            // PLAN-0505 I6/V10: take the same connection row lock as the delete
            // path so a concurrent connection delete cannot slip a dangling
            // session binding between its check and its delete.
            apiRequestTemplates.lockConnection(providerConnectionId);
            ProviderConnection connection = providerConnectionService.requireUsableForOwner(
                    providerConnectionId, userId, workspaceId);
            if (requestedProvider != null && !requestedProvider.isBlank()
                    && !connection.getProviderId().equals(requestedProvider.trim())) {
                throw new IllegalArgumentException("Provider connection does not match model provider");
            }
            if (!java.util.Objects.equals(session.getWorkspaceId(), workspaceId)
                    || !session.getUserId().equals(userId)) {
                throw new IllegalArgumentException("Session ownership mismatch");
            }
            session.setProviderConnectionId(connection.getId().toString());
            session.setConnectionRevision(connection.getRevision());
            if (session.getModelProvider() == null || session.getModelProvider().isBlank()) {
                session.setModelProvider(connection.getProviderId());
            }
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PROVIDER_CONNECTION_UNAVAILABLE", e.getMessage());
        }
    }

    @Transactional
    public void delete(String sessionId, String userId, String workspaceId) {
        // lockForDelete, not lockCurrentForMutation: the delete-intent marker set by
        // beginDeleteIntent is expected here (retry path) and must not self-reject.
        Session lockedSession = lockForDelete(sessionId, userId, workspaceId);

        // Branch rows first: child branches hold ON DELETE RESTRICT anchor FKs to
        // messages/chat_runs (V43), so message-first deletion 500s on any session
        // that owns a non-root branch (browser journey 2026-09-30 regression).
        // The bulk delete cascades branch-owned messages/runs/events/projections.
        sessionBranchRepository.deleteAllBySessionId(sessionId);

        // Delete metadata and context rows explicitly so this remains correct on old live schemas.
        chatAttachmentService.deleteSessionAttachments(sessionId);
        // Fork Message rows retain parent Run IDs only as nullable lineage; do not leave them dangling.
        messageRepository.clearRunReferencesToSession(sessionId);
        messageRepository.deleteBySessionId(sessionId);
        // PLAN-0470 (decision #15): Context/MCP/Policy rows are removed by their
        // owner services inside this same transaction — same order as before
        // (projections → events → MCP history → attempts → invocations → grants).
        contextService.deleteSessionData(sessionId);
        mcpInvocationService.deleteSessionHistories(sessionId);
        grantDefaultService.deleteSessionAgentGrants(lockedSession.getId());
        sessionRepository.delete(lockedSession);
        // T1.7: session mode, L4 rules and reuse fingerprints must not outlive the session.
        sessionPolicyState.clear(sessionId);
    }

    @Transactional(readOnly = true)
    /**
     * PLAN-0618 M1 (BL-178): chat and session creation must honour the same frozen-backend predicate as
     * file/exec/environment operations. Without this, a send on a docker workspace reaches the Runtime
     * and surfaces a raw transport error instead of the contract's {@code 503 BACKEND_DISABLED}.
     *
     * @return the workspace that passed the gate (callers that need the row can reuse it)
     */
    public com.cc01cc.p.xihe.cp.entity.Workspace requireBackendUsableWorkspace(String workspaceId) {
        com.cc01cc.p.xihe.cp.entity.Workspace workspace =
                workspaceService.requireActiveWorkspace(workspaceId);
        backendPolicy.requireOperationAllowed(workspace);
        return workspace;
    }

    public void requireWorkspace(String userId, String workspaceId) {
        if (userId == null || userId.isBlank() || workspaceId == null || workspaceId.isBlank()) {
            throw CpApiException.workspaceContextRequired();
        }
        workspaceService.requireAccessibleWorkspace(workspaceId, userId);
    }

    private String normalizeTitle(String title) {
        return title == null || title.isBlank() ? "Untitled" : title.trim();
    }
}
