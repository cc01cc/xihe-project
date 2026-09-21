package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.entity.OperationExtension;
import com.cc01cc.p.xihe.cp.repository.OperationExtensionRepository;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
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
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0344 T1.2：durable job 账本档案（`job_state` extension v1，挂在 tool_call item 上）。
 *
 * <p>与 {@code appendExtension} 的 append-only 语义不同，job 状态是**可变事实**：
 * 同一 (item, kind, v1) 行按「状态机前进」规则 upsert（running → 终态一次性，
 * 终态不可回退/异终态覆盖），并发写者之间用行锁串行化，撞唯一索引后重试一次。
 *
 * <p>三条回填来源共用 {@link #upsert}：
 * ① MCP start 响应（代理拦截建档案）；② get/cancel 结果同步；③ run 对账兜底。
 *
 * <p>字段与状态机冻结口径见 {@code plans/PLAN-0344-XH-durable-job-continuation/evidence/job-freeze.md}。
 */
@Service
public class JobStateService {

    private static final Logger logger = LoggerFactory.getLogger(JobStateService.class);

    public static final String EXTENSION_KIND = "job_state";
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

    private static final List<String> MERGE_KEYS =
            List.of("jobId", "workspaceId", "scope", "status", "startedAt", "exitCode", "timeoutSecs",
                    "cancelReason", "endedAt", "backendKind", "executionMode", "source", "actorType",
                    "createdAt", "cleanupStatus", "errorCode", "runtimeBootId", "sessionId", "runId");

    private final OperationExtensionRepository extensions;
    private final DbLockTimeout dbLockTimeout;
    private final ObjectMapper objectMapper;
    private final ApplicationContext applicationContext;

    public JobStateService(OperationExtensionRepository extensions,
                           DbLockTimeout dbLockTimeout,
                           ObjectMapper objectMapper,
                           ApplicationContext applicationContext) {
        this.extensions = extensions;
        this.dbLockTimeout = dbLockTimeout;
        this.objectMapper = objectMapper;
        this.applicationContext = applicationContext;
    }

    private JobStateService self() {
        return applicationContext.getBean(JobStateService.class);
    }

    // ── 来源① ②：MCP 工具结果拦截（McpProxyController 调用） ────────────────

    /**
     * 从一次成功的 MCP tools/call 响应里提取 job 事实并 upsert 档案。
     * best-effort：任何解析/落库失败只记日志，绝不影响工具派发本身。
     */
    public void applyToolResult(UUID itemId, String workspaceId, String toolName, String responseBody) {
        if (itemId == null || workspaceId == null || toolName == null || responseBody == null
                || !JOB_TOOLS.contains(toolName)) {
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
                case TOOL_START -> onStartResult(itemId, workspaceId, text);
                case TOOL_GET -> onGetResult(itemId, workspaceId, text);
                case TOOL_CANCEL -> onCancelResult(itemId, workspaceId, text);
                default -> { }
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_sync_failed itemId={} tool={} error={}",
                    itemId, toolName, e.getMessage());
        }
    }

    private void onStartResult(UUID itemId, String workspaceId, String text) {
        String jobId = text == null ? "" : text.trim();
        if (jobId.length() >= 2 && jobId.startsWith("\"") && jobId.endsWith("\"")) {
            jobId = jobId.substring(1, jobId.length() - 1);
        }
        if (jobId.isBlank()) {
            return;
        }
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("jobId", jobId);
        incoming.put("workspaceId", workspaceId);
        incoming.put("status", STATUS_RUNNING);
        incoming.put("scope", SCOPE_SESSION);
        upsert(itemId, incoming);
    }

    private void onGetResult(UUID itemId, String workspaceId, String text) {
        try {
            JsonNode job = objectMapper.readTree(text);
            if (job.isObject()) {
                upsert(itemId, mapJobInfo(job, workspaceId));
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_get_parse_failed itemId={} error={}",
                    itemId, e.getMessage());
        }
    }

    private void onCancelResult(UUID itemId, String workspaceId, String text) {
        String status = text == null ? "" : text.trim().replace("\"", "");
        if (!"cancelled".equals(status)) {
            return;
        }
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("workspaceId", workspaceId);
        incoming.put("status", "cancelled");
        incoming.put("cancelReason", "user_cancel");
        upsert(itemId, incoming);
    }

    // ── 来源③：Runtime 状态（对账兜底 / 端点读） ─────────────────────────────

    /** 把 Runtime `get_background_process` 的 JobInfo 映射成档案增量。 */
    public void syncJobInfo(UUID itemId, String workspaceId, JsonNode job) {
        if (itemId == null || job == null || !job.isObject()) {
            return;
        }
        upsert(itemId, mapJobInfo(job, workspaceId));
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

    /** 增量字段可为 null（表示不修改该字段）。 */
    public void upsert(UUID itemId, Map<String, Object> incoming) {
        if (itemId == null || incoming == null || incoming.isEmpty()) {
            return;
        }
        try {
            self().upsertInNewTx(itemId, incoming);
        } catch (DataIntegrityViolationException race) {
            // 并发首建：赢家已提交，重跑一次走更新路径。
            logger.info("[LIFECYCLE] service=cp event=job_state_create_race itemId={}", itemId);
            try {
                self().upsertInNewTx(itemId, incoming);
            } catch (RuntimeException retryFailure) {
                logger.warn("[LIFECYCLE] service=cp event=job_state_upsert_failed itemId={} error={}",
                        itemId, retryFailure.getMessage());
            }
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_upsert_failed itemId={} error={}",
                    itemId, e.getMessage());
        }
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void upsertInNewTx(UUID itemId, Map<String, Object> incoming) {
        dbLockTimeout.apply();
        OperationExtension existing = extensions
                .findForUpdate(itemId.toString(), EXTENSION_KIND, SCHEMA_VERSION)
                .orElse(null);
        if (existing == null) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("jobId", incoming.get("jobId"));
            payload.put("workspaceId", incoming.get("workspaceId"));
            payload.put("scope", normalizeScope(incoming.get("scope")));
            payload.put("status", incoming.getOrDefault("status", STATUS_RUNNING));
            payload.put("startedAt", incoming.get("startedAt"));
            payload.put("exitCode", incoming.get("exitCode"));
            payload.put("timeoutSecs", incoming.get("timeoutSecs"));
            payload.put("cancelReason", incoming.get("cancelReason"));
            payload.put("endedAt", incoming.get("endedAt"));
            payload.put("backendKind", incoming.get("backendKind"));
            payload.put("executionMode", incoming.get("executionMode"));
            payload.put("source", incoming.get("source"));
            payload.put("actorType", incoming.get("actorType"));
            payload.put("createdAt", incoming.getOrDefault("createdAt", Instant.now().toString()));
            payload.put("cleanupStatus", incoming.getOrDefault("cleanupStatus", "not_started"));
            payload.put("errorCode", incoming.get("errorCode"));
            payload.put("runtimeBootId", incoming.get("runtimeBootId"));
            payload.put("sessionId", incoming.get("sessionId"));
            payload.put("runId", incoming.get("runId"));
            sealTerminal(payload);
            OperationExtension extension = new OperationExtension(itemId.toString(), null,
                    EXTENSION_KIND, SCHEMA_VERSION, writeJson(payload));
            extension.setId(UUID.randomUUID());
            extensions.saveAndFlush(extension);
            logger.info("[LIFECYCLE] service=cp event=job_state_created itemId={} jobId={} status={}",
                    itemId, payload.get("jobId"), payload.get("status"));
            return;
        }
        Map<String, Object> current = readJson(existing.getPayload());
        current.putIfAbsent("scope", SCOPE_SESSION);
        Map<String, Object> merged = mergeForward(current, incoming);
        if (merged == null) {
            logger.warn("[LIFECYCLE] service=cp event=job_state_stale_write_dropped itemId={} current={} incoming={}",
                    itemId, current.get("status"), incoming.get("status"));
            return;
        }
        sealTerminal(merged);
        existing.setPayload(writeJson(merged));
        extensions.saveAndFlush(existing);
        logger.info("[LIFECYCLE] service=cp event=job_state_updated itemId={} jobId={} status={}",
                itemId, merged.get("jobId"), merged.get("status"));
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

    // ── 读路径（端点/对账） ─────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public Optional<JobArchive> find(UUID itemId) {
        if (itemId == null) {
            return Optional.empty();
        }
        return extensions
                .findFirstByItemIdAndExtensionKindOrderBySchemaVersionDesc(itemId.toString(), EXTENSION_KIND)
                .map(extension -> toArchive(itemId, extension));
    }

    /** 对账候选：窗口内创建的 running 档案（按创建时间收窄扫描面）。 */
    @Transactional(readOnly = true)
    public List<JobStateRef> findRunningSince(Instant createdAfter) {
        List<JobStateRef> refs = new ArrayList<>();
        for (OperationExtension extension : extensions
                .findByExtensionKindAndCreatedAtAfter(EXTENSION_KIND, createdAfter)) {
            Map<String, Object> payload = readJson(extension.getPayload());
            if (!STATUS_RUNNING.equals(str(payload.get("status")))) {
                continue;
            }
            String jobId = str(payload.get("jobId"));
            String workspaceId = str(payload.get("workspaceId"));
            if (jobId == null || workspaceId == null) {
                continue;
            }
            refs.add(new JobStateRef(parseUuid(extension.getItemId()), jobId, workspaceId));
        }
        return refs;
    }

    /** Returns whether a durable background job still owns this Workspace. */
    @Transactional(readOnly = true)
    public boolean hasRunningForWorkspace(String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return false;
        }
        Instant since = Instant.now().minus(java.time.Duration.ofDays(30));
        for (OperationExtension extension : extensions
                .findByExtensionKindAndCreatedAtAfter(EXTENSION_KIND, since)) {
            Map<String, Object> payload = readJson(extension.getPayload());
            if (workspaceId.equals(str(payload.get("workspaceId")))
                    && STATUS_RUNNING.equals(str(payload.get("status")))) {
                return true;
            }
        }
        return false;
    }

    /**
     * workspace 销毁时把仍 running 的档案落 orphaned（决策 #4/P1-2）。
     *
     * @param aliveJobIds Runtime 在 destroying 窗口内枚举到的存活 job；null = 枚举失败
     *                    （fail-closed：该 workspace 全部 running 档案都落 orphaned）
     * @return 实际落 orphaned 的档案数
     */
    public int markOrphanedForWorkspace(String workspaceId, Set<String> aliveJobIds) {
        if (workspaceId == null) {
            return 0;
        }
        Instant since = Instant.now().minus(java.time.Duration.ofDays(30));
        int marked = 0;
        for (OperationExtension extension : extensions
                .findByExtensionKindAndCreatedAtAfter(EXTENSION_KIND, since)) {
            Map<String, Object> payload = readJson(extension.getPayload());
            if (!workspaceId.equals(str(payload.get("workspaceId")))
                    || !ACTIVE.contains(str(payload.get("status")))) {
                continue;
            }
            if (aliveJobIds != null && !aliveJobIds.contains(str(payload.get("jobId")))) {
                continue;
            }
            Map<String, Object> incoming = new LinkedHashMap<>();
            incoming.put("status", "orphaned");
            incoming.put("cancelReason", "destroy_orphan");
            upsert(parseUuid(extension.getItemId()), incoming);
            marked++;
        }
        if (marked > 0) {
            logger.info("[LIFECYCLE] service=cp event=job_state_orphaned workspaceId={} count={} enumeration={}",
                    workspaceId, marked, aliveJobIds == null ? "failed" : "ok");
        }
        return marked;
    }

    public record JobStateRef(UUID itemId, String jobId, String workspaceId) { }

    public record JobArchive(String itemId, String jobId, String workspaceId, String scope,
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

    /** Active Job 档案 + durable item identity（scope 收口/对账用）。 */
    public record ActiveJob(UUID itemId, JobArchive archive) { }

    private JobArchive toArchive(UUID itemId, OperationExtension extension) {
        Map<String, Object> payload = readJson(extension.getPayload());
        return new JobArchive(itemId.toString(), str(payload.get("jobId")),
                str(payload.get("workspaceId")), normalizeScope(payload.get("scope")),
                str(payload.get("status")), str(payload.get("startedAt")),
                payload.get("exitCode") instanceof Number number ? number.intValue() : null,
                payload.get("timeoutSecs") instanceof Number number ? number.longValue() : null,
                str(payload.get("cancelReason")), str(payload.get("endedAt")),
                str(payload.get("backendKind")), str(payload.get("executionMode")),
                str(payload.get("source")), str(payload.get("actorType")),
                str(payload.get("createdAt")), str(payload.get("cleanupStatus")),
                str(payload.get("errorCode")), str(payload.get("runtimeBootId")),
                str(payload.get("sessionId")), str(payload.get("runId")));
    }

    /**
     * 该 Workspace 下仍 active（pending/running）的 Job 档案。窗口内扫描，
     * 由调用方决定收口动作（scope 收口 / Workspace destroy / 对账）。
     */
    @Transactional(readOnly = true)
    public List<ActiveJob> findActiveForWorkspace(String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return List.of();
        }
        List<ActiveJob> active = new ArrayList<>();
        for (OperationExtension extension : extensions
                .findByExtensionKindAndCreatedAtAfter(EXTENSION_KIND, scanWindowStart())) {
            Map<String, Object> payload = readJson(extension.getPayload());
            if (!workspaceId.equals(str(payload.get("workspaceId")))) {
                continue;
            }
            JobArchive archive = toArchive(parseUuid(extension.getItemId()), extension);
            if (archive.active()) {
                active.add(new ActiveJob(parseUuid(extension.getItemId()), archive));
            }
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
        List<ActiveJob> active = new ArrayList<>();
        for (OperationExtension extension : extensions
                .findByExtensionKindAndCreatedAtAfter(EXTENSION_KIND, scanWindowStart())) {
            JobArchive archive = toArchive(parseUuid(extension.getItemId()), extension);
            if (!archive.active() || !normalized.equals(archive.scope())) {
                continue;
            }
            String key = switch (normalized) {
                case SCOPE_RUN -> archive.runId();
                case SCOPE_SESSION -> archive.sessionId();
                default -> archive.workspaceId();
            };
            if (boundaryKey.equals(key)) {
                active.add(new ActiveJob(parseUuid(extension.getItemId()), archive));
            }
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
            upsert(job.itemId(), incoming);
            marked++;
        }
        if (marked > 0) {
            logger.info("[LIFECYCLE] service=cp event=job_state_runtime_restart workspaceId={} count={}",
                    workspaceId, marked);
        }
        return marked;
    }

    private static Instant scanWindowStart() {
        return Instant.now().minus(java.time.Duration.ofDays(30));
    }

    // ── 小工具 ─────────────────────────────────────────────────────────────

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
            throw new IllegalStateException("job_state payload serialization failed", e);
        }
    }

    private static String normalizeScope(Object value) {
        String scope = value == null ? SCOPE_SESSION : String.valueOf(value);
        return SCOPES.contains(scope) ? scope : SCOPE_SESSION;
    }

    private static String str(Object value) {
        return value == null ? null : String.valueOf(value);
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

    static boolean isTerminal(String status) {
        return TERMINAL.contains(Objects.toString(status, ""));
    }

    /** PLAN-0344 T1.4：messages DTO 回填 jobSummary 时的工具名过滤。 */
    public static boolean isJobTool(String toolName) {
        return toolName != null && JOB_TOOLS.contains(toolName);
    }
}
