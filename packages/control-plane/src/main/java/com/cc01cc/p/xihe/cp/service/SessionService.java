package com.cc01cc.p.xihe.cp.service;

import jakarta.persistence.EntityManager;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionForkRequest;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.policy.SessionPolicyState;
import com.cc01cc.p.xihe.cp.provider.ProviderConnectionService;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.SessionForkRequestRepository;
import com.cc01cc.p.xihe.cp.context.repository.ContextProjectionRepository;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@Service
public class SessionService {

    private final SessionRepository sessionRepository;
    private final SessionForkRequestRepository forkRequestRepository;
    private final SessionBranchRepository sessionBranchRepository;
    private final MessageRepository messageRepository;
    private final FileRepository fileRepository;
    private final EventStoreRepository eventStoreRepository;
    private final ContextProjectionRepository contextProjectionRepository;
    private final WorkspaceService workspaceService;
    private final ChatAttachmentService chatAttachmentService;
    private final ProviderConnectionService providerConnectionService;
    private final SessionPolicyState sessionPolicyState;
    private final AuthorizationGrantRepository authorizationGrantRepository;
    private final DbLockTimeout dbLockTimeout;
    private final AgentPrincipalService agentPrincipalService;
    private final ContextTemplateService contextTemplateService;
    private final EntityManager entityManager;

    public SessionService(SessionRepository sessionRepository,
                          SessionForkRequestRepository forkRequestRepository,
                          SessionBranchRepository sessionBranchRepository,
                          MessageRepository messageRepository,
                          FileRepository fileRepository,
                          EventStoreRepository eventStoreRepository,
                          ContextProjectionRepository contextProjectionRepository,
                          WorkspaceService workspaceService,
                          ChatAttachmentService chatAttachmentService,
                          ProviderConnectionService providerConnectionService,
                          SessionPolicyState sessionPolicyState,
                           AuthorizationGrantRepository authorizationGrantRepository,
                           DbLockTimeout dbLockTimeout,
                           AgentPrincipalService agentPrincipalService,
                           ContextTemplateService contextTemplateService,
                           EntityManager entityManager) {
        this.sessionRepository = sessionRepository;
        this.forkRequestRepository = forkRequestRepository;
        this.sessionBranchRepository = sessionBranchRepository;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.eventStoreRepository = eventStoreRepository;
        this.contextProjectionRepository = contextProjectionRepository;
        this.workspaceService = workspaceService;
        this.chatAttachmentService = chatAttachmentService;
        this.providerConnectionService = providerConnectionService;
        this.sessionPolicyState = sessionPolicyState;
        this.authorizationGrantRepository = authorizationGrantRepository;
        this.dbLockTimeout = dbLockTimeout;
        this.agentPrincipalService = agentPrincipalService;
        this.contextTemplateService = contextTemplateService;
        this.entityManager = entityManager;
    }

