package com.cc01cc.p.xihe.cp.runtime;

import com.cc01cc.p.xihe.cp.entity.RuntimeJob;
import com.cc01cc.p.xihe.cp.repository.RuntimeJobRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

@Service
public class RuntimeJobService {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeJobService.class);

    private final RuntimeJobRepository repository;

    public RuntimeJobService(RuntimeJobRepository repository) {
        this.repository = repository;
    }

    public RuntimeJob createJob(UUID operationId, UUID operationItemId, UUID workspaceId,
            UUID runId, String commandSummary) {
        RuntimeJob job = new RuntimeJob();
        job.setOperationId(operationId);
        job.setOperationItemId(operationItemId);
        job.setWorkspaceId(workspaceId);
        job.setRunId(runId);
        job.setCommandSummary(commandSummary);
        job.setStatus("queued");
        job.setOutputAvailable(false);
        RuntimeJob saved = repository.save(job);
        logger.info("Created runtime job id={} workspace={}", saved.getId(), workspaceId);
        return saved;
    }

    public boolean startJob(UUID jobId, String ownerId, Instant leaseExpiresAt) {
        int rows = repository.transitionStatus(jobId,
                Set.of("queued"),
                "running", ownerId, leaseExpiresAt);
        if (rows > 0) {
            logger.info("Started runtime job id={} owner={}", jobId, ownerId);
            return true;
        }
        logger.warn("Failed to start runtime job id={} (not in queued state)", jobId);
        return false;
    }

    public boolean completeJob(UUID jobId, Integer exitCode) {
        int rows = repository.completeJob(jobId,
                Set.of("running"),
                "completed", exitCode, Instant.now());
        if (rows > 0) {
            logger.info("Completed runtime job id={} exitCode={}", jobId, exitCode);
            return true;
        }
        logger.warn("Failed to complete runtime job id={} (not in running state)", jobId);
        return false;
    }

    public boolean failJob(UUID jobId, String errorCode) {
        int rows = repository.failJob(jobId,
                Set.of("running"),
                "failed", errorCode, Instant.now());
        if (rows > 0) {
            logger.info("Failed runtime job id={} errorCode={}", jobId, errorCode);
            return true;
        }
        logger.warn("Failed to mark runtime job as failed id={} (not in running state)", jobId);
        return false;
    }

    public boolean cancelJob(UUID jobId) {
        int rows = repository.transitionStatus(jobId,
                Set.of("queued", "running"),
                "cancelled", null, null);
        if (rows > 0) {
            logger.info("Cancelled runtime job id={}", jobId);
            return true;
        }
        logger.warn("Failed to cancel runtime job id={} (not in queued/running state)", jobId);
        return false;
    }

    public int orphanJobs(String ownerId, Collection<UUID> excludedJobIds) {
        Collection<UUID> excluded = excludedJobIds != null ? excludedJobIds : Set.of();
        int rows = repository.orphanByOwner(ownerId, excluded, Instant.now());
        if (rows > 0) {
            logger.info("Orphaned {} jobs for owner={}", rows, ownerId);
        }
        return rows;
    }

    public List<RuntimeJob> findByWorkspaceIdAndStatus(UUID workspaceId, String status) {
        return repository.findByWorkspaceIdAndStatus(workspaceId, status);
    }

    public List<RuntimeJob> findByStatus(String status) {
        return repository.findByStatus(status);
    }

    public Optional<RuntimeJob> findById(UUID jobId) {
        return repository.findById(jobId);
    }
}
