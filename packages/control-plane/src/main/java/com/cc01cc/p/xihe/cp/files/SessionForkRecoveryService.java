package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.entity.SessionForkRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0409 V46 recovery. The request table is the durable work source; this
 * service only removes abandoned child namespaces and never replays a fork.
 */
@Service
public class SessionForkRecoveryService {

    private static final Logger logger = LoggerFactory.getLogger(SessionForkRecoveryService.class);
    private static final Duration COPYING_STALE_AFTER = Duration.ofMinutes(5);
    private static final Duration CLEANUP_RETRY_AFTER = Duration.ofMinutes(1);
    private static final int RECOVERY_BATCH_SIZE = 32;

    private final com.cc01cc.p.xihe.cp.service.SessionForkRecoveryWriter forkWriter;
    private final ChatAttachmentService attachments;
    private final String datasourceUrl;

    public SessionForkRecoveryService(com.cc01cc.p.xihe.cp.service.SessionForkRecoveryWriter forkWriter,
                                      ChatAttachmentService attachments,
                                      @Value("${spring.datasource.url:}") String datasourceUrl) {
        this.forkWriter = forkWriter;
        this.attachments = attachments;
        this.datasourceUrl = datasourceUrl;
    }

    @EventListener(ApplicationReadyEvent.class)
    @Transactional
    public void recoverOnStartup() {
        recoverExpiredRequests();
    }

    @Scheduled(fixedDelay = 60_000L, initialDelay = 60_000L)
    @Transactional
    public void recoverPeriodically() {
        recoverExpiredRequests();
    }

    private void recoverExpiredRequests() {
        if (!datasourceUrl.startsWith("jdbc:postgresql:")
                && !datasourceUrl.startsWith("jdbc:tc:postgresql:")) {
            return;
        }
        Instant now = Instant.now();
        List<SessionForkRequest> recoverable = forkWriter.lockRecoverableRows(
                now.minus(COPYING_STALE_AFTER), now.minus(CLEANUP_RETRY_AFTER), RECOVERY_BATCH_SIZE);
        for (SessionForkRequest request : recoverable) {
            recoverOne(request);
        }
    }

    @Transactional
    public boolean retryCleanup(UUID childSessionId) {
        SessionForkRequest request = forkWriter.findByChildSessionIdForUpdate(childSessionId)
                .orElseThrow(() -> new IllegalStateException("Fork request not found"));
        if (SessionForkRequest.COMPLETED.equals(request.getState())) {
            return true;
        }
        request.setState(SessionForkRequest.CLEANUP_PENDING);
        return cleanAndMarkRetryable(request);
    }

    private void recoverOne(SessionForkRequest request) {
        request.setState(SessionForkRequest.CLEANUP_PENDING);
        cleanAndMarkRetryable(request);
    }

    private boolean cleanAndMarkRetryable(SessionForkRequest request) {
        try {
            attachments.deleteForkNamespaceStrict(request.getCleanupRef());
            request.setState(SessionForkRequest.RETRYABLE);
            request.setLastErrorCode(null);
            logger.info("[LIFECYCLE] service=cp event=fork_cleanup_recovered childSessionId={}",
                    request.getChildSessionId());
            return true;
        } catch (IOException e) {
            request.setLastErrorCode("FORK_CLEANUP_FAILED");
            logger.warn("[LIFECYCLE] service=cp event=fork_cleanup_pending childSessionId={} exceptionType={}",
                    request.getChildSessionId(), e.getClass().getSimpleName());
            return false;
        }
    }
}