    @Transactional(readOnly = true)
    public List<Session> list(String userId, String workspaceId) {
        requireWorkspace(userId, workspaceId);
        return sessionRepository.findByWorkspaceIdAndUserIdAndArchivedFalseOrderByCreatedAtDesc(
                workspaceId, userId);
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
        requireWorkspace(userId, workspaceId);
        if (agentPrincipalId == null || agentPrincipalId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "agentPrincipalId is required");
        }
        com.fasterxml.jackson.databind.JsonNode cap = agentPrincipalService.resolveSessionCap(
                agentPrincipalId, workspaceId);
        Session session = new Session(workspaceId, userId, normalizeTitle(title));
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(agentPrincipalId);
        session.setAgentPermissionsSnapshot(cap);
        session.setModelProvider(modelProvider);
        session.setModelName(modelName);
        bindProviderConnection(session, userId, workspaceId, providerConnectionId, modelProvider);
        ContextTemplateService.TemplateBinding binding = contextTemplateService.resolveForSession(
                userId, workspaceId, session.getModelProvider(), session.getModelName(), templateSelection);
        applyContextTemplateBinding(session, binding);
        return sessionRepository.save(session);
    }

    @Transactional
    public Session createForkSession(String sourceSessionId, UUID childSessionId, String anchorRunId,
                                     String userId, String workspaceId) {
        Session source = requireCurrent(sourceSessionId, userId, workspaceId);
        String agentPrincipalId = source.getAgentPrincipalId();
        if (agentPrincipalId == null || agentPrincipalId.isBlank()) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_PRINCIPAL_REQUIRED",
                    "A fork requires a stable AgentPrincipal on the source Session");
        }

        com.fasterxml.jackson.databind.JsonNode currentCap = agentPrincipalService.resolveSessionCap(
                agentPrincipalId, workspaceId);
        Session child = new Session(workspaceId, userId, normalizeTitle("Fork of " + source.getTitle()));
        child.setId(childSessionId);
        child.setAgentPrincipalId(agentPrincipalId);
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
        return sessionRepository.saveAndFlush(child);
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
        return sessionRepository.save(session);
    }

    @Transactional(readOnly = true)
    public Session requireCurrent(String sessionId, String userId, String workspaceId) {
        requireWorkspace(userId, workspaceId);
        return sessionRepository.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                        UUID.fromString(sessionId), userId, workspaceId)
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
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
        Session session = requireCurrent(sessionId, userId, workspaceId);
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
        return sessionRepository.save(session);
    }

    @Transactional
    public Session updateContextTemplate(String sessionId, String userId, String workspaceId,
                                         String layer, String templateId, int version) {
        Session session = lockCurrentForMutation(sessionId, userId, workspaceId);
        ContextTemplateService.TemplateBinding binding = contextTemplateService.binding(
                layer, templateId, version, "explicit", UUID.fromString(userId), UUID.fromString(workspaceId));
        applyContextTemplateBinding(session, binding);
        return sessionRepository.save(session);
    }

    private static void applyContextTemplateBinding(Session session,
                                                     ContextTemplateService.TemplateBinding binding) {
        session.setContextTemplateLayer(binding.layer());
        session.setContextTemplateId(UUID.fromString(binding.templateId()));
        session.setContextTemplateVersion(binding.version());
    }

    private void bindProviderConnection(
            Session session,
            String userId,
            String workspaceId,
            String providerConnectionId,
            String requestedProvider) {
        if (providerConnectionId == null || providerConnectionId.isBlank()) return;
        try {
            ProviderConnection connection = providerConnectionService.requireUsable(providerConnectionId);
            if (requestedProvider != null && !requestedProvider.isBlank()
                    && !connection.getProviderId().equals(requestedProvider.trim())) {
                throw new IllegalArgumentException("Provider connection does not match model provider");
            }
            if (!session.getWorkspaceId().equals(workspaceId) || !session.getUserId().equals(userId)) {
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
        fileRepository.deleteBySessionId(sessionId);
        // Fork Message rows retain parent Run IDs only as nullable lineage; do not leave them dangling.
        messageRepository.clearRunReferencesToSession(sessionId);
        messageRepository.deleteBySessionId(sessionId);
        contextProjectionRepository.deleteBySessionId(sessionId);
        eventStoreRepository.deleteBySessionId(sessionId);
        authorizationGrantRepository.deleteBySubjectTypeAndSubjectId("agent", lockedSession.getId());
        sessionRepository.delete(lockedSession);
        // T1.7: session mode, L4 rules and reuse fingerprints must not outlive the session.
        sessionPolicyState.clear(sessionId);
    }

    @Transactional(readOnly = true)
    public void requireWorkspace(String userId, String workspaceId) {
        if (userId == null || userId.isBlank() || workspaceId == null || workspaceId.isBlank()) {
            throw new CpApiException(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authenticated workspace context is required");
        }
        workspaceService.requireAccessibleWorkspace(workspaceId, userId);
    }

    private String normalizeTitle(String title) {
        return title == null || title.isBlank() ? "Untitled" : title.trim();
    }
}
