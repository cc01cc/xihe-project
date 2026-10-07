package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationContext;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0390 M2 T2.2 / PLAN-0465 T1.2：Workspace Job start 编排。
 *
 * <p>顺序：Workspace access → 幂等重读（`workspace_jobs`，V36 语义）→ 原子双写
 * （legacy root/item + `workspace_jobs` 行，同一 REQUIRES_NEW 事务）→ Runtime
 * 派发 → 落 running / 失败收口。CP 是 durable 唯一写者，Runtime 只返回执行事实；
 * dispatch 复用既有 per-request exec（Docker 立即执行，direct-attach 显式
 * `PROCESS_BACKEND_LAUNCH_PENDING`，不 fallback）。</p>
 *
 * <p>PLAN-0465 decision #7：对外 `jobId` = `workspace_jobs.id`（domain 身份）；
 * 派发给 Runtime 的 `operationItemId` 请求键也改为该 domain jobId（Runtime 字段名
 * 沿用至 0467，对照表见 evidence/m0-baseline.md T0.2）。</p>
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
    private final ApplicationContext applicationContext;

    public WorkspaceJobStartService(OperationService operationService,
                                    JobStateService jobStateService,
                                    WorkspaceService workspaceService,
                                    RuntimeJobClient runtimeJobClient,
                                    ApplicationContext applicationContext) {
        this.operationService = operationService;
        this.jobStateService = jobStateService;
        this.workspaceService = workspaceService;
        this.runtimeJobClient = runtimeJobClient;
        this.applicationContext = applicationContext;
    }

    /** Start 请求（wire camelCase，与 spec/execution-job-contract.md 一致）。 */
    public record StartRequest(String command, List<String> args, String cwd, Long timeoutSecs,
                               String scope, String sessionId, String runId, String source,
                               Map<String, String> env) { }

    /** Start 结果：`replayed=true` → HTTP 200 既有 projection；false → 202 新建。 */
    public record StartOutcome(Map<String, Object> job, boolean replayed) { }

    private WorkspaceJobStartService self() {
        return applicationContext.getBean(WorkspaceJobStartService.class);
    }

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
        String sessionId = normalize(request.sessionId());
        String runId = normalize(request.runId());

        // 1) 域内幂等重读（workspace_jobs 主身份）。
        Optional<WorkspaceJob> replayRow = jobStateService.findForReplay(
                userId, workspaceId, sessionId, idempotencyKey);
        if (replayRow.isPresent()) {
            return replayOutcome(replayRow.get(), inputHash);
        }
        // 2) legacy 幂等兜底（0465 前建的 key，无 domain 行；dual-read，至 0467）。
        OperationService.WorkspaceJobStart legacy = operationService.findWorkspaceJobForReplay(
                userId, workspaceId, sessionId, idempotencyKey, inputHash);
        if (legacy != null) {
            return new StartOutcome(legacyWireView(legacy.itemId()), true);
        }

        // 3) 原子双写：legacy root/item + workspace_jobs 行（同一事务）。
        UUID jobId;
        try {
            jobId = self().insertJob(workspaceId, userId, sessionId, runId, source, scope,
                    idempotencyKey, inputHash, request, args, executionMode).getId();
        } catch (DataIntegrityViolationException e) {
            logger.warn("[LIFECYCLE] service=cp event=job_start_conflict workspaceId={} reason={}",
                    workspaceId, e.getMessage());
            Optional<WorkspaceJob> winner = jobStateService.findForReplay(
                    userId, workspaceId, sessionId, idempotencyKey);
            if (winner.isPresent()) {
                return replayOutcome(winner.get(), inputHash);
            }
            OperationService.WorkspaceJobStart legacyWinner = operationService.findWorkspaceJobForReplay(
                    userId, workspaceId, sessionId, idempotencyKey, inputHash);
            if (legacyWinner != null) {
                return new StartOutcome(legacyWireView(legacyWinner.itemId()), true);
            }
            throw new CpApiException(HttpStatus.CONFLICT, "JOB_IDEMPOTENCY_CONFLICT",
                    "A job with the same idempotency key already exists");
        }
        logger.info("[LIFECYCLE] service=cp event=workspace_job_started jobId={} workspaceId={}",
                jobId, workspaceId);

        // 4) Runtime 派发（请求键 = domain jobId；Runtime 字段名 0467 才改）。
        RuntimeJobClient.JobStartResult result = runtimeJobClient.startJob(
                workspaceId, jobId.toString(), request.command(), args,
                request.cwd(), request.timeoutSecs(), request.env());

        if (!result.reachable()) {
            markSettled(jobId, JobStateService.STATUS_INTERRUPTED, "RUNTIME_UNAVAILABLE", "failed");
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE",
                    "Runtime job start could not be confirmed");
        }
        if (!result.launched()) {
            // Runtime 显式声明该 backend 无 launcher（mode 漂移兜底）；不 fallback。
            String code = result.errorCode() == null ? "UNMAPPED_ERROR" : result.errorCode();
            if (result.backendPending()) {
                markSettled(jobId, JobStateService.STATUS_INTERRUPTED,
                        "JOB_BACKEND_LAUNCH_PENDING", "not_started");
                throw new CpApiException(HttpStatus.NOT_IMPLEMENTED, "JOB_BACKEND_LAUNCH_PENDING",
                        "Job execution backend has no launcher", result.requestId());
            }
            markSettled(jobId, JobStateService.STATUS_INTERRUPTED, code, "not_started");
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
        jobStateService.upsertById(jobId, running);
        logger.info("[LIFECYCLE] service=cp event=workspace_job_dispatched jobId={} runtimeJobId={} workspaceId={}",
                jobId, result.jobId(), workspaceId);
        return new StartOutcome(jobStateService.wireViewById(jobId)
                .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT, "JOB_IDEMPOTENCY_CONFLICT",
                        "Started job has no durable projection")), false);
    }

    /**
     * 原子双写插入（REQUIRES_NEW）：legacy root/item 先行（提供 item 锚点），
     * 再建 `workspace_jobs` 行 + history `start`；任一唯一索引冲突整体回滚，
     * 由 {@link #start} 重读赢家。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public WorkspaceJob insertJob(String workspaceId, String userId, String sessionId, String runId,
                                  String source, String scope, String idempotencyKey, String inputHash,
                                  StartRequest request, List<String> args, String executionMode) {
        OperationService.WorkspaceJobStart legacy = operationService.persistLegacyJobRoot(
                userId, workspaceId, sessionId, runId, source, "user", idempotencyKey, inputHash,
                "job:" + request.command(), argumentsPreview(request.command(), args));

        WorkspaceJob row = new WorkspaceJob();
        row.setId(UUID.randomUUID());
        row.setWorkspaceId(UUID.fromString(workspaceId));
        row.setUserId(UUID.fromString(userId));
        row.setSessionId(parseUuid(sessionId));
        row.setRunId(parseUuid(runId));
        row.setOperationItemId(legacy.itemId());
        row.setSource(source);
        row.setScope(scope);
        row.setIdempotencyKey(idempotencyKey);
        row.setInputHash(inputHash);

        Map<String, Object> pending = new LinkedHashMap<>();
        pending.put("workspaceId", workspaceId);
        pending.put("sessionId", sessionId);
        pending.put("runId", runId);
        pending.put("scope", scope);
        pending.put("source", source);
        pending.put("actorType", "user");
        pending.put("backendKind", executionMode);
        pending.put("executionMode", executionMode);
        pending.put("status", JobStateService.STATUS_PENDING);
        pending.put("cleanupStatus", "not_started");
        jobStateService.createJob(row, pending);
        return row;
    }

    /** 幂等重放：同 key 同 hash → 既有 projection；异 hash → 409（V36 语义）。 */
    private StartOutcome replayOutcome(WorkspaceJob row, String inputHash) {
        if (row.getInputHash() != null && inputHash != null
                && !row.getInputHash().equals(inputHash)) {
            throw new CpApiException(HttpStatus.CONFLICT, "JOB_IDEMPOTENCY_CONFLICT",
                    "Idempotency key was already used with a different job request");
        }
        logger.info("[LIFECYCLE] service=cp event=workspace_job_replayed jobId={} workspaceId={}",
                row.getId(), row.getWorkspaceId());
        return new StartOutcome(jobStateService.wireView(row), true);
    }

    /** pre-deploy legacy 行的重放投影：wire `jobId` = legacy item 身份（过渡登记至 0467）。 */
    private Map<String, Object> legacyWireView(UUID itemId) {
        JobStateService.JobArchive archive = jobStateService.find(itemId)
                .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT, "JOB_IDEMPOTENCY_CONFLICT",
                        "Idempotent job root has no archived state"));
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("jobId", archive.itemId());
        view.put("runtimeJobId", archive.jobId());
        view.put("workspaceId", archive.workspaceId());
        view.put("sessionId", archive.sessionId());
        view.put("runId", archive.runId());
        view.put("source", archive.source());
        view.put("scope", archive.scope());
        view.put("status", archive.status());
        view.put("startedAt", archive.startedAt());
        view.put("endedAt", archive.endedAt());
        view.put("exitCode", archive.exitCode());
        view.put("timeoutSecs", archive.timeoutSecs());
        view.put("cancelReason", archive.cancelReason());
        view.put("backendKind", archive.backendKind());
        view.put("executionMode", archive.executionMode());
        view.put("actorType", archive.actorType());
        view.put("createdAt", archive.createdAt());
        view.put("cleanupStatus", archive.cleanupStatus());
        view.put("errorCode", archive.errorCode());
        return view;
    }

    private static HttpStatus runtimeStatus(int statusCode) {
        HttpStatus status = HttpStatus.resolve(statusCode);
        return status == null || status.is2xxSuccessful() ? HttpStatus.BAD_GATEWAY : status;
    }

    private void markSettled(UUID jobId, String status, String errorCode, String cleanupStatus) {
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("status", status);
        incoming.put("errorCode", errorCode);
        incoming.put("cleanupStatus", cleanupStatus);
        incoming.put("endedAt", java.time.Instant.now().toString());
        jobStateService.upsertById(jobId, incoming);
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
