package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.WorkspaceLifecycleOperation;
import com.cc01cc.p.xihe.cp.repository.WorkspaceLifecycleOperationRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;

/**
 * PLAN-0391 T1.5: recovery sweep for release operations left in-flight.
 *
 * <p>Release is synchronous within one CP request: an operation reaches a
 * terminal state before the response returns. A CP restart or a hung dispatch
 * can therefore leave an {@code accepted}/{@code running} row behind. This
 * sweep marks such rows {@code interrupted} and never replays the release — the
 * Runtime reclaims on the next use regardless.</p>
 */
@Service
public class WorkspaceLifecycleRecoveryService {

    private static final Logger logger =
            LoggerFactory.getLogger(WorkspaceLifecycleRecoveryService.class);

    private static final Set<String> ACTIVE_STATUSES = Set.of(
            WorkspaceLifecycleOperation.STATUS_ACCEPTED,
            WorkspaceLifecycleOperation.STATUS_RUNNING);

    /** Periodic sweep only reclaims rows older than this (avoids racing a live request). */
    private static final Duration STALE_AFTER = Duration.ofMinutes(5);

    private final WorkspaceLifecycleOperationRepository operations;
    private final String datasourceUrl;

    public WorkspaceLifecycleRecoveryService(WorkspaceLifecycleOperationRepository operations,
                                             @Value("${spring.datasource.url:}") String datasourceUrl) {
        this.operations = operations;
        this.datasourceUrl = datasourceUrl;
    }

    @EventListener(ApplicationReadyEvent.class)
    @Transactional
    public void recoverOnStartup() {
        if (!isPostgres()) {
            return;
        }
        // A restart means no dispatcher is alive: every in-flight row is interrupted.
        interrupt(operations.findByStatusIn(ACTIVE_STATUSES));
    }

    @Scheduled(fixedDelayString = "${cp.workspace.release-recover-interval-ms:300000}",
            initialDelayString = "${cp.workspace.release-recover-initial-delay-ms:60000}")
    @Transactional
    public void recoverPeriodically() {
        if (!isPostgres()) {
            return;
        }
        interrupt(operations.findByStatusInAndCreatedAtBefore(
                ACTIVE_STATUSES, Instant.now().minus(STALE_AFTER)));
    }

    private void interrupt(List<WorkspaceLifecycleOperation> inFlight) {
        for (WorkspaceLifecycleOperation operation : inFlight) {
            operation.setStatus(WorkspaceLifecycleOperation.STATUS_INTERRUPTED);
            operation.setErrorCode("INTERRUPTED");
            if (operation.getEndedAt() == null) {
                operation.setEndedAt(Instant.now());
            }
            operations.save(operation);
            logger.warn("[LIFECYCLE] service=cp event=workspace_release_interrupted "
                            + "releaseOperationId={} workspaceId={}",
                    operation.getId(), operation.getWorkspaceId());
        }
    }

    private boolean isPostgres() {
        return datasourceUrl.startsWith("jdbc:postgresql:")
                || datasourceUrl.startsWith("jdbc:tc:postgresql:");
    }
}
