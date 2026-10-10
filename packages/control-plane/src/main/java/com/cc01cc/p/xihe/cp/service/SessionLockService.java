package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Optional;
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

    /**
     * PLAN-0470 (T3.2): acquire the Session row lock and return the locked row so
     * the caller (Policy default-grant idempotency) can read its kind/userId within
     * the same transaction. Empty when the row is absent.
     */
    @Transactional
    public Optional<Session> lockAndFind(UUID sessionId) {
        return sessionRepository.findByIdForUpdate(sessionId);
    }
}
