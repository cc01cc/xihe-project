package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.provider.ProviderConnectionService;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.context.repository.ContextProjectionRepository;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
public class SessionService {

    private final SessionRepository sessionRepository;
    private final MessageRepository messageRepository;
    private final FileRepository fileRepository;
    private final EventStoreRepository eventStoreRepository;
    private final ContextProjectionRepository contextProjectionRepository;
    private final WorkspaceService workspaceService;
    private final ChatAttachmentService chatAttachmentService;
    private final ProviderConnectionService providerConnectionService;

    public SessionService(SessionRepository sessionRepository,
                          MessageRepository messageRepository,
                          FileRepository fileRepository,
                          EventStoreRepository eventStoreRepository,
                          ContextProjectionRepository contextProjectionRepository,
                          WorkspaceService workspaceService,
                          ChatAttachmentService chatAttachmentService,
                          ProviderConnectionService providerConnectionService) {
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.eventStoreRepository = eventStoreRepository;
        this.contextProjectionRepository = contextProjectionRepository;
        this.workspaceService = workspaceService;
        this.chatAttachmentService = chatAttachmentService;
        this.providerConnectionService = providerConnectionService;
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
        if (sessionRepository.findById(sessionId).isPresent()) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_ALREADY_EXISTS", "Session already exists");
        }
        Session session = new Session(workspaceId, userId, normalizeTitle(title));
        session.setId(sessionId);
        session.setModelProvider(modelProvider);
        session.setModelName(modelName);
        bindProviderConnection(session, userId, workspaceId, providerConnectionId, modelProvider);
        return sessionRepository.save(session);
    }

    @Transactional(readOnly = true)
    public Session requireCurrent(String sessionId, String userId, String workspaceId) {
        requireWorkspace(userId, workspaceId);
        return sessionRepository.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                        sessionId, userId, workspaceId)
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
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
            session.setProviderConnectionId(connection.getId());
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
        Session session = requireCurrent(sessionId, userId, workspaceId);

        // Delete metadata and context rows explicitly so this remains correct on old live schemas.
        chatAttachmentService.deleteSessionAttachments(sessionId);
        fileRepository.deleteBySessionId(sessionId);
        messageRepository.deleteBySessionId(sessionId);
        contextProjectionRepository.deleteBySessionId(sessionId);
        eventStoreRepository.deleteBySessionId(sessionId);
        sessionRepository.delete(session);
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
