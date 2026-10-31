package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * MCP tool→server mapping cache plus timeout budget resolution
 * (PLAN-0470 Session/Chat S2: extracted from McpProxyController so the Chat
 * adapter depends on this application component instead of an HTTP adapter).
 *
 * Semantics are unchanged: 5-minute TTL refresh, config-side budget inputs
 * and the run-payload assembly consumed by Agent/Runtime.
 */
@Component
public class McpToolTimeoutService {

    private static final Logger logger = LoggerFactory.getLogger(McpToolTimeoutService.class);
    /** PLAN-0583 决策 #5：默认 5 分钟；覆盖通道只给测试/栈（不进 ConfigService 域、不进 UI）。 */
    static final long DEFAULT_CACHE_TTL_SECONDS = 300L;

    @Value("${cp.mcp.toolmap.ttl-seconds:300}")
    private long cacheTtlSeconds = DEFAULT_CACHE_TTL_SECONDS;

    private final McpServerRepository mcpServers;
    private final ConfigService configService;
    private final ToolTimeoutPolicy toolTimeoutPolicy;
    private final Map<String, Map<String, String>> toolServerCache = new ConcurrentHashMap<>();
    private final Map<String, Instant> cacheTimestamps = new ConcurrentHashMap<>();
    /**
     * PLAN-0583 T1.2：映射世代。整表被替换（TTL 清空或 {@link #putMapping}）即 +1，
     * 供「每 ws 每世代最多一次未命中重建」判定（抑制幻觉工具名的全量扇出放大）。
     * 用 epoch 而非复算时间戳：TTL 清空会把时间戳刷成 now，时间戳无法表达「表被换过」。
     */
    private final Map<String, AtomicLong> mappingEpochs = new ConcurrentHashMap<>();
    /** 该 ws 最近一次未命中重建所锚定的世代；仅与当前世代比较，不参与 TTL 计算。 */
    private final Map<String, Long> rebuiltEpochs = new ConcurrentHashMap<>();
    private final Set<String> warnedRemoteTimeouts = ConcurrentHashMap.newKeySet();

    public McpToolTimeoutService(McpServerRepository mcpServers,
                                 ConfigService configService,
                                 ToolTimeoutPolicy toolTimeoutPolicy) {
        this.mcpServers = mcpServers;
        this.configService = configService;
        this.toolTimeoutPolicy = toolTimeoutPolicy;
    }

    /** TTL 刷新后返回只读视角（未命中为空表）；代理 tools/list、tools/call 与 run payload 共用。 */
    Map<String, String> mappingFor(String wsId) {
        refreshCacheIfNeeded(wsId);
        return toolServerCache.getOrDefault(wsId, Collections.emptyMap());
    }

    /** 返回可变映射（populate 路径写入 SPAWN_AGENT_TOOL 等条目后由调用方 putMapping 固化）。 */
    Map<String, String> mappingForUpdate(String wsId) {
        return toolServerCache.computeIfAbsent(wsId, k -> new ConcurrentHashMap<>());
    }

    void putMapping(String wsId, Map<String, String> mapping) {
        toolServerCache.put(wsId, mapping);
        cacheTimestamps.put(wsId, Instant.now());
        mappingEpochs.computeIfAbsent(wsId, key -> new AtomicLong()).incrementAndGet();
    }

    /**
     * PLAN-0583 T1.2：当前映射世代——`tools/list` 整表固化或 TTL 清空都会让它前进，
     * 因此它标识「这一份映射内容」而不是「离上次刷新多久」。
     */
    long mappingEpoch(String wsId) {
        AtomicLong epoch = mappingEpochs.get(wsId);
        return epoch == null ? 0L : epoch.get();
    }

    /** 同一世代内是否已经做过一次未命中重建（串行与并发都只重建一次）。 */
    boolean rebuiltForCurrentEpoch(String wsId) {
        Long rebuilt = rebuiltEpochs.get(wsId);
        return rebuilt != null && rebuilt == mappingEpoch(wsId);
    }

    /** 记录「当前世代已完成一次未命中重建」；须在重建的 {@link #putMapping} 之后调用。 */
    void markRebuiltForCurrentEpoch(String wsId) {
        rebuiltEpochs.put(wsId, mappingEpoch(wsId));
    }

    /**
     * 配置侧预算输入（spec S1）：remote 行 → {@code tool_timeout_s}；
     * 系统工具 → {@code agent-runtime.systemToolTimeoutS}（决策 #22a/#24）。
     */
    Integer resolveConfigTimeoutSeconds(String wsId, String serverId, String userId) {
        if (serverId != null && !"__system__".equals(serverId)) {
            Optional<McpServer> server = remoteServer(wsId, serverId);
            if (server.isPresent()) {
                Integer configured = server.get().getToolTimeoutS();
                if (configured != null && configured > 0) {
                    if (configured <= ToolTimeoutPolicy.MAX_BUDGET_SECONDS) {
                        return configured;
                    }
                    // T3.1：数据库预算与 per-call 同顶 30s；遗留大值告警一次，并回落到
                    // **系统工具预算**（而非代码默认）——保证 Agent/CP/Runtime 三跳取同一
                    // 来源；此前落 null 会让 Agent 用 systemToolWait 而 CP/Runtime 用默认值，
                    // 内层被外层提前掐断（评审 WARNING）。
                    if (warnedRemoteTimeouts.add(serverId + "=" + configured)) {
                        logger.warn(
                                "Remote MCP server {} tool_timeout_s={} exceeds MAX_BUDGET_SECONDS={}; falling back to system tool budget",
                                serverId, configured, ToolTimeoutPolicy.MAX_BUDGET_SECONDS);
                    }
                }
            }
        }
        return resolveSystemTimeoutSeconds(wsId, userId);
    }

