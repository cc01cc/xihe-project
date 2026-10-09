package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJobHistory;
import com.cc01cc.p.xihe.cp.repository.WorkspaceJobRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationContext;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0465 T1.2：Workspace Job durable 状态机（存储迁到 `workspace_jobs`，
 * PLAN-0462 decision #5/#7）。
 *
 * <p>与 append-only 的账本 extension 不同，job 状态是**可变事实**：同一 job 行按
 * 「状态机前进」规则 upsert（running → 终态一次性，终态不可回退/异终态覆盖），
 * 并发写者之间用行锁串行化，撞唯一索引后重试一次。状态每次前进都同步 `status`
 * 查询列与 {@code workspace_job_history}（decision #8）。</p>
 *
 * <p>All reads and writes use the canonical `workspace_jobs.id` or `tool_call_id`;
 * no Ledger or extension fallback remains.</p>
 *
 * <p>字段与状态机冻结口径见
 * {@code plans/PLAN-0344-XH-durable-job-continuation/evidence/job-freeze.md}；
 * 30 天扫描窗取舍见 {@code plans/PLAN-0465-xh-workspace-job-store/evidence/m0-baseline.md}。</p>
 */
@Service
public class JobStateService {

    private static final Logger logger = LoggerFactory.getLogger(JobStateService.class);

    public static final int SCHEMA_VERSION = 1;
    /** Final fresh-baseline scope vocabulary. */
    public static final String SCOPE_RUN = "run";
    public static final String SCOPE_SESSION = "session";
    public static final String SCOPE_WORKSPACE = "workspace";
    private static final Set<String> SCOPES = Set.of(SCOPE_RUN, SCOPE_SESSION, SCOPE_WORKSPACE);

    public static final String STATUS_PENDING = "pending";
    public static final String STATUS_RUNNING = "running";
    /**
     * PLAN-0390 决策 #10：新增 `interrupted` 终态用于 Runtime 重启/启动未确认收口；
     * Docker 既有 `succeeded/timeout/orphaned` 词汇本批不改名（归一化归 0392–0395）。
     */
    public static final String STATUS_INTERRUPTED = "interrupted";
    private static final Set<String> ACTIVE = Set.of(STATUS_PENDING, STATUS_RUNNING);
    private static final Set<String> TERMINAL =
            Set.of("succeeded", "cancelled", "timeout", "orphaned", STATUS_INTERRUPTED);

    /** `cancelReason` 冻结词汇（spec/execution-job-contract.md §Scope 收口）。 */
    public static final String REASON_USER_CANCEL = "user_cancel";
    public static final String REASON_SCOPE_RUN_END = "scope_run_end";
    public static final String REASON_SCOPE_SESSION_STOP = "scope_session_stop";
    public static final String REASON_WORKSPACE_DESTROY = "workspace_destroy";
    public static final String REASON_RUNTIME_RESTART = "runtime_restart";
    public static final String REASON_DESTROY_ORPHAN = "destroy_orphan";
    public static final String REASON_JOB_MISSING = "job_missing";

    private static final String TOOL_START = "start_background_process";
    private static final String TOOL_GET = "get_background_process";
    private static final String TOOL_CANCEL = "cancel_background_process";
    private static final Set<String> JOB_TOOLS = Set.of(TOOL_START, TOOL_GET, TOOL_CANCEL);

    private static final Set<String> SOURCES = Set.of("ui", "agent", "runtime", "system", "mcp");

    private static final List<String> MERGE_KEYS =
            List.of("jobId", "workspaceId", "scope", "status", "startedAt", "exitCode", "timeoutSecs",
                    "cancelReason", "endedAt", "backendKind", "executionMode", "source", "actorType",
                    "createdAt", "cleanupStatus", "errorCode", "runtimeBootId", "sessionId", "runId");

    private final WorkspaceJobRepository jobs;
    private final WorkspaceJobHistoryWriter historyWriter;
    private final DbLockTimeout dbLockTimeout;
    private final ObjectMapper objectMapper;
    private final ApplicationContext applicationContext;

    public JobStateService(WorkspaceJobRepository jobs,
                           WorkspaceJobHistoryWriter historyWriter,
                           DbLockTimeout dbLockTimeout,
                           ObjectMapper objectMapper,
                           ApplicationContext applicationContext) {
        this.jobs = jobs;
        this.historyWriter = historyWriter;
        this.dbLockTimeout = dbLockTimeout;
        this.objectMapper = objectMapper;
        this.applicationContext = applicationContext;
    }

