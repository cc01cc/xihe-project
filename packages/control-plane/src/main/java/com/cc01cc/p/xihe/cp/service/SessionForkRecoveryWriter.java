package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.SessionForkRequest;
import com.cc01cc.p.xihe.cp.repository.SessionForkRequestRepository;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * PLAN-0470 (T3.2): the session-domain write seam for the fork-request recovery
 * state machine.
 *
 * <p>Purpose-built leaf so the files-domain recovery sweeper can advance
 * {@code session_fork_requests} state (COPYING/CLEANUP_PENDING → RETRYABLE) and
 * take the recovery row locks without injecting {@code SessionForkRequestRepository}
 * directly. The files domain keeps only its real responsibility — deleting the
 * abandoned child namespace on disk — and delegates every state read/write to
 * this writer, keeping the fork-request canonical writer inside the session
 * domain.</p>
 */
@Service
public class SessionForkRecoveryWriter {

    private final SessionForkRequestRepository forkRequests;

    public SessionForkRecoveryWriter(SessionForkRequestRepository forkRequests) {
        this.forkRequests = forkRequests;
    }

    /** Lock a bounded batch of stale COPYING / CLEANUP_PENDING rows for recovery. */
    @Transactional
    public List<SessionForkRequest> lockRecoverableRows(Instant copyingBefore, Instant cleanupBefore, int batchSize) {
        return forkRequests.lockRecoverableRows(copyingBefore, cleanupBefore, batchSize);
    }

    /** Lock one fork request by its child session id; empty when absent. */
    @Transactional
    public Optional<SessionForkRequest> findByChildSessionIdForUpdate(UUID childSessionId) {
        return forkRequests.findByChildSessionIdForUpdate(childSessionId);
    }

    /** Advance the fork-request state machine and persist the row. */
    @Transactional
    public void save(SessionForkRequest request) {
        forkRequests.save(request);
    }
}