    private Integer resolveSystemTimeoutSeconds(String wsId, String userId) {
        try {
            String raw = configService.resolve(
                    ToolTimeoutPolicy.SYSTEM_TOOL_DOMAIN,
                    ToolTimeoutPolicy.SYSTEM_TOOL_KEY,
                    uuidOrNull(userId),
                    uuidOrNull(wsId));
            return toolTimeoutPolicy.parseConfigSeconds(raw);
        } catch (Exception e) {
            logger.warn("system tool timeout config unavailable: {}", e.getMessage());
            return null;
        }
    }

    /**
     * PLAN-0308 M1（spec S2.1）：为 run payload 组装下发片段——
     * {@code toolWaits}（remote 工具的 Agent 最终值）、{@code toolWaitOrigins}、
     * {@code systemToolWait}（系统工具统一值）、{@code budgetCoverage}（冷缓存可见化，决策 #23）。
     * T1.9 增补：{@code toolTimeouts}（原始 per-call 值，供 Agent 随工具调用附带入站头）。
     * 计算只在 CP；Agent/Runtime 只消费。
     */
    public Map<String, Object> toolTimeoutPayload(
            String wsId, String userId, Map<String, Integer> perCallTimeouts) {
        Map<String, Integer> perCall = perCallTimeouts == null ? Map.of() : perCallTimeouts;
        refreshCacheIfNeeded(wsId);
        Map<String, String> mapping = toolServerCache.getOrDefault(wsId, Collections.emptyMap());
        Map<String, Long> waits = new LinkedHashMap<>();
        Map<String, String> origins = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : mapping.entrySet()) {
            Integer perCallSeconds = perCall.get(entry.getKey());
            Integer configSeconds = resolveConfigTimeoutSeconds(wsId, entry.getValue(), userId);
            if (perCallSeconds == null && configSeconds == null) {
                continue;
            }
            ToolTimeoutPolicy.ToolWaits resolved = toolTimeoutPolicy.resolve(perCallSeconds, configSeconds);
            waits.put(entry.getKey(), resolved.agentSeconds());
            origins.put(entry.getKey(), resolved.origin());
        }
        // per-call 条目可能不在映射里（冷缓存 / 系统工具）：显式补条目，使 Agent 取到 per-call
        // 最终值而不是落回系统工具统一值（决策 #27/#28）。
        for (Map.Entry<String, Integer> entry : perCall.entrySet()) {
            if (waits.containsKey(entry.getKey())) {
                continue;
            }
            ToolTimeoutPolicy.ToolWaits resolved = toolTimeoutPolicy.resolve(entry.getValue(), null);
            waits.put(entry.getKey(), resolved.agentSeconds());
            origins.put(entry.getKey(), resolved.origin());
        }
        Integer systemSeconds = resolveConfigTimeoutSeconds(wsId, "__system__", userId);
        long systemWait = toolTimeoutPolicy.resolve(null, systemSeconds).agentSeconds();

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("toolWaits", waits);
        payload.put("toolWaitOrigins", origins);
        payload.put("systemToolWait", systemWait);
        if (!perCall.isEmpty()) {
            payload.put("toolTimeouts", new LinkedHashMap<>(perCall));
        }
        payload.put("budgetCoverage", mapping.isEmpty() ? "partial" : "full");
        logger.info(
                "[LIFECYCLE] service=cp event=tool_timeout_payload wsId={} tools={} perCall={} systemWait={}s coverage={}",
                wsId, waits.size(), perCall.size(), systemWait, payload.get("budgetCoverage"));
        return payload;
    }

    private Optional<McpServer> remoteServer(String wsId, String serverId) {
        try {
            return mcpServers.findById(UUID.fromString(serverId))
                    .filter(server -> wsId.equals(server.getWorkspaceId()) && server.isEnabled());
        } catch (Exception e) {
            logger.warn("Remote server lookup failed, falling back to stdio: {}", e.getMessage());
            return Optional.empty();
        }
    }

    private static UUID uuidOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private void refreshCacheIfNeeded(String wsId) {
        Instant lastRefresh = cacheTimestamps.get(wsId);
        Duration ttl = Duration.ofSeconds(cacheTtlSeconds);
        if (lastRefresh == null || Duration.between(lastRefresh, Instant.now()).compareTo(ttl) > 0) {
            toolServerCache.remove(wsId);
            toolServerCache.put(wsId, new ConcurrentHashMap<>());
            cacheTimestamps.put(wsId, Instant.now());
            // 表被换成空表也是一代（PLAN-0583）：未命中重建的「每世代一次」判据随之重置。
            mappingEpochs.computeIfAbsent(wsId, key -> new AtomicLong()).incrementAndGet();
        }
    }
}
