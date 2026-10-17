package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.WorkspaceLifecycleOperation;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.repository.WorkspaceLifecycleOperationRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeWorkspaceClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationContext;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0391 (decision #27/#30): orchestrates the user-triggered "release
 * execution resources" command for one Workspace.
 *
 * <p>Order: idempotent replay → active-Job / in-flight gate → durable
 * accepted operation → Runtime dispatch → settle. Authorization is done by the
 * controller entry (PLAN-0470 style); this service never re-checks membership,
 * but the Runtime re-checks active-Job/Destroying under its operation lock
 * (decision #30).</p>
 */
@Service
public class WorkspaceRuntimeReleaseService {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceRuntimeReleaseService.class);

    private static final Set<String> ACTIVE_STATUSES = Set.of(
            WorkspaceLifecycleOperation.STATUS_ACCEPTED,
            WorkspaceLifecycleOperation.STATUS_RUNNING);

    private static final int MAX_IDEMPOTENCY_KEY_LENGTH = 128;

    /** Release outcome: {@code replayed=true} → HTTP 200 existing operation; false → 202 new. */
    public record ReleaseOutcome(Map<String, Object> operation, boolean replayed) {}

    private final WorkspaceLifecycleOperationRepository operations;
    private final JobStateService jobStateService;
    private final RuntimeWorkspaceClient runtimeWorkspaceClient;
    private final ApplicationContext applicationContext;

    public WorkspaceRuntimeReleaseService(WorkspaceLifecycleOperationRepository operations,
                                          JobStateService jobStateService,
                                          RuntimeWorkspaceClient runtimeWorkspaceClient,
                                          ApplicationContext applicationContext) {
        this.operations = operations;
        this.jobStateService = jobStateService;
        this.runtimeWorkspaceClient = runtimeWorkspaceClient;
        this.applicationContext = applicationContext;
    }

    private WorkspaceRuntimeReleaseService self() {
        return applicationContext.getBean(WorkspaceRuntimeReleaseService.class);
    }

    public ReleaseOutcome release(String workspaceId, String userId, String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "IDEMPOTENCY_KEY_REQUIRED",
                    "Idempotency-Key is required to release a Workspace runtime");
        }
        if (idempotencyKey.length() > MAX_IDEMPOTENCY_KEY_LENGTH) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Idempotency-Key must be at most " + MAX_IDEMPOTENCY_KEY_LENGTH + " characters");
        }
        UUID workspaceUuid = parseUuid(workspaceId);
        UUID userUuid = parseUuid(userId);
        if (workspaceUuid == null || userUuid == null) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found");
        }

        // 1) Idempotent replay: same key returns the existing operation.
        Optional<WorkspaceLifecycleOperation> replay =
                operations.findByUserIdAndWorkspaceIdAndIdempotencyKey(userUuid, workspaceUuid, idempotencyKey);
        if (replay.isPresent()) {
            return new ReleaseOutcome(view(replay.get()), true);
        }

        // 2) Gates: an active Job, or another in-flight release, blocks release.
        if (jobStateService.hasRunningForWorkspace(workspaceId)) {
            throw new CpApiException(HttpStatus.CONFLICT, "WORKSPACE_BUSY",
                    "Workspace has an active job; release is refused");
        }
        if (operations.findFirstByWorkspaceIdAndStatusIn(workspaceUuid, ACTIVE_STATUSES).isPresent()) {
            throw new CpApiException(HttpStatus.CONFLICT, "WORKSPACE_BUSY",
                    "Another release operation is in flight for this workspace");
        }

        // 3) Durable accepted operation (unique indexes close the remaining race).
        WorkspaceLifecycleOperation op;
        try {
            op = self().insertAccepted(workspaceUuid, userUuid, idempotencyKey);
        } catch (DataIntegrityViolationException e) {
            logger.warn("[LIFECYCLE] service=cp event=workspace_release_conflict workspaceId={} reason={}",
                    workspaceId, e.getMessage());
            Optional<WorkspaceLifecycleOperation> winner =
                    operations.findByUserIdAndWorkspaceIdAndIdempotencyKey(userUuid, workspaceUuid, idempotencyKey);
            if (winner.isPresent()) {
                return new ReleaseOutcome(view(winner.get()), true);
            }
            throw new CpApiException(HttpStatus.CONFLICT, "WORKSPACE_BUSY",
                    "Another release operation is in flight for this workspace");
        }
        logger.info("[LIFECYCLE] service=cp event=workspace_release_accepted releaseOperationId={} workspaceId={}",
                op.getId(), workspaceId);

        // 4) Dispatch to Runtime; CP is the durable writer, Runtime returns facts.
        RuntimeWorkspaceClient.ReleaseResult result =
                runtimeWorkspaceClient.release(workspaceId, op.getId().toString());
        if (result.unreachable()) {
            self().settle(op.getId(), WorkspaceLifecycleOperation.STATUS_FAILED, null, "RUNTIME_UNAVAILABLE");
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE",
                    "Runtime release could not be confirmed");
        }
        if (result.problemCode() != null) {
            // PLAN-0345 #11: pass Runtime Problem status/code through unchanged
            // (409 WORKSPACE_BUSY / WORKSPACE_DESTROYING must not collapse).
            String code = result.problemCode();
            if (isRetryableConflict(code)) {
                // The Runtime lock may still be held by an in-flight materialize;
                // this rejection is transient, so do NOT consume the idempotency
                // key — discard the accepted row so a same-key retry can dispatch.
                self().discard(op.getId());
            } else {
                self().settle(op.getId(), WorkspaceLifecycleOperation.STATUS_FAILED, null, code);
            }
            HttpStatus status = result.httpStatus() == null
                    ? HttpStatus.BAD_GATEWAY : HttpStatus.resolve(result.httpStatus());
            if (status == null || status.is2xxSuccessful()) {
                status = HttpStatus.BAD_GATEWAY;
            }
            throw new CpApiException(status, code, result.problemDetail());
        }

        boolean cleanupFailed = result.body() != null
                && Boolean.TRUE.equals(result.body().get("cleanupFailed"));
        if (cleanupFailed) {
            self().settle(op.getId(), WorkspaceLifecycleOperation.STATUS_FAILED,
                    "CLEANUP_FAILED", "CLEANUP_FAILED");
        } else {
            self().settle(op.getId(), WorkspaceLifecycleOperation.STATUS_COMPLETED,
                    "USER_RELEASED", null);
        }
        return new ReleaseOutcome(view(operations.findById(op.getId()).orElse(op)), false);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public WorkspaceLifecycleOperation insertAccepted(UUID workspaceId, UUID userId, String idempotencyKey) {
        WorkspaceLifecycleOperation row = new WorkspaceLifecycleOperation();
        row.setId(UUID.randomUUID());
        row.setWorkspaceId(workspaceId);
        row.setUserId(userId);
        row.setIdempotencyKey(idempotencyKey);
        row.setStatus(WorkspaceLifecycleOperation.STATUS_ACCEPTED);
        return operations.save(row);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void settle(UUID id, String status, String reason, String errorCode) {
        operations.findByIdForUpdate(id).ifPresent(row -> {
            row.setStatus(status);
            row.setReason(reason);
            row.setErrorCode(errorCode);
            if (!row.isActive() && row.getEndedAt() == null) {
                row.setEndedAt(Instant.now());
            }
            operations.save(row);
        });
    }

    /** PLAN-0391: transient Runtime rejections that must not consume the idempotency key. */
    private static boolean isRetryableConflict(String code) {
        return "WORKSPACE_BUSY".equals(code) || "WORKSPACE_DESTROYING".equals(code);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void discard(UUID id) {
        operations.deleteById(id);
    }

    /** Wire projection of one operation (camelCase). */
    public static Map<String, Object> view(WorkspaceLifecycleOperation op) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("releaseOperationId", op.getId() == null ? null : op.getId().toString());
        body.put("workspaceId", op.getWorkspaceId() == null ? null : op.getWorkspaceId().toString());
        body.put("status", op.getStatus());
        body.put("reason", op.getReason());
        body.put("errorCode", op.getErrorCode());
        body.put("createdAt", op.getCreatedAt() == null ? null : op.getCreatedAt().toString());
        body.put("endedAt", op.getEndedAt() == null ? null : op.getEndedAt().toString());
        return body;
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
