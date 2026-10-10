package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * PLAN-0470 (T3.2): the single writer that guarantees a Session row exists
 * before attachment upload / fork recovery reference it.
 *
 * <p>Purpose-built leaf in the session domain so the files domain can anchor an
 * upload without injecting {@link SessionService} (which already depends on
 * {@code ChatAttachmentService} for delete-time cleanup — injecting it would form a
 * constructor cycle). It carries no other dependencies, so {@code files/...}
 * depends on it one-way. The ownership assertion (workspaceId/userId match,
 * non-archived) is preserved from the previous {@code ChatAttachmentService}
 * logic; the Session canonical writer stays inside the session domain.</p>
 */
@Service
public class SessionAttachmentAnchorService {

    private static final Logger logger = LoggerFactory.getLogger(SessionAttachmentAnchorService.class);

    private final SessionRepository sessionRepository;

    public SessionAttachmentAnchorService(SessionRepository sessionRepository) {
        this.sessionRepository = sessionRepository;
    }

    /**
     * Ensure the Session row exists for an attachment reference, creating a
     * placeholder row when absent.
     *
     * @throws IllegalArgumentException when the existing Session is archived or
     *                                  owned by a different workspace/user
     */
    @Transactional
    public void ensureExistsForAttachment(String sessionId, String workspaceId, String userId) {
        UUID id = UUID.fromString(sessionId);
        Optional<Session> existing = sessionRepository.findById(id);
        if (existing.isPresent()) {
            Session session = existing.get();
            if (session.isArchived()
                    || !workspaceId.equals(session.getWorkspaceId())
                    || !userId.equals(session.getUserId())) {
                throw new IllegalArgumentException("Session access denied");
            }
            return;
        }
        Session session = new Session(workspaceId, userId, "Attachment Upload");
        session.setId(id);
        sessionRepository.save(session);
        logger.info("Session created for attachments session={} workspace={}", sessionId, workspaceId);
    }

    /**
     * Read-only existence probe. Returns the raw Session row (no ownership
     * filtering) so the files caller can preserve its two distinct failures
     * ("not found" vs "access denied"). Empty when the row is absent.
     */
    @Transactional(readOnly = true)
    public Optional<Session> findExistingSession(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            return Optional.empty();
        }
        return sessionRepository.findById(UUID.fromString(sessionId));
    }

    /**
     * Read-only ownership probe for attachment download resolution. Returns the
     * Session when it exists and is owned by the given workspace/user without
     * being archived; {@code null} otherwise (including a {@code null}/blank
     * {@code sessionId}), so the files caller can collapse every failure into
     * its existing single forbidden path.
     */
    @Transactional(readOnly = true)
    public Session findOwnedSession(String sessionId, String workspaceId, String userId) {
        if (sessionId == null || sessionId.isBlank()) {
            return null;
        }
        return sessionRepository.findById(UUID.fromString(sessionId))
                .filter(session -> !session.isArchived())
                .filter(session -> workspaceId.equals(session.getWorkspaceId()))
                .filter(session -> userId.equals(session.getUserId()))
                .orElse(null);
    }
}
