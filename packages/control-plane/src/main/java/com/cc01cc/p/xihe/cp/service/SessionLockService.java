package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * PLAN-0470 #24/D1d: the Session-domain row-lock seam. Holds the Session row
 * lock inside the caller's transaction (Context event-sequence allocation)
 * without returning the Session entity. Deliberately separate from
 * {@link SessionReadService} (read-only contract) and from SessionService
 * (which depends on Context cleanup — reusing it would form a service cycle).
 */
@Service
public class SessionLockService {

    private final SessionRepository sessionRepository;

    public SessionLockService(SessionRepository sessionRepository) {
        this.sessionRepository = sessionRepository;
    }

    /**
     * Acquire {@code SELECT ... FOR UPDATE} on the Session row; the lock is
     * held until the caller's transaction ends. A missing session is a no-op
     * (same as the previous EventStoreService behaviour).
     */
    public void lockRow(UUID sessionId) {
        sessionRepository.findByIdForUpdate(sessionId);
    }
}
