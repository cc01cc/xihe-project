package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * PLAN-0470 (T3.2): the session-domain read/write seam for the persisted
 * approval-mode column ({@code sessions.approval_mode}).
 *
 * <p>Purpose-built leaf so the policy {@code SessionApprovalMode} view can read
 * and write that single column without injecting {@code SessionRepository}
 * directly or depending on the heavyweight {@code SessionService} (whose deep
 * dependency graph — Context → LLM summary → Approval → PolicyEngine — forms a
 * constructor cycle back through the policy engine). The Session canonical
 * writer stays inside the session domain.</p>
 */
@Service
public class SessionApprovalModeStore {

    private final SessionRepository sessionRepository;

    public SessionApprovalModeStore(SessionRepository sessionRepository) {
        this.sessionRepository = sessionRepository;
    }

    /** The stored approval-mode column; empty when the Session row is absent. */
    @Transactional(readOnly = true)
    public Optional<String> findApprovalMode(UUID sessionId) {
        return sessionRepository.findById(sessionId).map(Session::getApprovalMode);
    }

    /**
     * Persist the approval-mode column on an existing Session row.
     *
     * @throws IllegalStateException when the Session row does not exist
     */
    @Transactional
    public void setApprovalMode(UUID sessionId, String mode) {
        Session session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new IllegalStateException("session not found: " + sessionId));
        session.setApprovalMode(mode);
        sessionRepository.save(session);
    }
}
