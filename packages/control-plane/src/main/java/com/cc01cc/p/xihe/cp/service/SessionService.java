package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
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

    public SessionService(SessionRepository sessionRepository,
                          MessageRepository messageRepository,
                          FileRepository fileRepository,
                          EventStoreRepository eventStoreRepository,
                          ContextProjectionRepository contextProjectionRepository,
                          WorkspaceService workspaceService,
                          ChatAttachmentService chatAttachmentService) {
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.eventStoreRepository = eventStoreRepository;
        this.contextProjectionRepository = contextProjectionRepository;
        this.workspaceService = workspaceService;
        this.chatAttachmentService = chatAttachmentService;
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
        requireWorkspace(userId, workspaceId);
        return createWithId(UUID.randomUUID().toString(), userId, workspaceId,
                title, modelProvider, modelName);
    }

    @Transactional
    public Session createWithId(String sessionId, String userId, String workspaceId, String title,
                                String modelProvider, String modelName) {
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
        return sessionRepository.save(session);
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