    private JobStateService self() {
        return applicationContext.getBean(JobStateService.class);
    }

    // ── 来源① ②：MCP 工具结果拦截（McpProxyController 调用） ────────────────

    /**
     * MCP tool-call identity and its Workspace/ChatRun ownership from CP dispatch.
     */
    public record ToolJobProvenance(String workspaceId, String userId,
                                    String sessionId, String runId, String toolCallId) { }

    /**
     * 从一次成功的 MCP tools/call 响应里提取 job 事实并 upsert 档案。
     * best-effort：任何解析/落库失败只记日志，绝不影响工具派发本身。
     */
    /** Apply a tool result using the domain provenance from CP dispatch. */
    public void applyToolResult(ToolJobProvenance provenance, String toolName, String responseBody) {
        if (provenance == null || provenance.workspaceId() == null || toolName == null
                || responseBody == null || !JOB_TOOLS.contains(toolName)) {
            return;
        }
        try {
            JsonNode root = objectMapper.readTree(responseBody);
            JsonNode result = root.path("result");
            if (!result.isObject() || result.path("isError").asBoolean(false)) {
                return;
            }
            JsonNode content = result.path("content");
            if (!content.isArray() || content.isEmpty()) {
                return;
            }
            JsonNode textNode = content.get(0).path("text");
            if (textNode.isMissingNode() || textNode.isNull()) {
                return;
            }
            String text = textNode.asText();
            switch (toolName) {
                case TOOL_START -> onStartResult(provenance, text);
                case TOOL_GET -> onGetResult(provenance, text);
                case TOOL_CANCEL -> onCancelResult(provenance, text);
                default -> { }
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_sync_failed toolCallId={} tool={} error={}",
                    provenance.toolCallId(), toolName, e.getMessage());
        }
    }

    private void onStartResult(ToolJobProvenance provenance, String text) {
        String jobId = text == null ? "" : text.trim();
        if (jobId.length() >= 2 && jobId.startsWith("\"") && jobId.endsWith("\"")) {
            jobId = jobId.substring(1, jobId.length() - 1);
        }
        if (jobId.isBlank()) {
            return;
        }
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("jobId", jobId);
        incoming.put("workspaceId", provenance.workspaceId());
        incoming.put("status", STATUS_RUNNING);
        incoming.put("scope", SCOPE_SESSION);
        putIfPresent(incoming, "sessionId", provenance.sessionId());
        putIfPresent(incoming, "runId", provenance.runId());
        putIfPresent(incoming, "toolCallId", provenance.toolCallId());
        upsertWithProvenance(provenance, incoming);
    }

    private void onGetResult(ToolJobProvenance provenance, String text) {
        try {
            JsonNode job = objectMapper.readTree(text);
            if (job.isObject()) {
                upsertWithProvenance(provenance, mapJobInfo(job, provenance.workspaceId()));
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_get_parse_failed toolCallId={} error={}",
                    provenance.toolCallId(), e.getMessage());
        }
    }

    private void onCancelResult(ToolJobProvenance provenance, String text) {
        String status = text == null ? "" : text.trim().replace("\"", "");
        if (!"cancelled".equals(status)) {
            return;
        }
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("workspaceId", provenance.workspaceId());
        incoming.put("status", "cancelled");
        incoming.put("cancelReason", "user_cancel");
        upsertWithProvenance(provenance, incoming);
    }

    // ── 来源③：Runtime 状态（对账兜底 / 端点读） ─────────────────────────────

    /** Sync Runtime JobInfo under the canonical Workspace Job ID. */
    public void syncJobInfoById(UUID workspaceJobId, String workspaceId, JsonNode job) {
        if (workspaceJobId == null || job == null || !job.isObject()) {
            return;
        }
        upsertById(workspaceJobId, mapJobInfo(job, workspaceId));
    }

    private static void putIfPresent(Map<String, Object> target, String key, String value) {
        if (value != null && !value.isBlank()) {
            target.put(key, value);
        }
    }

    private Map<String, Object> mapJobInfo(JsonNode job, String workspaceId) {
        Map<String, Object> incoming = new LinkedHashMap<>();
        String runtimeStatus = job.path("status").asText("");
        String status = mapRuntimeStatus(runtimeStatus);
        if (job.hasNonNull("jobId")) {
            incoming.put("jobId", job.get("jobId").asText());
        }
        if (job.hasNonNull("scope")) {
            incoming.put("scope", normalizeScope(job.get("scope").asText()));
        }
        incoming.put("workspaceId", workspaceId);
        if (status != null) {
            incoming.put("status", status);
        }
        if (job.hasNonNull("exitCode")) {
            incoming.put("exitCode", job.get("exitCode").asInt());
        }
        if (job.hasNonNull("createdAt")) {
            incoming.put("startedAt", job.get("createdAt").asText());
        }
        if (job.hasNonNull("timeoutSecs")) {
            incoming.put("timeoutSecs", job.get("timeoutSecs").asLong());
        }
        if (status != null && TERMINAL.contains(status)) {
            incoming.put("endedAt", Instant.now().toString());
        }
        return incoming;
    }

