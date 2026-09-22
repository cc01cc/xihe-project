package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * PLAN-0390 M2 T2.2：Workspace Job start 编排。
 *
 * <p>顺序：Workspace access → durable root/item（幂等）→ job_state(pending) →
 * Runtime dispatch → 落 running / 失败收口。CP 是 durable 唯一写者，Runtime 只返回
 * 执行事实；dispatch 复用既有 per-request exec（Docker 立即执行，direct-attach 显式
 * `PROCESS_BACKEND_LAUNCH_PENDING`，不 fallback）。
 */
@Service
public class WorkspaceJobStartService {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceJobStartService.class);

    private static final Set<String> SCOPES =
            Set.of(JobStateService.SCOPE_RUN, JobStateService.SCOPE_SESSION, JobStateService.SCOPE_WORKSPACE);
    private static final Set<String> SOURCES = Set.of("ui", "agent", "runtime", "system", "mcp");

    private final OperationService operationService;
    private final JobStateService jobStateService;
    private final WorkspaceService workspaceService;
    private final RuntimeJobClient runtimeJobClient;

    public WorkspaceJobStartService(OperationService operationService,
                                    JobStateService jobStateService,
                                    WorkspaceService workspaceService,
                                    RuntimeJobClient runtimeJobClient) {
        this.operationService = operationService;
        this.jobStateService = jobStateService;
        this.workspaceService = workspaceService;
        this.runtimeJobClient = runtimeJobClient;
    }

    /** Start 请求（wire camelCase，与 spec/execution-job-contract.md 一致）。 */
    public record StartRequest(String command, List<String> args, String cwd, Long timeoutSecs,
                               String scope, String sessionId, String runId, String source,
                               Map<String, String> env) { }

    /** Start 结果：`replayed=true` → HTTP 200 既有 projection；false → 202 新建。 */
    public record StartOutcome(Map<String, Object> job, boolean replayed) { }

    public StartOutcome start(String workspaceId, String userId, StartRequest request,
                              String idempotencyKey) {
        if (request == null || request.command() == null || request.command().isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "command is required");
        }
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "IDEMPOTENCY_KEY_REQUIRED",
                    "Idempotency-Key is required to start a Workspace job");
        }
        Workspace workspace = workspaceService.requireAccessibleWorkspace(workspaceId, userId);
        String executionMode = workspace.getExecutionMode() == null || workspace.getExecutionMode().isBlank()
                ? "docker" : workspace.getExecutionMode();
        String scope = normalizeScope(request.scope());
        String source = normalizeSource(request.source());
        List<String> args = request.args() == null ? List.of() : request.args();
        String inputHash = inputHash(request.command(), args, request.cwd(), request.timeoutSecs());

        OperationService.WorkspaceJobStart start = operationService.startWorkspaceJob(
                userId, workspaceId, normalize(request.sessionId()), normalize(request.runId()),
                source, "user", idempotencyKey, inputHash,
                "job:" + request.command(), argumentsPreview(request.command(), args));
        if (start.replayed()) {
            logger.info("[LIFECYCLE] service=cp event=workspace_job_replayed itemId={} workspaceId={}",
                    start.itemId(), workspaceId);
            Map<String, Object> existing = operationService.jobView(start.itemId());
            if (existing == null) {
                throw new CpApiException(HttpStatus.CONFLICT, "JOB_IDEMPOTENCY_CONFLICT",
                        "Idempotent job root has no archived state");
            }
            return new StartOutcome(existing, true);
        }

        Map<String, Object> pending = new LinkedHashMap<>();
        pending.put("workspaceId", workspaceId);
        pending.put("sessionId", normalize(request.sessionId()));
        pending.put("runId", normalize(request.runId()));
        pending.put("scope", scope);
        pending.put("source", source);
        pending.put("actorType", "user");
        pending.put("backendKind", executionMode);
        pending.put("executionMode", executionMode);
        pending.put("status", JobStateService.STATUS_PENDING);
        pending.put("cleanupStatus", "not_started");
        jobStateService.upsert(start.itemId(), pending);

        RuntimeJobClient.JobStartResult result = runtimeJobClient.startJob(
                workspaceId, start.itemId().toString(), request.command(), args,
                request.cwd(), request.timeoutSecs(), request.env());

        if (!result.reachable()) {
            markSettled(start.itemId(), JobStateService.STATUS_INTERRUPTED, "RUNTIME_UNAVAILABLE", "failed");
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE",
                    "Runtime job start could not be confirmed");
        }
        if (!result.launched()) {
            // Runtime 显式声明该 backend 无 launcher（mode 漂移兜底）；不 fallback。
            String code = result.errorCode() == null ? "UNMAPPED_ERROR" : result.errorCode();
            if (result.backendPending()) {
                markSettled(start.itemId(), JobStateService.STATUS_INTERRUPTED,
                        "JOB_BACKEND_LAUNCH_PENDING", "not_started");
                throw new CpApiException(HttpStatus.NOT_IMPLEMENTED, "JOB_BACKEND_LAUNCH_PENDING",
                        "Job execution backend has no launcher", result.requestId());
            }
            markSettled(start.itemId(), JobStateService.STATUS_INTERRUPTED, code, "not_started");
            throw new CpApiException(runtimeStatus(result.statusCode()), code,
                    result.reason() == null ? "Runtime rejected the job start" : result.reason(),
                    result.requestId());
        }
        Map<String, Object> running = new LinkedHashMap<>();
        running.put("jobId", result.jobId());
        running.put("status", JobStateService.STATUS_RUNNING);
        running.put("startedAt", java.time.Instant.now().toString());
        String bootId = runtimeJobClient.runtimeBootId();
        if (bootId != null) {
            running.put("runtimeBootId", bootId);
        }
        jobStateService.upsert(start.itemId(), running);
        logger.info("[LIFECYCLE] service=cp event=workspace_job_dispatched itemId={} jobId={} workspaceId={}",
                start.itemId(), result.jobId(), workspaceId);
        return new StartOutcome(operationService.jobView(start.itemId()), false);
    }

    private static HttpStatus runtimeStatus(int statusCode) {
        HttpStatus status = HttpStatus.resolve(statusCode);
        return status == null || status.is2xxSuccessful() ? HttpStatus.BAD_GATEWAY : status;
    }

    private void markSettled(java.util.UUID itemId, String status, String errorCode, String cleanupStatus) {
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("status", status);
        incoming.put("errorCode", errorCode);
        incoming.put("cleanupStatus", cleanupStatus);
        incoming.put("endedAt", java.time.Instant.now().toString());
        jobStateService.upsert(itemId, incoming);
    }

    private static String normalizeScope(String scope) {
        if (scope == null || scope.isBlank()) {
            return JobStateService.SCOPE_SESSION;
        }
        String normalized = scope.trim().toLowerCase(Locale.ROOT);
        return SCOPES.contains(normalized) ? normalized : JobStateService.SCOPE_SESSION;
    }

    private static String normalizeSource(String source) {
        if (source == null || source.isBlank()) {
            return "ui";
        }
        String normalized = source.trim().toLowerCase(Locale.ROOT);
        return SOURCES.contains(normalized) ? normalized : "ui";
    }

    private static String normalize(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static String argumentsPreview(String command, List<String> args) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper()
                    .writeValueAsString(Map.of("command", command, "args", args));
        } catch (Exception e) {
            return "{\"command\":\"" + command + "\"}";
        }
    }

    static String inputHash(String command, List<String> args, String cwd, Long timeoutSecs) {
        String canonical = String.join("\n", command, String.join("\u0000", args),
                cwd == null ? "" : cwd, String.valueOf(timeoutSecs == null ? 0L : timeoutSecs));
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