    /**
     * Runtime 状态 → 档案状态：
     * running/succeeded/cancelled/timeout 同名映射；failed（进程死亡且无终态记录）
     * 收敛为 orphaned（不留悬空 running）；unknown 不落状态（无法判断，保持现值）。
     */
    private String mapRuntimeStatus(String runtimeStatus) {
        return switch (runtimeStatus) {
            case "running" -> "running";
            case "succeeded" -> "succeeded";
            case "cancelled" -> "cancelled";
            case "timeout" -> "timeout";
            case "failed" -> "orphaned";
            default -> null;
        };
    }

    // ── upsert（状态机前进 + 行锁 + 唯一索引兜底） ──────────────────────────

    /**
     * Provenance upsert: resolve by canonical tool-call ID or materialize a new
     * Workspace Job from the dispatch identity.
     */
    public void upsertWithProvenance(ToolJobProvenance provenance, Map<String, Object> incoming) {
        if (provenance == null || incoming == null || incoming.isEmpty()) {
            return;
        }
        try {
            self().upsertWithProvenanceInNewTx(provenance, incoming);
        } catch (DataIntegrityViolationException race) {
            logger.info("[LIFECYCLE] service=cp event=job_state_create_race toolCallId={}",
                    provenance.toolCallId());
            try {
                self().upsertWithProvenanceInNewTx(provenance, incoming);
            } catch (RuntimeException retryFailure) {
                logger.warn("[LIFECYCLE] service=cp event=job_state_upsert_failed toolCallId={} error={}",
                        provenance.toolCallId(), retryFailure.getMessage());
            }
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_upsert_failed toolCallId={} error={}",
                    provenance.toolCallId(), e.getMessage());
        }
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void upsertWithProvenanceInNewTx(ToolJobProvenance provenance,
                                            Map<String, Object> incoming) {
        dbLockTimeout.apply();
        WorkspaceJob row = null;
        UUID toolCallId = parseUuid(provenance.toolCallId());
        if (toolCallId != null) {
            row = jobs.findByToolCallIdForUpdate(toolCallId).orElse(null);
        }
        if (row == null) {
            createFromProvenance(provenance, incoming);
            return;
        }
        applyIncoming(row, incoming);
    }

    /** 同一状态机，按 domain jobId 写入（start 派发回填 / 新路由取消分支）。 */
    public void upsertById(UUID workspaceJobId, Map<String, Object> incoming) {
        if (workspaceJobId == null || incoming == null || incoming.isEmpty()) {
            return;
        }
        try {
            self().upsertByIdInNewTx(workspaceJobId, incoming);
        } catch (DataIntegrityViolationException race) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_upsert_conflict jobId={}",
                    workspaceJobId, race);
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_upsert_failed jobId={}",
                    workspaceJobId, e);
        }
    }

    /** Uses the same canonical writer, but lets a request caller report durable transition failure. */
    public void upsertByIdOrThrow(UUID workspaceJobId, Map<String, Object> incoming) {
        if (workspaceJobId == null || incoming == null || incoming.isEmpty()) {
            throw new IllegalArgumentException("workspaceJobId and incoming state are required");
        }
        self().upsertByIdInNewTx(workspaceJobId, incoming);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void upsertByIdInNewTx(UUID workspaceJobId, Map<String, Object> incoming) {
        dbLockTimeout.apply();
        WorkspaceJob row = jobs.findByIdForUpdate(workspaceJobId)
                .orElseThrow(() -> new IllegalStateException(
                        "workspace_jobs row not found: " + workspaceJobId));
        applyIncoming(row, incoming);
    }

    /**
     * PLAN-0465 T1.1：创建 domain Job 行 + 初始 state + history {@code start}。
     * 无事务注解——由 {@code WorkspaceJobStartService} 的 REQUIRES_NEW 事务调用。
     */
    public WorkspaceJob createJob(WorkspaceJob row, Map<String, Object> initialState) {
        Map<String, Object> payload = initialPayload(initialState, row);
        row.setState(writeJson(payload));
        syncColumns(row, payload);
        jobs.saveAndFlush(row);
        appendHistory(row, null, row.getStatus(), WorkspaceJobHistory.EVENT_START);
        logger.info("[LIFECYCLE] service=cp event=workspace_job_row_created jobId={} status={}",
                row.getId(), row.getStatus());
        return row;
    }

    /** Materialize a Workspace Job from its CP dispatch provenance. */
    private void createFromProvenance(ToolJobProvenance provenance, Map<String, Object> incoming) {
        String workspaceId = str(incoming.get("workspaceId"));
        if (workspaceId == null || workspaceId.isBlank()) {
            workspaceId = provenance.workspaceId();
        }
        if (workspaceId == null || workspaceId.isBlank()) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_workspace_missing toolCallId={}",
                    provenance.toolCallId());
            return;
        }
        String userId = provenance.userId();
        if (userId == null || userId.isBlank()) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_owner_missing toolCallId={}",
                    provenance.toolCallId());
            return;
        }
        String source = str(incoming.get("source"));
        if (source == null || source.isBlank()) {
            source = "mcp";
        }

        WorkspaceJob row = new WorkspaceJob();
        row.setId(UUID.randomUUID());
        row.setWorkspaceId(firstUuid(workspaceId, null));
        row.setUserId(firstUuid(userId, null));
        String sessionPreferred = provenance.sessionId() != null && !provenance.sessionId().isBlank()
                ? provenance.sessionId() : str(incoming.get("sessionId"));
        row.setSessionId(firstUuid(sessionPreferred, null));
        String runPreferred = provenance.runId() != null && !provenance.runId().isBlank()
                ? provenance.runId() : str(incoming.get("runId"));
        row.setRunId(firstUuid(runPreferred, null));
        row.setToolCallId(firstUuid(provenance.toolCallId(), null));
        row.setSource(normalizeSource(source));
        row.setScope(normalizeScope(incoming.get("scope")));

        Map<String, Object> payload = initialPayload(incoming, row);
        row.setState(writeJson(payload));
        syncColumns(row, payload);
        jobs.saveAndFlush(row);
        appendHistory(row, null, row.getStatus(), WorkspaceJobHistory.EVENT_START);
        logger.info("[LIFECYCLE] service=cp event=job_state_created jobId={} toolCallId={} runId={} status={}",
                payload.get("jobId"), row.getToolCallId(), row.getRunId(), row.getStatus());
    }

    /** 状态前进 + 落库 + history（调用方必须已持有行锁）。 */
    private void applyIncoming(WorkspaceJob row, Map<String, Object> incoming) {
        Map<String, Object> current = readJson(row.getState());
        current.putIfAbsent("scope", SCOPE_SESSION);
        Map<String, Object> merged = mergeForward(current, incoming);
        if (merged == null) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_stale_write_dropped jobId={} current={} incoming={}",
                    row.getId(), current.get("status"), incoming.get("status"));
            return;
        }
        sealTerminal(merged);
        String before = row.getStatus();
        row.setState(writeJson(merged));
        syncColumns(row, merged);
        jobs.saveAndFlush(row);
        String after = row.getStatus();
        if (!Objects.equals(before, after)) {
            appendHistory(row, before, after, historyEvent(after));
        }
        logger.info("[LIFECYCLE] service=cp event=job_state_updated jobId={} runtimeJobId={} status={}",
                row.getId(), row.getRuntimeJobId(), after);
    }

    private void appendHistory(WorkspaceJob row, String fromStatus, String toStatus, String eventType) {
        if (eventType == null || toStatus == null) {
            return;
        }
        historyWriter.append(row.getId(), eventType, fromStatus, toStatus,
                row.getCancelReason(), row.getErrorCode(), null);
    }

    /**
     * 状态前进规则：running → 任意终态；终态只允许同态重复写（补 exitCode/endedAt）；
     * 终态不得回退为 running，也不得改写成另一终态。返回 null = 丢弃该写入。
     */
    private Map<String, Object> mergeForward(Map<String, Object> current, Map<String, Object> incoming) {
        String currentStatus = str(current.get("status"));
        String nextStatus = incoming.containsKey("status") ? str(incoming.get("status")) : null;
        if (nextStatus != null) {
            if (TERMINAL.contains(currentStatus) && !currentStatus.equals(nextStatus)) {
                return null;
            }
            if (!TERMINAL.contains(currentStatus) && !TERMINAL.contains(nextStatus)
                    && !STATUS_RUNNING.equals(nextStatus)) {
                return null;
            }
        }
        Map<String, Object> merged = new LinkedHashMap<>(current);
        for (String key : MERGE_KEYS) {
            Object value = incoming.get(key);
            if (value != null) {
                merged.put(key, value);
            }
        }
        return merged;
    }

    private void sealTerminal(Map<String, Object> payload) {
        if (TERMINAL.contains(str(payload.get("status"))) && payload.get("endedAt") == null) {
            payload.put("endedAt", Instant.now().toString());
        }
    }

    // ── 读路径（端点/对账/list） ────────────────────────────────────────────

    /** Read a Job archive by canonical domain jobId. */
    @Transactional(readOnly = true)
    public Optional<JobArchive> findByJobId(UUID workspaceJobId) {
        if (workspaceJobId == null) {
            return Optional.empty();
        }
        return jobs.findById(workspaceJobId).map(this::toArchive);
    }

    /**
     * 新路由归属读：domain jobId + workspace 归属必须同时命中（否则空，
     * 调用方折叠为 404，不泄露跨 Workspace 存在性）。
     */
    @Transactional(readOnly = true)
    public Optional<JobArchive> findOwned(UUID workspaceJobId, String workspaceId) {
        if (workspaceJobId == null || workspaceId == null || workspaceId.isBlank()) {
            return Optional.empty();
        }
        WorkspaceJob row = jobs.findById(workspaceJobId).orElse(null);
        if (row == null || !workspaceId.equals(row.getWorkspaceId().toString())) {
            return Optional.empty();
        }
        return Optional.of(toArchive(row));
    }

    /**
     * 对账候选：窗口内创建的 running 行（`created_at` btree 收窄）。
     * 扫描窗取舍记录见 evidence/m0-baseline.md：extension 全表扫的 30 天固定窗
     * 由调用方窗口（JobReconciliationService 默认 168h）+ 行级索引取代。
     */
    @Transactional(readOnly = true)
    public List<JobStateRef> findRunningSince(Instant createdAfter) {
        List<JobStateRef> refs = new ArrayList<>();
        for (WorkspaceJob row : jobs.findByStatusAndCreatedAtAfter(STATUS_RUNNING, createdAfter)) {
            if (row.getRuntimeJobId() == null || row.getRuntimeJobId().isBlank()) {
                continue;
            }
            refs.add(new JobStateRef(row.getId(), row.getRuntimeJobId(), row.getWorkspaceId().toString()));
        }
        return refs;
    }

    /**
     * Returns whether a durable background job still owns this Workspace.
     *
     * <p>PLAN-0465 30 天窗重审：extension 时代靠 created_at 窗口兜住无索引的
     * payload 扫描；迁到 `workspace_jobs` 后 `(workspace_id, …)` 为索引等值探针，
     * **窗口取消**——超过 30 天仍 active 的 Job 重新计入删除/切换保护
     * （数据完整性缺口关闭，取舍记录见 evidence/m0-baseline.md）。</p>
     */
    @Transactional(readOnly = true)
    public boolean hasRunningForWorkspace(String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return false;
        }
        UUID id = parseUuid(workspaceId);
        return id != null && jobs.existsByWorkspaceIdAndStatusIn(id, ACTIVE);
    }

    /**
     * workspace 销毁时把仍 active 的档案落 orphaned（决策 #4/P1-2）。
     *
     * @param aliveJobIds Runtime 在 destroying 窗口内枚举到的存活 job；null = 枚举失败
     *                    （fail-closed：该 workspace 全部 active 档案都落 orphaned）
     * @return 实际落 orphaned 的档案数
     */
    public int markOrphanedForWorkspace(String workspaceId, Set<String> aliveJobIds) {
        if (workspaceId == null) {
            return 0;
        }
        UUID id = parseUuid(workspaceId);
        if (id == null) {
            return 0;
        }
        int marked = 0;
        for (WorkspaceJob row : jobs.findByWorkspaceIdAndStatusInOrderByCreatedAtAsc(id, ACTIVE)) {
            if (aliveJobIds != null && (row.getRuntimeJobId() == null
                    || !aliveJobIds.contains(row.getRuntimeJobId()))) {
                continue;
            }
            Map<String, Object> incoming = new LinkedHashMap<>();
            incoming.put("status", "orphaned");
            incoming.put("cancelReason", "destroy_orphan");
            upsertById(row.getId(), incoming);
            marked++;
        }
        if (marked > 0) {
            logger.info("[LIFECYCLE] service=cp event=job_state_orphaned workspaceId={} count={} enumeration={}",
                    workspaceId, marked, aliveJobIds == null ? "failed" : "ok");
        }
        return marked;
    }

    /**
     * Reconciliation identity is the Workspace Job ID; `jobId` is the Runtime handle.
     */
    public record JobStateRef(UUID workspaceJobId, String jobId, String workspaceId) { }

    public record JobArchive(String jobId, String workspaceId, String scope,
                             String status, String startedAt, Integer exitCode, Long timeoutSecs,
                             String cancelReason, String endedAt,
                             String backendKind, String executionMode, String source, String actorType,
                             String createdAt, String cleanupStatus, String errorCode,
                             String runtimeBootId, String sessionId, String runId) {

        public boolean terminal() {
            return TERMINAL.contains(status);
        }

        public boolean active() {
            return status != null && ACTIVE.contains(status);
        }
    }

    /** Active Job archive plus its canonical domain write key. */
    public record ActiveJob(UUID workspaceJobId, JobArchive archive) { }

    JobArchive toArchive(WorkspaceJob row) {
        Map<String, Object> payload = readJson(row.getState());
        return new JobArchive(
                row.getRuntimeJobId(),
                row.getWorkspaceId().toString(),
                row.getScope(),
                row.getStatus(),
                str(payload.get("startedAt")),
                payload.get("exitCode") instanceof Number number ? number.intValue() : null,
                payload.get("timeoutSecs") instanceof Number number ? number.longValue() : null,
                row.getCancelReason(),
                row.getEndedAt() == null ? str(payload.get("endedAt")) : row.getEndedAt().toString(),
                str(payload.get("backendKind")), str(payload.get("executionMode")),
                row.getSource(), str(payload.get("actorType")),
                row.getCreatedAt() == null ? str(payload.get("createdAt"))
                        : row.getCreatedAt().toString(),
                str(payload.get("cleanupStatus")),
                row.getErrorCode(), str(payload.get("runtimeBootId")),
                row.getSessionId() == null ? null : row.getSessionId().toString(),
                row.getRunId() == null ? null : row.getRunId().toString());
    }

    /**
     * 该 Workspace 下仍 active（pending/running）的行。
     * 由调用方决定收口动作（scope 收口 / Workspace destroy / 对账）。
     */
    @Transactional(readOnly = true)
    public List<ActiveJob> findActiveForWorkspace(String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return List.of();
        }
        UUID id = parseUuid(workspaceId);
        if (id == null) {
            return List.of();
        }
        List<ActiveJob> active = new ArrayList<>();
        for (WorkspaceJob row : jobs.findByWorkspaceIdAndStatusInOrderByCreatedAtAsc(id, ACTIVE)) {
            active.add(new ActiveJob(row.getId(), toArchive(row)));
        }
        return active;
    }

    /**
     * 按 scope + 边界键过滤 active Job：
     * {@code run} 用 runId、{@code session} 用 sessionId、{@code workspace} 用 workspaceId。
     */
    @Transactional(readOnly = true)
    public List<ActiveJob> findActiveForScope(String scope, String boundaryKey) {
        String normalized = normalizeScope(scope);
        if (boundaryKey == null || boundaryKey.isBlank()) {
            return List.of();
        }
        UUID key = parseUuid(boundaryKey);
        if (key == null) {
            return List.of();
        }
        List<WorkspaceJob> rows = switch (normalized) {
            case SCOPE_RUN -> jobs.findByScopeAndRunIdAndStatusIn(normalized, key, ACTIVE);
            case SCOPE_WORKSPACE -> jobs.findByScopeAndWorkspaceIdAndStatusIn(normalized, key, ACTIVE);
            default -> jobs.findByScopeAndSessionIdAndStatusIn(normalized, key, ACTIVE);
        };
        List<ActiveJob> active = new ArrayList<>();
        for (WorkspaceJob row : rows) {
            active.add(new ActiveJob(row.getId(), toArchive(row)));
        }
        return active;
    }

    /**
     * Runtime 重启对账：把记录过旧 {@code runtimeBootId} 的 active Job 落
     * {@code interrupted}（不重放）。返回实际收口数。
     */
    public int markInterruptedForRuntimeRestart(String workspaceId, String currentBootId) {
        if (workspaceId == null || currentBootId == null || currentBootId.isBlank()) {
            return 0;
        }
        int marked = 0;
        for (ActiveJob job : findActiveForWorkspace(workspaceId)) {
            String recorded = job.archive().runtimeBootId();
            if (recorded == null || recorded.isBlank() || currentBootId.equals(recorded)) {
                continue;
            }
            Map<String, Object> incoming = new LinkedHashMap<>();
            incoming.put("status", STATUS_INTERRUPTED);
            incoming.put("cancelReason", REASON_RUNTIME_RESTART);
            incoming.put("errorCode", "RUNTIME_RESTART");
            incoming.put("cleanupStatus", "failed");
            if (job.workspaceJobId() == null) {
                continue;
            }
            // The Workspace Job domain ID is the durable write key.
            upsertById(job.workspaceJobId(), incoming);
            marked++;
        }
        if (marked > 0) {
            logger.info("[LIFECYCLE] service=cp event=job_state_runtime_restart workspaceId={} count={}",
                    workspaceId, marked);
        }
        return marked;
    }

    // ── Wire 投影 / 幂等 / Message jobSummary（PLAN-0465） ──────────────────

    /** Workspace Job list（新表，按创建时间倒序）。 */
    @Transactional(readOnly = true)
    public List<Map<String, Object>> listView(String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return List.of();
        }
        UUID id = parseUuid(workspaceId);
        if (id == null) {
            return List.of();
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (WorkspaceJob row : jobs.findByWorkspaceIdOrderByCreatedAtDesc(id)) {
            result.add(wireView(row));
        }
        return result;
    }

    @Transactional(readOnly = true)
    public Optional<Map<String, Object>> wireViewById(UUID workspaceJobId) {
        if (workspaceJobId == null) {
            return Optional.empty();
        }
        return jobs.findById(workspaceJobId).map(this::wireView);
    }

    /**
     * PLAN-0465 decision #7 wire：`jobId` = domain 身份（新表 id），
     * `runtimeJobId` = Runtime backend handle（原 wire `jobId` 的值，供输出目录
     * 操作/诊断使用）。
     */
    public Map<String, Object> wireView(WorkspaceJob row) {
        Map<String, Object> payload = readJson(row.getState());
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("jobId", row.getId().toString());
        view.put("runtimeJobId", row.getRuntimeJobId());
        view.put("workspaceId", row.getWorkspaceId().toString());
        view.put("sessionId", row.getSessionId() == null ? null : row.getSessionId().toString());
        view.put("runId", row.getRunId() == null ? null : row.getRunId().toString());
        view.put("source", row.getSource());
        view.put("scope", row.getScope());
        view.put("status", row.getStatus());
        view.put("startedAt", str(payload.get("startedAt")));
        view.put("endedAt", row.getEndedAt() == null ? str(payload.get("endedAt"))
                : row.getEndedAt().toString());
        view.put("exitCode", payload.get("exitCode") instanceof Number number ? number.intValue() : null);
        view.put("timeoutSecs", payload.get("timeoutSecs") instanceof Number number
                ? number.longValue() : null);
        view.put("cancelReason", row.getCancelReason());
        view.put("backendKind", str(payload.get("backendKind")));
        view.put("executionMode", str(payload.get("executionMode")));
        view.put("actorType", str(payload.get("actorType")));
        view.put("createdAt", row.getCreatedAt() == null ? str(payload.get("createdAt"))
                : row.getCreatedAt().toString());
        view.put("cleanupStatus", str(payload.get("cleanupStatus")));
        view.put("errorCode", row.getErrorCode());
        return view;
    }

    /** 幂等重读（V36 语义迁入）：session 绑定走 (user, session, key)，session-less 走 (user, workspace, key)。 */
    @Transactional(readOnly = true)
    public Optional<WorkspaceJob> findForReplay(String userId, String workspaceId,
                                                String sessionId, String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return Optional.empty();
        }
        UUID user = parseUuid(userId);
        UUID workspace = parseUuid(workspaceId);
        if (user == null || workspace == null) {
            return Optional.empty();
        }
        if (sessionId == null || sessionId.isBlank()) {
            return jobs.findSessionLessByKey(user, workspace, idempotencyKey);
        }
        UUID session = parseUuid(sessionId);
        if (session == null) {
            return Optional.empty();
        }
        return jobs.findByUserIdAndSessionIdAndIdempotencyKey(user, session, idempotencyKey);
    }

    /** PLAN-0465 T2.2：Message jobSummary 源（run → domain 行，按创建时间升序）。 */
    @Transactional(readOnly = true)
    public List<WorkspaceJob> listByRun(String runId) {
        if (runId == null || runId.isBlank()) {
            return List.of();
        }
        UUID id = parseUuid(runId);
        if (id == null) {
            return List.of();
        }
        return jobs.findByRunIdOrderByCreatedAtAsc(id);
    }

    // ── 小工具 ─────────────────────────────────────────────────────────────

    private Map<String, Object> initialPayload(Map<String, Object> incoming, WorkspaceJob row) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("jobId", incoming.get("jobId"));
        payload.put("workspaceId", row.getWorkspaceId().toString());
        payload.put("scope", normalizeScope(incoming.get("scope") != null
                ? incoming.get("scope") : row.getScope()));
        payload.put("status", incoming.getOrDefault("status", STATUS_RUNNING));
        payload.put("startedAt", incoming.get("startedAt"));
        payload.put("exitCode", incoming.get("exitCode"));
        payload.put("timeoutSecs", incoming.get("timeoutSecs"));
        payload.put("cancelReason", incoming.get("cancelReason"));
        payload.put("endedAt", incoming.get("endedAt"));
        payload.put("backendKind", incoming.get("backendKind"));
        payload.put("executionMode", incoming.get("executionMode"));
        payload.put("source", incoming.getOrDefault("source", row.getSource()));
        payload.put("actorType", incoming.get("actorType"));
        payload.put("createdAt", incoming.getOrDefault("createdAt", Instant.now().toString()));
        payload.put("cleanupStatus", incoming.getOrDefault("cleanupStatus", "not_started"));
        payload.put("errorCode", incoming.get("errorCode"));
        payload.put("runtimeBootId", incoming.get("runtimeBootId"));
        payload.put("sessionId", row.getSessionId() == null ? str(incoming.get("sessionId"))
                : row.getSessionId().toString());
        payload.put("runId", row.getRunId() == null ? str(incoming.get("runId"))
                : row.getRunId().toString());
        sealTerminal(payload);
        return payload;
    }

    /** state 查询列镜像：status / scope / cancel_reason / error_code / 时间 / runtime handle。 */
    private static void syncColumns(WorkspaceJob row, Map<String, Object> state) {
        String status = str(state.get("status"));
        if (status != null) {
            row.setStatus(status);
        }
        row.setScope(normalizeScope(state.get("scope")));
        row.setCancelReason(str(state.get("cancelReason")));
        row.setErrorCode(str(state.get("errorCode")));
        row.setRuntimeJobId(str(state.get("jobId")));
        row.setStartedAt(instantOrNull(str(state.get("startedAt"))));
        row.setEndedAt(instantOrNull(str(state.get("endedAt"))));
    }

    private static String historyEvent(String status) {
        if (status == null) {
            return null;
        }
        return switch (status) {
            case STATUS_RUNNING -> WorkspaceJobHistory.EVENT_RUNNING;
            case "succeeded", "timeout" -> WorkspaceJobHistory.EVENT_SETTLE;
            case "cancelled" -> WorkspaceJobHistory.EVENT_CANCEL;
            case "orphaned" -> WorkspaceJobHistory.EVENT_ORPHANED;
            case STATUS_INTERRUPTED -> WorkspaceJobHistory.EVENT_INTERRUPTED;
            default -> null;
        };
    }

    private static String normalizeSource(String source) {
        if (source == null || source.isBlank()) {
            return "system";
        }
        String normalized = source.trim().toLowerCase(Locale.ROOT);
        return SOURCES.contains(normalized) ? normalized : "system";
    }

    private Map<String, Object> readJson(String json) {
        if (json == null || json.isBlank()) {
            return new LinkedHashMap<>();
        }
        try {
            return objectMapper.readValue(json, new com.fasterxml.jackson.core.type.TypeReference<>() { });
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_payload_unparseable error={}", e.getMessage());
            return new LinkedHashMap<>();
        }
    }

    private String writeJson(Map<String, Object> payload) {
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            throw new IllegalStateException("workspace_jobs state serialization failed", e);
        }
    }

    private static String normalizeScope(Object value) {
        String scope = value == null ? SCOPE_SESSION : String.valueOf(value);
        return SCOPES.contains(scope) ? scope : SCOPE_SESSION;
    }

    private static String str(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static UUID firstUuid(String preferred, String fallback) {
        UUID value = parseUuid(preferred);
        return value != null ? value : parseUuid(fallback);
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

    private static Instant instantOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(value);
        } catch (Exception e) {
            return null;
        }
    }

    static boolean isTerminal(String status) {
        return TERMINAL.contains(Objects.toString(status, ""));
    }

    /** PLAN-0344 T1.4：messages DTO 回填 jobSummary 时的工具名过滤。 */
    public static boolean isJobTool(String toolName) {
        return toolName != null && JOB_TOOLS.contains(toolName);
    }
}
