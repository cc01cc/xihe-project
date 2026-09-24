package com.cc01cc.p.xihe.cp.mcp;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.annotation.Value;
import jakarta.annotation.PostConstruct;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.entity.McpStdioServer;
import com.cc01cc.p.xihe.cp.entity.McpToolAlias;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.operation.OperationPolicySummary;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationItem;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

@RestController
public class McpProxyController {

    private static final Logger logger = LoggerFactory.getLogger(McpProxyController.class);
    private static final Duration CACHE_TTL = Duration.ofMinutes(5);
    private static final String HMAC_ALGORITHM = "HmacSHA256";

    @Value("${cp.mcp.session-id.hmac-secret}")
    private String sessionIdHmacSecret;
    private static final String REMOTE_SCOPE = "mcp:tools";
    /** T1.7/T1.9 post-gate approval lifetime: the durable row expires after five minutes. */
    private static final long APPROVAL_REQUEST_TTL_SECONDS = 300;
    /**
     * T1.9 answerer rejection: implementation-defined JSON-RPC error code (never {@code -32003}).
     * The Agent's gate classifier keys on {@code APPROVAL_REQUIRED}, so this denial follows the
     * normal fail-closed tool-error path instead of registering a waiter.
     */
    private static final int APPROVAL_REJECTED_JSONRPC_CODE = -32004;
    /** Safe wire code of an immediate answerer rejection (Agent audit/log correlation). */
    private static final String APPROVAL_REJECTED_CODE = "APPROVAL_REJECTED";
    /**
     * PLAN-0308 M2（决策 #34）：逻辑 MCP 的协议版本与语义固定为无会话世代——
     * 不透传调用方声明的版本（Agent 侧 SDK 目前只能声明 2025-11-25，会导致
     * Runtime 走有会话/可恢复路径并开启事件重放）。
     */
    private static final String STATELESS_PROTOCOL_VERSION = "2026-07-28";
    /** PLAN-0308（spec S2.2 规则 5 + 决策 #31）：只由 CP 写入的出站策略头。 */
    private static final List<String> OUTBOUND_POLICY_HEADERS = List.of(
            "X-Xihe-Tool-Timeout-S", "X-Xihe-Tool-Timeout-Origin", "X-Xihe-Tool-Output-Limit");
    /** PLAN-0344 T1.2：job 工具集（结果需同步到 job_state 档案）。 */
    private static final Set<String> JOB_TOOLS = Set.of(
            "start_background_process", "get_background_process", "cancel_background_process");
    /**
     * PLAN-0373 决策 #9（supersede #5「全 tools/call」字面）：job 时限注入面 =
     * 仅 {@code start_background_process}（job 工具面）每次覆写；其他工具完全不碰 body
     * （{@code execute_command}/{@code web_fetch} 共享 {@code timeout} 键会被注入改写语义，
     * remote MCP {@code additionalProperties:false} 可能拒收注入键）。
     */
    static final String JOB_TIMEOUT_TOOL = "start_background_process";
    /** PLAN-0373 (BL-22) job 运行时限配置域与键（决策 #7 命名冻结）。 */
    static final String JOB_POLICY_DOMAIN = "job-policy";
    static final String JOB_DEFAULT_TIMEOUT_KEY = "defaultTimeoutSecs";
    static final String JOB_MAX_TIMEOUT_KEY = "maxTimeoutSecs";
    /**
     * PLAN-0373 decision #8 代码默认（须与 {@code ConfigService.CODE_DEFAULTS} 的
     * job-policy 条目保持一致）：默认 3600s；上限 0 = 未设上限（不钳制）。
     */
    static final long JOB_CODE_DEFAULT_TIMEOUT_SECS = 3600L;
    static final long JOB_CODE_MAX_TIMEOUT_SECS = 0L;

    private final HttpClient httpClient;

    // PLAN-301 M1: forward-hop timeout, decoupled from the agent-side tool
    // execution timeout (semantically different layers: CP waiting on the
    // upstream vs the tool actually running). Env-configurable so cold
    // proxies can be given room without a recompile.
    @org.springframework.beans.factory.annotation.Value("${xihe.mcp.forward-timeout-s:30}")
    private long forwardTimeoutS;

    @PostConstruct
    void validateSessionIdHmacSecret() {
        if (sessionIdHmacSecret == null || sessionIdHmacSecret.isBlank()) {
            throw new IllegalStateException("XIHE_MCP_SESSION_ID_HMAC_SECRET must be configured");
        }
    }
    /** T3.1 评审修复：遗留超限 remote 配置只告警一次，避免逐请求重复刷 WARN。 */
    private final Set<String> warnedRemoteTimeouts = ConcurrentHashMap.newKeySet();
    private final RequestRewriter rewriter;
    private final PolicyEngine policy;
    private final AuditLogger audit;
    private final ApprovalService approvalService;
    private final ObjectMapper objectMapper;
    private final SseEmitterManager sse;
    private final McpStdioServerRepository stdioServers;
    private final McpServerRepository mcpServers;
    private final McpToolAliasRepository aliases;
    private final ConfigService configService;
    private final ToolTimeoutPolicy toolTimeoutPolicy;
    private final org.springframework.core.env.Environment environment;
    private final Map<String, AtomicLong> toolGenerations = new ConcurrentHashMap<>();

    @Value("${cp.mcp.runtime-url:http://localhost:12633}")
    private String runtimeBaseUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String runtimeServiceToken;

    private final Map<String, Map<String, String>> toolServerCache = new ConcurrentHashMap<>();
    private final Map<String, Instant> cacheTimestamps = new ConcurrentHashMap<>();
    private final Map<String, String> runtimeSessionByGatewaySession = new ConcurrentHashMap<>();
    private final Map<String, McpSessionBinding> mcpSessionBindings = new ConcurrentHashMap<>();
    private final WorkspaceService workspaceService;
    private final SessionRepository sessionRepository;
    private final OperationService operationService;
    private final JobStateService jobStateService;

    public McpProxyController(
            RequestRewriter rewriter,
            PolicyEngine policy,
            AuditLogger audit,
            ApprovalService approvalService,
            ObjectMapper objectMapper,
            SseEmitterManager sse,
            McpStdioServerRepository stdioServers,
            McpServerRepository mcpServers,
            McpToolAliasRepository aliases,
            WorkspaceService workspaceService,
            SessionRepository sessionRepository,
            OperationService operationService,
            JobStateService jobStateService,
            ConfigService configService,
            ToolTimeoutPolicy toolTimeoutPolicy,
            org.springframework.core.env.Environment environment) {
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        this.rewriter = rewriter;
        this.policy = policy;
        this.audit = audit;
        this.approvalService = approvalService;
        this.objectMapper = objectMapper;
        this.sse = sse;
        this.stdioServers = stdioServers;
        this.mcpServers = mcpServers;
        this.aliases = aliases;
        this.workspaceService = workspaceService;
        this.sessionRepository = sessionRepository;
        this.operationService = operationService;
        this.jobStateService = jobStateService;
        this.configService = configService;
        this.toolTimeoutPolicy = toolTimeoutPolicy;
        this.environment = environment;
    }

    @PostMapping("/api/v1/mcp")
    public ResponseEntity<String> proxy(
            @RequestBody String body,
            @RequestHeader HttpHeaders headers) {

        // PLAN-0308 M1（spec S2.2 规则 5 信任边界）：`-S`/`-Origin` 两个出站头只由 CP 设置——
        // 入站一律先剥离上游同名头（含伪造值），随后仅 handleToolsCall 按预算重新写入。
        // 入站 per-call 头不在此剥离：它是合法的调用方请求，由 handleToolsCall 校验后采纳。
        headers = stripOutboundPolicyHeaders(headers);
        String method = extractMethod(body);
        AuthorizationResult authorization = authorize(headers, body, "initialize".equals(method));
        if (!authorization.allowed()) {
            return authorization.failure();
        }
        AccessContext access = authorization.context();
        String sessionId = access.auditSessionId();
        String wsId = access.workspaceId();

        if ("initialize".equals(method)) {
            return handleInitialize(wsId, body, headers, sessionId, access);
        }
        if ("tools/list".equals(method)) {
            return handleToolsList(wsId, body, headers, sessionId, access);
        }
        if ("tools/call".equals(method)) {
            return handleToolsCall(wsId, body, headers, sessionId, access);
        }
        return forwardToRuntime(wsId, null, body, headers, sessionId, access);
    }

    /**
     * PLAN-0308 M2（决策 #34）：逻辑 MCP 按**无会话**语义服务（2026-07-28 世代）。
     * 服务端主动推送（GET SSE）在本代理上不存在——直接拒绝，不再转发 Runtime。
     * 客户端若因旧版本协商期待该通道，会得到明确的 405 而不是被挂住的空流。
     */
    @GetMapping("/api/v1/mcp")
    public ResponseEntity<String> stream(@RequestHeader HttpHeaders headers) {
        AuthorizationResult authorization = authorize(headers, null, false);
        if (!authorization.allowed()) {
            return authorization.failure();
        }
        audit.record(authorization.context().auditSessionId(), "mcp/stream", "reject",
                "stateless logical MCP: no server-initiated stream");
        return problem(HttpStatus.METHOD_NOT_ALLOWED, "MCP_STREAM_NOT_SUPPORTED",
                "The logical MCP endpoint is stateless and does not serve a server-initiated stream");
    }

    /** 决策 #34：无会话 ⇒ 没有可终止的协议会话，DELETE 同样明确拒绝。 */
    @DeleteMapping("/api/v1/mcp")
    public ResponseEntity<String> disconnect(@RequestHeader HttpHeaders headers) {
        AuthorizationResult authorization = authorize(headers, null, false);
        if (!authorization.allowed()) {
            return authorization.failure();
        }
        audit.record(authorization.context().auditSessionId(), "mcp/disconnect", "reject",
                "stateless logical MCP: no protocol session");
        return problem(HttpStatus.METHOD_NOT_ALLOWED, "MCP_SESSION_NOT_SUPPORTED",
                "The logical MCP endpoint is stateless; there is no protocol session to terminate");
    }

    private ResponseEntity<String> handleInitialize(
            String wsId, String body, HttpHeaders headers, String sessionId, AccessContext access) {
        String token = extractBearerToken(headers);
        if (token == null) {
            return problem(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authorization required");
        }
        return forwardToRuntime(wsId, null, body, headers, sessionId, access);
    }

    private ResponseEntity<String> handleToolsList(
            String wsId, String body, HttpHeaders headers, String sessionId, AccessContext access) {
        refreshCacheIfNeeded(wsId);
        Map<String, String> mapping = toolServerCache.getOrDefault(wsId, Collections.emptyMap());

        try {
            List<Map<String, Object>> allTools = new ArrayList<>(populateSystemTools(wsId, headers, access));

            // 2. Call each STDIO server's tools/list
            Set<String> seenNames = new HashSet<>();
            for (Map.Entry<String, String> entry : mapping.entrySet()) {
                if ("__system__".equals(entry.getValue())) {
                    seenNames.add(entry.getKey());
                }
            }

            // PLAN-0307 decision #27: stdio carriers come from mcp_stdio_servers.
            List<McpStdioServer> stdio = new ArrayList<>();
            try {
                stdio.addAll(stdioServers.findByWorkspaceIdOrderByNameAsc(wsId));
            } catch (Exception e) {
                logger.warn("Stdio server list failed, skipping stdio merge: {}", e.getMessage());
            }
            for (McpStdioServer server : stdio) {
                if (!server.isEnabled()) {
                    continue;
                }
                String serverId = server.getName();
                ResponseEntity<String> stdioResp = forwardToRuntime(
                        wsId, serverId, body, headers, sessionId, access);
                mergeStdioServerTools(wsId, serverId, stdioResp, mapping, allTools, seenNames);
            }

            // PLAN-242 M2: merge enabled remote servers (sorted for determinism),
            // then sticky-issue names and persist alias rows (never promoted).
            long generation = nextGeneration(wsId);
            Map<String, McpToolAlias> known = new HashMap<>();
            try {
                for (McpToolAlias alias : aliases.findByWorkspaceId(UUID.fromString(wsId))) {
                    known.put(alias.getServerId() + "\0" + alias.getBackendName(), alias);
                }
            } catch (Exception e) {
                logger.warn("Tool alias load failed, continuing without stickiness: {}", e.getMessage());
            }
            List<McpServer> remotes = new ArrayList<>();
            try {
                remotes.addAll(mcpServers.findByWorkspaceIdAndEnabledTrue(wsId));
            } catch (Exception e) {
                logger.warn("Remote server list failed, skipping remote merge: {}", e.getMessage());
            }
            remotes.sort(Comparator.comparing(McpServer::getId));
            for (McpServer server : remotes) {
                for (Map<String, Object> tool : fetchRemoteTools(wsId, server, sessionId, access)) {
                    String backend = (String) tool.get("name");
                    if (backend == null || backend.isEmpty()) {
                        continue;
                    }
                    String key = server.getId() + "\0" + backend;
                    McpToolAlias alias = known.get(key);
                    String issued = alias == null ? null : alias.getIssuedName();
                    // Sticky reuse only when the bare name is still ours; otherwise
                    // re-issue (a newer stdio/system tool claimed the bare name).
                    if (issued != null && !issued.contains("__")
                            && mapping.containsKey(issued) && !server.getId().equals(mapping.get(issued))) {
                        issued = null;
                    }
                    if (issued == null) {
                        issued = stickyIssuedName(server.getId().toString(), backend, !seenNames.contains(backend));
                        try {
                            McpToolAlias row = new McpToolAlias(wsId, issued, server.getId().toString(), backend, generation);
                            aliases.save(row);
                            known.put(key, row);
                        } catch (Exception e) {
                            logger.warn("Tool alias persist failed, continuing in-memory: {}", e.getMessage());
                        }
                    } else if (alias != null) {
                        try {
                            alias.setGeneration(generation);
                            aliases.save(alias);
                        } catch (Exception e) {
                            logger.warn("Tool alias touch failed: {}", e.getMessage());
                        }
                    }
                    if (!mapping.containsKey(issued)) {
                        mapping.put(issued, server.getId().toString());
                        Map<String, Object> published = new HashMap<>(tool);
                        published.put("name", issued);
                        allTools.add(published);
                    }
                    seenNames.add(issued);
                    seenNames.add(backend);
                }
            }

            toolServerCache.put(wsId, mapping);
            cacheTimestamps.put(wsId, Instant.now());

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("tools", allTools);
            // 2026-07-28（modern）结果必填字段：客户端按协商版本做严格校验。
            result.put("resultType", "complete");
            result.put("cacheScope", "private");
            result.put("ttlMs", 0);
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("jsonrpc", "2.0");
            response.put("result", result);
            response.put("id", readJsonRpcId(body));
            String mergedJson = objectMapper.writeValueAsString(response);
            return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .body(mergedJson);
        } catch (Exception e) {
            logger.error("tools/list merge failed: {}", e.getMessage(), e);
            return problem(HttpStatus.BAD_GATEWAY, "MCP_TOOLS_UNAVAILABLE", "MCP tools unavailable");
        }
    }

    /**
     * PLAN-0366 T1.2（Q7/决策 #10）：单个 stdio server 的 `tools/list` 合并。
     *
     * <p>非 2xx 时**移除该 serverId 的全部旧映射**（否则 `tools/call` 仍可能路由到
     * 不可用 server），warn 记录 wsId/serverId/status；按 server 独立处理，部分失败
     * 不得影响其他 server 的映射或工具合并（调用侧宁可「未知工具」，不误路由）。
     */
    void mergeStdioServerTools(String wsId, String serverId, ResponseEntity<String> stdioResp,
                               Map<String, String> mapping, List<Map<String, Object>> allTools,
                               Set<String> seenNames) {
        if (!stdioResp.getStatusCode().is2xxSuccessful()) {
            int removed = 0;
            for (Iterator<Map.Entry<String, String>> it = mapping.entrySet().iterator(); it.hasNext(); ) {
                Map.Entry<String, String> entry = it.next();
                if (serverId.equals(entry.getValue())) {
                    it.remove();
                    removed++;
                }
            }
            logger.warn("Stdio tools/list failed, evicted stale mappings: wsId={} serverId={} status={} evicted={}",
                    wsId, serverId, stdioResp.getStatusCode().value(), removed);
            return;
        }
        List<Map<String, Object>> stdioTools = extractToolsFromResponse(stdioResp.getBody());
        if (stdioTools == null) {
            return;
        }
        for (Map<String, Object> tool : stdioTools) {
            String name = (String) tool.get("name");
            if (name != null && !seenNames.contains(name)) {
                mapping.put(name, serverId);
                allTools.add(tool);
                seenNames.add(name);
            } else if (name != null && seenNames.contains(name)) {
                logger.warn("Tool '{}' from server '{}' conflicts with built-in, skipped", name, serverId);
            }
        }
    }

    private List<Map<String, Object>> populateSystemTools(
            String wsId, HttpHeaders headers, AccessContext access) {
        Map<String, String> mapping = toolServerCache.computeIfAbsent(wsId, k -> new ConcurrentHashMap<>());
        String listBody = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1,\"params\":{}}";
        ResponseEntity<String> sysResp = forwardToRuntime(
                wsId, null, listBody, headers, access.auditSessionId(), access);
        if (!sysResp.getStatusCode().is2xxSuccessful()) {
            logger.warn("System tools/list failed: wsId={} status={}", wsId, sysResp.getStatusCode());
            return Collections.emptyList();
        }
        List<Map<String, Object>> sysTools = extractToolsFromResponse(sysResp.getBody());
        if (sysTools == null || sysTools.isEmpty()) {
            String bodyPreview = sysResp.getBody() == null ? "null"
                    : sysResp.getBody().substring(0, Math.min(500, sysResp.getBody().length()));
            logger.warn("System tools/list returned no tools: wsId={} status={} body={}",
                    wsId, sysResp.getStatusCode(), bodyPreview);
            return Collections.emptyList();
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (Map<String, Object> tool : sysTools) {
            String name = (String) tool.get("name");
            if (name != null) {
                mapping.put(name, "__system__");
                result.add(tool);
            }
        }
        return result;
    }

    private ResponseEntity<String> handleToolsCall(
            String wsId, String body, HttpHeaders headers, String sessionId, AccessContext access) {
        String toolName = extractToolName(body);
        if (toolName == null) {
            return problem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Tool name is required");
        }

        refreshCacheIfNeeded(wsId);
        Map<String, String> mapping = toolServerCache.getOrDefault(wsId, Collections.emptyMap());
        String serverId = mapping.get(toolName);

        if (serverId == null) {
            populateSystemTools(wsId, headers, access);
            mapping = toolServerCache.getOrDefault(wsId, Collections.emptyMap());
            serverId = mapping.get(toolName);
        }

        if (serverId == null) {
            return problem(HttpStatus.BAD_REQUEST, "UNKNOWN_TOOL", "Requested tool is unavailable");
        }

        // PLAN-275 M1: All tools, including __system__, go through policy evaluation.
        // __system__ tools are auto_allow (read-only) or require_approval (mutations).
        // Unknown tools are deny (fail-closed).
        String rewritten = rewriter.rewrite(toolName, body, sessionId);
        // PLAN-0328 M1：闸门按分层 Verdict 判定（身份入参供 instance/user/workspace 层解析；
        // mode 传 null 表示由会话态决定）。硬保护/模式/命中层已在引擎内记录审计。
        // T1.15：同一次加载的 context 同时供 Verdict 与工具面解析使用（不二次加载）。
        PolicyContext policyContext = policy.loadContext(access.userId(), wsId, sessionId);
        boolean userPrincipalOnly = isUserDirectMutation(headers, access)
                && isWorkspaceUserMutationTool(toolName);
        if (!policy.allowsByGrant(policyContext, toolName, rewritten, sessionId,
                access.userId(), wsId, userPrincipalOnly)) {
            sse.send(sessionId, "tool_exec_denied", Map.of("tool", toolName, "reason", "authorization grant denied"));
            audit.record(sessionId, toolName, "authorization_grant_denied", "no matching grant or workspace membership");
            return problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "Tool execution is not permitted");
        }
        PolicyVerdict verdict = policy.evaluateVerdict(policyContext, toolName, rewritten, sessionId, null,
                access.userId(), wsId);
        audit.record(sessionId, toolName, "request", rewritten);

        if (verdict.effect() == PolicyEffect.DENY) {
            sse.send(sessionId, "tool_exec_denied",
                Map.of("tool", toolName, "reason", verdict.reason()));
            audit.record(sessionId, toolName, "deny", verdict.reason());
            return problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "Tool execution is not permitted");
        }

        boolean reusedSessionGrant = false;
        if (verdict.effect() == PolicyEffect.ASK) {
            String grantId = headers.getFirst("X-Xihe-Approval-Request-Id");
            if (grantId != null && approvalService.consumeApprovedGrant(
                    grantId, access.userId(), wsId, sessionId, toolName, body)) {
                // T1.7 R7: approval_grant_consumed is audited inside the consume transaction.
            } else if (approvalService.tryReuseSessionGrant(sessionId, wsId, toolName, body)) {
                // T1.7: an exact session fingerprint authorizes this dispatch without a new
                // pending approval (audited as grant_reused scope=session by the service).
                reusedSessionGrant = true;
            } else if (isUserDirectMutation(headers, access) && isWorkspaceUserMutationTool(toolName)) {
                // PLAN-290 B2: user file-panel mutations are UI-confirmed, not Agent-gated.
                audit.record(sessionId, toolName, "user_direct_allow", "no agent grant required");
            } else {
                sse.send(sessionId, "tool_exec_approval_required",
                    Map.of("tool", toolName, "reason", verdict.reason()));
                audit.record(sessionId, toolName, "approval_required", verdict.reason());
                return approvalRequired(wsId, sessionId, toolName, body, headers, access);
            }
        }
        // ALLOW：引擎已记 policy_check / policy_verdict；模式放行另有 policy_allowed_by_mode。
        // PLAN-0328 T1.15：只为**实际派发**的调用构建安全 Verdict 快照（deny/未获批不落账本，
        // 也不得凭空造 Verdict）；快照随后挂到该次派发的既有账本条目上。
        // T1.7：会话指纹命中判为 reused=true（可审计），其余为 null（不适用）。
        ToolFaceRegistry.Face face = policy.faceOf(policyContext, toolName);
        // PLAN-0338：捕获改由 Run 终止触发（单次补拍）；派发前不再建立 checkpoint。
        String policySummary = OperationPolicySummary.buildSnapshot(
                verdict, face, policyContext,
                reusedSessionGrant ? Boolean.TRUE : null).orElse(null);

        // PLAN-0308 M1（spec S1/S2）：预算由 CP 唯一计算并下发；出站头只由 CP 写入，
        // 且先剥离上游同名头（信任边界）。此块位于 __system__ 分支之前——系统工具同样受管。
        String perCallRaw = headers.getFirst("X-Xihe-Tool-Timeout-Per-Call");
        Long perCallSeconds = null;
        if (perCallRaw != null && !perCallRaw.isBlank()) {
            perCallSeconds = toolTimeoutPolicy.parsePerCall(perCallRaw);
            if (perCallSeconds == null) {
                return problem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "per-call timeout must be a positive integer <= "
                                + ToolTimeoutPolicy.MAX_BUDGET_SECONDS);
            }
        }
        Integer configSeconds = resolveConfigTimeoutSeconds(wsId, serverId, access.userId());
        ToolTimeoutPolicy.ToolWaits waits = toolTimeoutPolicy.resolve(
                perCallSeconds == null ? null : perCallSeconds.intValue(), configSeconds);
        HttpHeaders mutable = stripOutboundPolicyHeaders(headers);
        mutable.remove("X-Xihe-Tool-Timeout-Per-Call");
        mutable.set("X-Xihe-Tool-Timeout-S", String.valueOf(waits.runtimeSeconds()));
        mutable.set("X-Xihe-Tool-Timeout-Origin", waits.origin());
        // T3.4②（决策 #31）：输出上限授权（调用方只可收窄）；未配置时不下发该头。
        Long outputLimit = resolveConfigOutputLimit(wsId, access.userId());
        if (outputLimit != null) {
            mutable.set("X-Xihe-Tool-Output-Limit", String.valueOf(outputLimit));
        }
        headers = mutable;
        // PLAN-0308 M1（spec S2/S5.1）：一次工具调用的署名上下文——三跳日志共用同一 toolCallId
        // （Agent 用 LangGraph 的 tool call id，经 X-Operation-Item-Id 透传）。
        ForwardWait forwardWait = forwardWaitFor(waits, perCallSeconds);
        forwardWait = forwardWait.withIdentity(
                toolName, headers.getFirst("X-Operation-Item-Id"), headers.getFirst("X-Chat-Run-Id"));
        logger.info(
                "[LIFECYCLE] service=cp event=tool_timeout_budget tool={} toolCallId={} runId={}"
                        + " budget={}s valueOrigin={} cpWait={}s cpWaitSource={} cpOverriddenValue={} agentWait={}s outputLimit={} sessionId={}",
                toolName, idOrDash(forwardWait.toolCallId()), idOrDash(forwardWait.runId()),
                waits.runtimeSeconds(), waits.origin(), forwardWait.seconds(), forwardWait.source(),
                forwardWait.overriddenValue() == null ? "-" : forwardWait.overriddenValue(),
                waits.agentSeconds(),
                outputLimit == null ? "-" : outputLimit, sessionId);

        // PLAN-0373 T1.5 + 决策 #9（supersede #5 字面「全 tools/call」）：job 时限注入面
        // = 仅 start_background_process 每次覆写；其他工具（execute_command/web_fetch 等
        // 共享 timeout 键、remote MCP 严格 schema）完全不碰 body、不产 clamp 日志。
        // 注入点仍在 rewrite()/policy/approval 之后、路由分叉之前，且同时回写 body 与
        // rewritten 两变量，保证 job 工具三个出口携带同一覆写值：
        //   __system__ 转发原 body、remote 转发 rewritten 且在 forwardRemoteToRuntime
        //   重解析装 envelope、stdio 转发 rewritten。
        if (JOB_TIMEOUT_TOOL.equals(toolName)) {
            JobTimeoutConfig jobTimeout = resolveJobTimeoutConfig(wsId, access.userId());
            Long jobParam = extractJobTimeoutParam(body);
            long jobEffective = computeJobTimeoutValue(
                    jobParam, jobTimeout.defaultSecs(), jobTimeout.maxSecs());
            logger.info(
                    "[LIFECYCLE] service=cp event=job_timeout_clamp tool={} toolCallId={} runId={}"
                            + " param={} value={} valueOrigin={} max={} maxOrigin={} sessionId={}",
                    toolName, idOrDash(headers.getFirst("X-Operation-Item-Id")),
                    idOrDash(headers.getFirst("X-Chat-Run-Id")),
                    jobParam == null ? "absent" : jobParam, jobEffective, jobTimeout.defaultOrigin(),
                    jobTimeout.maxSecs(), jobTimeout.maxOrigin(), sessionId);
            body = writeJobTimeoutArgument(body, jobEffective);
            rewritten = writeJobTimeoutArgument(rewritten, jobEffective);
        }

        if ("__system__".equals(serverId)) {
            return forwardToRuntime(wsId, null, body, headers, sessionId, access, forwardWait, policySummary);
        }

        // Policy already evaluated above for all tool types (including __system__).
        // Route by server type: remote or local (system).
        Optional<McpServer> remote = remoteServer(wsId, serverId);
        if (remote.isPresent()) {
            return forwardRemoteToRuntime(
                    wsId, remote.get(), rewritten, headers, sessionId, access, forwardWait, policySummary);
        }

        body = rewritten;
        return forwardToRuntime(wsId, serverId, body, headers, sessionId, access, forwardWait, policySummary);
    }

    /**
     * 一次 tools/call 转发的等待署名（spec S5）。
     *
     * @param seconds  本跳生效等待秒数
     * @param source   {@code env}（本跳 ENV 显式，压制派生值）| {@code cp}（用派生值 B+2）
     * @param valueOrigin 预算的性质（per-call | config）
     * @param overriddenValue 本跳被忽略的值（ENV 生效时 = 派生值；per-call 压制 ENV 时 = ENV 值）
     */
    record ForwardWait(
            long seconds, String source, String valueOrigin, Long overriddenValue,
            String toolName, String toolCallId, String runId) {

        ForwardWait withIdentity(String toolName, String toolCallId, String runId) {
            return new ForwardWait(seconds, source, valueOrigin, overriddenValue, toolName, toolCallId, runId);
        }
    }

    private static String idOrDash(String value) {
        return value == null || value.isBlank() ? "-" : value;
    }

    /** CP 本跳 ENV 是否显式设置（`XIHE_MCP_FORWARD_TIMEOUT_S` / 同名配置项）。 */
    private boolean forwardEnvExplicit() {
        return environment != null
                && environment.containsProperty("xihe.mcp.forward-timeout-s");
    }

    /**
     * CP 自用转发等待（三条判断，决策 #27）：per-call 存在 → 用派生值（ENV 被压制）；
     * 否则本跳 ENV 显式 → 用 ENV（压制派生值）；否则用派生值 B+2。
     */
    private ForwardWait forwardWaitFor(ToolTimeoutPolicy.ToolWaits waits, Long perCallSeconds) {
        boolean perCall = perCallSeconds != null && perCallSeconds > 0;
        boolean envExplicit = forwardEnvExplicit() && forwardTimeoutS > 0;
        if (perCall) {
            return new ForwardWait(waits.cpSeconds(), "cp", waits.origin(),
                    envExplicit ? forwardTimeoutS : null, null, null, null);
        }
        if (envExplicit) {
            return new ForwardWait(forwardTimeoutS, "env", waits.origin(), waits.cpSeconds(),
                    null, null, null);
        }
        return new ForwardWait(waits.cpSeconds(), "cp", waits.origin(), null, null, null, null);
    }

    /**
     * 配置侧预算输入（spec S1）：remote 行 → {@code tool_timeout_s}；
     * 系统工具 → {@code agent-runtime.systemToolTimeoutS}（决策 #22a/#24）。
     */
    private Integer resolveConfigTimeoutSeconds(String wsId, String serverId, String userId) {
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
     * 输出上限授权（决策 #31②）：config 键 {@code agent-runtime.toolOutputLimitBytes}；
     * 未配置 → null（不下发头，Runtime 侧沿用调用方值 / 沙盒默认）。
     */
    private Long resolveConfigOutputLimit(String wsId, String userId) {
        try {
            String raw = configService.resolve(
                    ToolTimeoutPolicy.SYSTEM_TOOL_DOMAIN,
                    ToolTimeoutPolicy.OUTPUT_LIMIT_KEY,
                    uuidOrNull(userId),
                    uuidOrNull(wsId));
            return toolTimeoutPolicy.parsePositiveLong(raw);
        } catch (Exception e) {
            logger.warn("tool output limit config unavailable: {}", e.getMessage());
            return null;
        }
    }

    /** PLAN-0373 job 时限配置解析结果 + 各键四级来源（env/workspace/user/instance/default）。 */
    record JobTimeoutConfig(long defaultSecs, long maxSecs, String defaultOrigin, String maxOrigin) {}

    /**
     * PLAN-0373 T1.3/T1.5：按 ConfigService 四级解析链读取 job-policy 默认值与硬上限
     * （env 覆盖优先，决策 #7/#8）；解析失败回落代码默认并署名 {@code default}。
     */
    private JobTimeoutConfig resolveJobTimeoutConfig(String wsId, String userId) {
        UUID user = uuidOrNull(userId);
        UUID ws = uuidOrNull(wsId);
        String defaultRaw;
        String maxRaw;
        try {
            defaultRaw = configService.resolve(JOB_POLICY_DOMAIN, JOB_DEFAULT_TIMEOUT_KEY, user, ws);
            maxRaw = configService.resolve(JOB_POLICY_DOMAIN, JOB_MAX_TIMEOUT_KEY, user, ws);
        } catch (Exception e) {
            logger.warn("job timeout config unavailable, falling back to code defaults: {}",
                    e.getMessage());
            return new JobTimeoutConfig(JOB_CODE_DEFAULT_TIMEOUT_SECS,
                    JOB_CODE_MAX_TIMEOUT_SECS, "default", "default");
        }
        long defaultSecs = parseJobTimeoutSeconds(
                defaultRaw, JOB_CODE_DEFAULT_TIMEOUT_SECS, JOB_DEFAULT_TIMEOUT_KEY);
        long maxSecs = parseJobTimeoutSeconds(
                maxRaw, JOB_CODE_MAX_TIMEOUT_SECS, JOB_MAX_TIMEOUT_KEY);
        return new JobTimeoutConfig(defaultSecs, maxSecs,
                jobTimeoutOrigin(JOB_DEFAULT_TIMEOUT_KEY, user, ws),
                jobTimeoutOrigin(JOB_MAX_TIMEOUT_KEY, user, ws));
    }

    /** 配置字符串 → 秒数；空/非法/负值告警一次并回落代码默认（schema 侧已拦常规非法写入）。 */
    private long parseJobTimeoutSeconds(String raw, long fallback, String key) {
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        try {
            long value = Long.parseLong(raw.trim());
            if (value < 0) {
                logger.warn("job timeout config {}={} is negative; falling back to {}",
                        key, value, fallback);
                return fallback;
            }
            return value;
        } catch (NumberFormatException e) {
            logger.warn("job timeout config {}={} is not a number; falling back to {}",
                    key, raw, fallback);
            return fallback;
        }
    }

    /**
     * 单键来源回填（P4 四级：env / workspace / instance / 默认；user 层镜像解析链但
     * job-policy 不在 USER_WRITABLE，实际不可达）——与 {@code ConfigService.resolve}
     * 的判定顺序一致，用于 job_timeout_clamp 日志署名。
     */
    private String jobTimeoutOrigin(String key, UUID userId, UUID ws) {
        try {
            if (configService.envOverriddenKeys(JOB_POLICY_DOMAIN).contains(key)) {
                return "env";
            }
            if (ws != null
                    && configService.layerEntries("workspace", JOB_POLICY_DOMAIN, null, ws)
                            .containsKey(key)) {
                return "workspace";
            }
            if (userId != null
                    && configService.layerEntries("user", JOB_POLICY_DOMAIN, userId, null)
                            .containsKey(key)) {
                return "user";
            }
            if (configService.layerEntries("instance", JOB_POLICY_DOMAIN, null, null)
                    .containsKey(key)) {
                return "instance";
            }
        } catch (Exception e) {
            logger.warn("job timeout origin unavailable for {}: {}", key, e.getMessage());
        }
        return "default";
    }

    /**
     * PLAN-0373 P2 钳制矩阵（决策 #2/#8，纯函数供单测）：
     * 未传/负值 → 默认（上限已设时 {@code min(默认, 上限)}，保住硬上限不变式）；
     * {@code >0} → {@code min(参数, 上限)}（上限 0 = 不钳）；显式 {@code 0} → 钳到上限
     * （上限 0 时 = 0 = 不限，即决策 #8「上限未设」语义）。
     */
    static long computeJobTimeoutValue(Long paramSecs, long defaultSecs, long maxSecs) {
        if (paramSecs == null || paramSecs < 0) {
            return maxSecs > 0 ? Math.min(defaultSecs, maxSecs) : defaultSecs;
        }
        if (paramSecs == 0L) {
            return maxSecs;
        }
        return maxSecs > 0 ? Math.min(paramSecs, maxSecs) : paramSecs;
    }

    /** 从原始 tools/call body 提取模型参数 {@code timeout}（缺失/非数值 → null）。 */
    private Long extractJobTimeoutParam(String body) {
        try {
            JsonNode args = objectMapper.readTree(body).path("params").path("arguments");
            if (!args.isObject()) {
                return null;
            }
            JsonNode node = args.path("timeout");
            if (node.isNumber()) {
                return node.asLong();
            }
            if (node.isTextual()) {
                try {
                    return Long.parseLong(node.asText().trim());
                } catch (NumberFormatException e) {
                    return null;
                }
            }
            return null;
        } catch (Exception e) {
            logger.debug("Failed to extract job timeout param: {}", e.getMessage());
            return null;
        }
    }

    /**
     * 把覆写值写回 {@code params.arguments.timeout} 并重序列化；解析失败或形状不符时
     * 原样返回（不阻断派发，job_timeout_clamp 日志已记录生效值）。
     */
    private String writeJobTimeoutArgument(String payload, long value) {
        try {
            JsonNode parsed = objectMapper.readTree(payload);
            JsonNode paramsNode = parsed.get("params");
            if (!(paramsNode instanceof ObjectNode params)) {
                return payload;
            }
            JsonNode argsNode = params.get("arguments");
            ObjectNode args;
            if (argsNode instanceof ObjectNode existing) {
                args = existing;
            } else if (argsNode == null || argsNode.isNull() || argsNode.isMissingNode()) {
                args = objectMapper.createObjectNode();
                params.set("arguments", args);
            } else {
                logger.warn("tools/call arguments is not an object; skipping job timeout override");
                return payload;
            }
            args.put("timeout", value);
            return parsed.toString();
        } catch (Exception e) {
            logger.warn("Job timeout override failed, forwarding unchanged: {}", e.getMessage());
            return payload;
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

    /**
     * PLAN-0308 M2（决策 #34②）：把 Runtime 的 SSE 应答解包为纯 JSON。
     *
     * <p>MCP streamable-HTTP 允许服务端以 SSE 帧应答 POST；本代理是同步请求/响应代理，
     * 向下游只呈现 JSON，使调用方（Python SDK 1.x）走最简单的 JSON 路径，
     * 不触发 SSE 解析、Last-Event-ID 与事件重放语义（该语义是本 PLAN 实测挂起的成因）。
     * 非 SSE 应答原样返回；多事件流取其中最后一个 JSON-RPC 响应/错误。
     */
    private String unwrapSseToJson(String body) {
        if (body == null || body.isBlank() || !body.stripLeading().startsWith("data:")) {
            return body;
        }
        String candidate = null;
        for (String line : body.split("\n")) {
            String trimmed = line.trim();
            if (!trimmed.startsWith("data:")) {
                continue;
            }
            String payload = trimmed.substring("data:".length()).trim();
            if (payload.isEmpty()) {
                continue;
            }
            try {
                JsonNode node = objectMapper.readTree(payload);
                if (node.has("result") || node.has("error")) {
                    candidate = payload;
                }
            } catch (Exception e) {
                logger.debug("Ignoring non-JSON SSE data line: {}", e.getMessage());
            }
        }
        if (candidate == null) {
            logger.warn("SSE response without a JSON-RPC result/error payload; returning raw body");
            return body;
        }
        return candidate;
    }

    /** 剥离上游传入的 CP 出站策略头（信任边界 spec S2.2 规则 5；只保留 CP 写入的值）。 */    private static HttpHeaders stripOutboundPolicyHeaders(HttpHeaders headers) {
        boolean present = OUTBOUND_POLICY_HEADERS.stream()
                .anyMatch(name -> headers.getFirst(name) != null);
        if (!present) {
            return headers;
        }
        HttpHeaders sanitized = new HttpHeaders();
        sanitized.addAll(headers);
        OUTBOUND_POLICY_HEADERS.forEach(sanitized::remove);
        return sanitized;
    }

    /** 把 CP 计算好的出站策略头附到 Runtime 转发请求上（入站头不会到达此处，见 proxy()）。 */
    private static void copyOutboundPolicyHeaders(HttpHeaders headers, HttpRequest.Builder builder) {
        for (String headerName : OUTBOUND_POLICY_HEADERS) {
            String value = headers.getFirst(headerName);
            if (value != null && !value.isBlank()) {
                builder.header(headerName, value);
            }
        }
    }

    private ResponseEntity<String> forwardToRuntime(
            String wsId, String serverId, String body, HttpHeaders headers,
            String sessionId, AccessContext access) {
        return forwardToRuntime(wsId, serverId, body, headers, sessionId, access, (ForwardWait) null, null);
    }

    private ResponseEntity<String> forwardToRuntime(
            String wsId, String serverId, String body, HttpHeaders headers,
            String sessionId, AccessContext access, ForwardWait forwardWait) {
        return forwardToRuntime(wsId, serverId, body, headers, sessionId, access, forwardWait, null);
    }

    private ResponseEntity<String> forwardToRuntime(
            String wsId, String serverId, String body, HttpHeaders headers,
            String sessionId, AccessContext access, ForwardWait forwardWait, String policySummary) {
        long waitSeconds = forwardWait == null
                ? forwardTimeoutS
                : (forwardWait.seconds() > 0 ? forwardWait.seconds() : forwardTimeoutS);
        long startedMs = System.currentTimeMillis();
        LedgerAttempt ledgerAttempt = null;
        try {
            // PLAN-242 M2: McpServer rows win over stdio config keys. A serverId
            // present in the table is a remote MCP server, never a bridge.
            if (serverId != null) {
                Optional<McpServer> remote = remoteServer(wsId, serverId);
                if (remote.isPresent()) {
                    return forwardRemoteToRuntime(
                            wsId, remote.get(), body, headers, sessionId, access, forwardWait, policySummary);
                }
            }
            ledgerAttempt = startLedgerAttempt(body, headers, sessionId, access);
            attachPolicySummary(ledgerAttempt, policySummary, forwardWait);
            String path;
            if (serverId == null) {
                path = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
            } else {
                path = "/internal/v1/runtime/workspaces/" + wsId + "/mcp/stdio/" + serverId;
            }

            // PLAN-0308 M2（决策 #34）：上游按 MCP 规范**同时**声明两种 Accept
            // （rmcp 对只声明 application/json 的请求回 406 Not Acceptable），
            // 但下游由 CP 把 SSE 应答解包成纯 JSON（unwrapSseToJson）——调用方只见 JSON，
            // 不触发 SSE 解析与可恢复（Last-Event-ID）语义；协议会话亦不下发/不转发。
            var requestBuilder = HttpRequest.newBuilder()
                .uri(URI.create(runtimeBaseUrl + path))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .header("MCP-Protocol-Version", STATELESS_PROTOCOL_VERSION)
                .header("Authorization", "Bearer " + runtimeServiceToken);

            requestBuilder.header("X-Workspace-Id", wsId);
            copyOperationHeaders(headers, requestBuilder);
            copyOutboundPolicyHeaders(headers, requestBuilder);
            // PLAN-0317 T2.8①（决策 #12）：出站关联键以 CP 规范化后的
            // operationItemId 为准——入站原始值可能非 UUID，两者派生结果不同，
            // 而 Runtime 侧注册表与 CP 账本必须用同一个键（否则取消无法定位）。
            // 注意：`startLedgerAttempt` 在条目已终态时会返回 null，此时**同样**
            // 必须规范化（否则会把 Agent 原始头透传给 Runtime，取消再拿账本键
            // 去查就查不到——2026-09-13 宿主 E2E 实测 404）。
            String outboundItemId = ledgerAttempt != null ? ledgerAttempt.toolCallId() : null;
            if (outboundItemId == null) {
                outboundItemId = canonicalOperationItemId(headers.getFirst("X-Operation-Item-Id"), body);
            }
            if (outboundItemId != null) {
                requestBuilder.setHeader("X-Operation-Item-Id", outboundItemId);
            }

            String requestMethod = extractMethod(body);
            if (requestMethod != null && !requestMethod.isEmpty()) {
                requestBuilder.header("Mcp-Method", requestMethod);
            }
            if ("tools/call".equals(requestMethod)) {
                String toolName = extractToolName(body);
                if (toolName != null && !toolName.isEmpty()) {
                    requestBuilder.header("Mcp-Name", toolName);
                }
            }

            HttpRequest forwardRequest = requestBuilder
                .POST(HttpRequest.BodyPublishers.ofString(normalizeRuntimeBody(body, STATELESS_PROTOCOL_VERSION)))
                .timeout(Duration.ofSeconds(waitSeconds > 0 ? waitSeconds : 30))
                .build();

            HttpResponse<String> response = httpClient.send(forwardRequest, HttpResponse.BodyHandlers.ofString());

            // 决策 #34②：下游只见 JSON——SSE 应答在此解包（客户端不接触 SSE 帧与可恢复语义）。
            String responseBody = unwrapSseToJson(response.body());
            boolean unwrapped = responseBody != response.body();

            finishLedgerAttempt(ledgerAttempt, response.statusCode(), null, responseBody);
            appendMcpExtension(ledgerAttempt, serverId, body, response.statusCode(), responseBody, null,
                    STATELESS_PROTOCOL_VERSION);
            recordJobState(ledgerAttempt, wsId, body, responseBody);

            audit.record(sessionId, extractMethod(body), "allow", responseBody);

            HttpHeaders responseHeaders = new HttpHeaders();
            // 决策 #34：不再签发/回传 mcp-session-id（无会话语义），也不回传可恢复相关头。
            String contentType = unwrapped
                    ? MediaType.APPLICATION_JSON_VALUE
                    : response.headers().firstValue("content-type").orElse(MediaType.APPLICATION_JSON_VALUE);
            responseHeaders.set("Content-Type", contentType);
            responseHeaders.set("MCP-Protocol-Version", STATELESS_PROTOCOL_VERSION);
            if (forwardWait != null) {
                // 转发结果署名的“下游”侧：状态码由 Runtime 给出（spec S5.1 的 origin 仅标注到界方）。
                logger.info(
                        "[LIFECYCLE] service=cp event=tool_forward_result tool={} toolCallId={} runId={}"
                                + " outcome={} status={} durationMs={} origin={}",
                        idOrDash(forwardWait.toolName()), idOrDash(forwardWait.toolCallId()),
                        idOrDash(forwardWait.runId()),
                        response.statusCode() >= 400 ? "error" : "ok", response.statusCode(),
                        System.currentTimeMillis() - startedMs,
                        response.statusCode() >= 400 ? "downstream" : "-");
            }
            return new ResponseEntity<>(responseBody, responseHeaders, HttpStatus.valueOf(response.statusCode()));

        } catch (Exception e) {
            // A transport failure after dispatch cannot prove whether the tool ran.
            finishLedgerAttempt(ledgerAttempt, 502, "MCP_FORWARD_UNKNOWN");
            appendMcpExtension(ledgerAttempt, serverId, body, 502, null, "MCP_FORWARD_UNKNOWN", null);
            if (forwardWait != null) {
                boolean timeout = e instanceof java.net.http.HttpTimeoutException;
                logger.error(
                        "[LIFECYCLE] service=cp event={} layer=cp_forward tool={} toolCallId={} runId={}"
                                + " effectiveSeconds={} source={} valueOrigin={} overriddenValue={} origin={} error={}",
                        timeout ? "tool_forward_timeout" : "tool_forward_failed",
                        idOrDash(forwardWait.toolName()), idOrDash(forwardWait.toolCallId()),
                        idOrDash(forwardWait.runId()), forwardWait.seconds(), forwardWait.source(),
                        forwardWait.valueOrigin(),
                        forwardWait.overriddenValue() == null ? "-" : forwardWait.overriddenValue(),
                        timeout ? "self" : "unknown", e.getMessage());
            }
            logger.error("MCP forward failed: wsId={} serverId={} method={}", wsId, serverId, extractMethod(body), e);
            audit.record(sessionId, extractMethod(body), "error", e.getMessage());
            return problem(HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime MCP request failed");
        }
    }

    /**
     * PLAN-0344 T1.2 来源①②：把 start/get/cancel 的工具结果同步到 job_state 档案。
     * best-effort（JobStateService 内部兜底异常），不影响工具派发链路。
     */
    private void recordJobState(LedgerAttempt ledgerAttempt, String wsId, String requestBody,
                                String responseBody) {
        if (ledgerAttempt == null || responseBody == null) {
            return;
        }
        String toolName = extractToolName(requestBody);
        if (toolName == null || !JOB_TOOLS.contains(toolName)) {
            return;
        }
        jobStateService.applyToolResult(ledgerAttempt.itemId(), wsId, toolName, responseBody);
    }

    private static boolean isUserDirectMutation(HttpHeaders headers, AccessContext access) {
        if (access == null || access.internalService()) {
            return false;
        }
        String runId = headers.getFirst("X-Chat-Run-Id");
        String operationId = headers.getFirst("X-Operation-Id");
        return (runId == null || runId.isBlank())
                && (operationId == null || operationId.isBlank());
    }

    private static boolean isWorkspaceUserMutationTool(String toolName) {
        // PLAN-292 T4: write_file_binary removed — Gateway never exposes it,
        // so a user-direct MCP call with that name cannot exist.
        return switch (toolName) {
            case "write_file", "edit_file", "delete_file",
                 "delete_directory", "move_file", "copy_file", "mkdir" -> true;
            default -> false;
        };
    }

    /**
     * T1.7/T1.9 post-gate approval: create or reuse the durable pending row for this exact
     * invocation, push the approval card to the session SSE, and answer with the JSON-RPC error
     * frame the MCP SDK can actually surface ({@code error.data}). Without a run-scoped context
     * the gate keeps the legacy fail-closed problem response (no extension, no Agent waiter).
     *
     * <p>An answerer-rejected ask is terminal from creation: there is no card to push and no
     * waiter anybody could answer, so the gate answers with a plain JSON-RPC denial the Agent
     * maps to a normal fail-closed tool error — never the {@code -32003} approval signal.</p>
     */
    private ResponseEntity<String> approvalRequired(
            String wsId, String sessionId, String toolName, String body,
            HttpHeaders headers, AccessContext access) {
        String runId = headers.getFirst("X-Chat-Run-Id");
        String applicationSessionId = access.applicationSessionId();
        ApprovalService.GateApprovalOutcome outcome = null;
        if (runId != null && !runId.isBlank() && applicationSessionId != null
                && !applicationSessionId.isBlank()) {
            try {
                outcome = approvalService.recordGatePending(applicationSessionId, runId, access.userId(),
                        wsId, toolName, body,
                        Instant.now().plusSeconds(APPROVAL_REQUEST_TTL_SECONDS)).orElse(null);
            } catch (RuntimeException e) {
                logger.warn("[LIFECYCLE] service=cp event=gate_approval_create_failed tool={} failureType={}",
                        toolName, e.getClass().getName());
            }
        }
        if (outcome == null) {
            return problem(HttpStatus.CONFLICT, "APPROVAL_REQUIRED",
                    "Tool execution requires approval before dispatch");
        }
        ChatApproval row = outcome.row();
        if (!outcome.parked()) {
            return approvalRejectedFrame(body, toolName, row);
        }
        sse.send(applicationSessionId, "approval_request", approvalService.livePayload(row));
        return approvalRequiredFrame(body, toolName, runId, row);
    }

    /**
     * JSON-RPC error frame carrying the safe approval extension (HTTP 409). A problem+json body is
     * discarded by the MCP client transport, so the extension travels as {@code error.data}.
     */
    private ResponseEntity<String> approvalRequiredFrame(String body, String toolName,
                                                         String runId, ChatApproval row) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("jsonrpc", "2.0");
        root.set("id", readJsonRpcId(body));
        ObjectNode error = root.putObject("error");
        error.put("code", -32003);
        error.put("message", "APPROVAL_REQUIRED");
        ObjectNode data = error.putObject("data");
        data.put("status", HttpStatus.CONFLICT.value());
        data.put("code", "APPROVAL_REQUIRED");
        data.put("approvalRequestId", row.getRequestId().toString());
        data.put("tool", toolName);
        data.put("expiresAt", row.getExpiresAt().toString());
        data.put("retryHeader", "X-Xihe-Approval-Request-Id");
        if (runId != null && !runId.isBlank()) {
            data.put("statusUrl", "/api/v1/chat/runs/" + runId);
        }
        approvalService.displayPolicy(row)
                .ifPresent(policy -> data.set("policy", objectMapper.valueToTree(policy)));
        try {
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .contentType(MediaType.APPLICATION_JSON)
                    .header("X-Request-Id", row.getRequestId().toString())
                    .body(objectMapper.writeValueAsString(root));
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=approval_required_frame_failed tool={}", toolName, e);
            return problem(HttpStatus.CONFLICT, "APPROVAL_REQUIRED",
                    "Tool execution requires approval before dispatch");
        }
    }

    /**
     * JSON-RPC error frame for an answerer-rejected ask (HTTP 403): a terminal denial, not an
     * approval signal. The MCP transport discards problem+json bodies, so the code travels as
     * {@code error.message}/{@code error.data}; the Agent only treats {@code APPROVAL_REQUIRED}
     * frames as gate signals and surfaces this one as an ordinary failed tool call.
     */
    private ResponseEntity<String> approvalRejectedFrame(String body, String toolName, ChatApproval row) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("jsonrpc", "2.0");
        root.set("id", readJsonRpcId(body));
        ObjectNode error = root.putObject("error");
        error.put("code", APPROVAL_REJECTED_JSONRPC_CODE);
        error.put("message", APPROVAL_REJECTED_CODE);
        ObjectNode data = error.putObject("data");
        data.put("status", HttpStatus.FORBIDDEN.value());
        data.put("code", APPROVAL_REJECTED_CODE);
        data.put("approvalRequestId", row.getRequestId().toString());
        data.put("tool", toolName);
        try {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .contentType(MediaType.APPLICATION_JSON)
                    .header("X-Request-Id", row.getRequestId().toString())
                    .body(objectMapper.writeValueAsString(root));
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=approval_rejected_frame_failed tool={}", toolName, e);
            return problem(HttpStatus.FORBIDDEN, APPROVAL_REJECTED_CODE,
                    "Tool execution was rejected by the approval chain");
        }
    }

    private LedgerAttempt startUserMutationLedger(String toolName, String body, HttpHeaders headers, String sessionId) {
        try {
            String userId = com.cc01cc.p.xihe.cp.config.TenantContext.getUserId();
            String workspaceId = com.cc01cc.p.xihe.cp.config.TenantContext.getWorkspaceId();
            if (userId == null || workspaceId == null) {
                return null;
            }
            // auditSessionId may be "mcp-init" for UI calls; ledger needs a real session UUID.
            String ledgerSessionId = sessionId;
            try {
                UUID.fromString(ledgerSessionId);
            } catch (Exception notUuid) {
                var sessions = sessionRepository.findByWorkspaceIdAndUserIdAndArchivedFalseOrderByCreatedAtDesc(
                        workspaceId, userId);
                if (sessions == null || sessions.isEmpty()) {
                    com.cc01cc.p.xihe.cp.entity.Session created = new com.cc01cc.p.xihe.cp.entity.Session(
                            workspaceId, userId, "Workspace files");
                    created.setId(UUID.randomUUID());
                    sessionRepository.save(created);
                    ledgerSessionId = created.getId().toString();
                } else {
                    ledgerSessionId = sessions.get(0).getId().toString();
                }
            }
            var started = operationService.startOperation(
                    userId, ledgerSessionId, workspaceId, null, headers.getFirst("X-Request-Id"),
                    "tool_call", "ui", "user", userId, null, "user " + toolName);
            String toolCallId = UUID.nameUUIDFromBytes(body.getBytes(StandardCharsets.UTF_8)).toString();
            var item = operationService.appendItem(
                    started.operationId(), toolCallId, null, "tool_call", toolName, "mcp",
                    safeLedgerPreview(body), null, null);
            operationService.transitionItem(item.getId(), "running", "allow", null, null, null);
            var attempt = operationService.startAttempt(
                    item.getId(), "cp_forward", null, "cp", headers.getFirst("X-Request-Id"));
            return new LedgerAttempt(item.getId(), attempt.getId(), toolCallId);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=operation_user_mutation_ledger_failed tool={} error={}",
                    toolName, e.getMessage());
            return null;
        }
    }

    private LedgerAttempt startLedgerAttempt(String body, HttpHeaders headers, String sessionId, AccessContext access) {
        String operationHeader = headers.getFirst("X-Operation-Id");
        if (operationHeader == null || operationHeader.isBlank()) {
            if (!"tools/call".equals(extractMethod(body))) {
                return null;
            }
            String toolName = extractToolName(body);
            if (toolName != null && isUserDirectMutation(headers, access)
                    && isWorkspaceUserMutationTool(toolName)) {
                return startUserMutationLedger(toolName, body, headers, sessionId);
            }
            return null;
        }
        try {
            UUID operationId = UUID.fromString(operationHeader);
            String toolName = extractToolName(body);
            if (toolName == null || toolName.isBlank()) {
                return null;
            }
            String toolCallId = headers.getFirst("X-Operation-Item-Id");
            if (toolCallId == null || toolCallId.isBlank()) {
                toolCallId = UUID.nameUUIDFromBytes(body.getBytes(StandardCharsets.UTF_8)).toString();
            } else {
                try {
                    toolCallId = UUID.fromString(toolCallId).toString();
                } catch (IllegalArgumentException e) {
                    toolCallId = UUID.nameUUIDFromBytes(toolCallId.getBytes(StandardCharsets.UTF_8)).toString();
                }
            }
            // PLAN-0326 决策 #9：网关自建 source=mcp 的派发事实行，不再复用中继的
            // agent 行（0317 #18 的跨源复用否决）。同键同源的重放由 appendItem 的
            // 同源幂等收敛（0317 幂等语义保留）；同键异源两行并存 = 各通道事实。
            // 被拒/未派发的调用根本不会到这里（无派发即无网关事实，spec §0.6）。
            OperationItem item = operationService.appendItem(
                    operationId, toolCallId, null, "tool_call", toolName, "mcp",
                    safeLedgerPreview(body), null, null);
            if (List.of("completed", "failed", "aborted", "cancelled", "ambiguous")
                    .contains(item.getStatus())) {
                return null;
            }
            if ("pending".equals(item.getStatus())) {
                operationService.transitionItem(item.getId(), "running", "allow", null, null, null);
            }
            // 决策 #12 补充（2026-09-13 宿主 E2E 实测）：出站/注册表键取本行的
            // tool_call_id——v3 下本行即网关权威行；approvalRequestId 仅留日志关联。
            String effectiveToolCallId = item.getToolCallId();
            if (effectiveToolCallId == null || effectiveToolCallId.isBlank()) {
                effectiveToolCallId = toolCallId;
            }
            String requestId = headers.getFirst("X-Request-Id");
            OperationAttempt attempt = operationService.startAttempt(
                    item.getId(), "cp_forward", null, "cp", requestId);
            return new LedgerAttempt(item.getId(), attempt.getId(), effectiveToolCallId);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=operation_mcp_attempt_start_failed sessionId={}", sessionId, e);
            throw e;
        }
    }

    // PLAN-0346 (gap A): the mcp channel row used to stay "running" on a
    // successful dispatch (only the attempt was finished), letting the run
    // reconciler wrongly settle it to "aborted". Three-tier settlement:
    //   HTTP 2xx + MCP result.isError=false → completed
    //   HTTP 2xx + MCP result.isError=true  → failed (detail=mcp_is_error)
    //   unparseable body / non-2xx / transport error → previous behaviour
    // Body parsing is best-effort: failure keeps the row for reconciliation.
    private void finishLedgerAttempt(LedgerAttempt ledgerAttempt, int httpStatus, String errorCode) {
        finishLedgerAttempt(ledgerAttempt, httpStatus, errorCode, null);
    }

    private void finishLedgerAttempt(LedgerAttempt ledgerAttempt, int httpStatus, String errorCode,
                                     String responseBody) {
        if (ledgerAttempt == null) {
            return;
        }
        try {
            boolean succeeded = httpStatus >= 200 && httpStatus < 300 && errorCode == null;
            boolean unknown = errorCode != null && errorCode.endsWith("_UNKNOWN");
            operationService.finishAttempt(ledgerAttempt.attemptId(), unknown ? "unknown" : succeeded ? "succeeded" : "failed",
                    httpStatus, errorCode, null, null);
            if (!succeeded) {
                operationService.transitionItem(ledgerAttempt.itemId(), unknown ? "ambiguous" : "failed",
                        null, null, null, errorCode);
                return;
            }
            McpResult mcpResult = parseMcpResult(responseBody);
            if (mcpResult == null) {
                // Unparseable/absent body: leave the item for the reconciler (no regression).
                return;
            }
            if (mcpResult.kind() == McpResultKind.TOOL_ERROR) {
                operationService.transitionItem(ledgerAttempt.itemId(), "failed",
                        null, null, null, "MCP_RESULT_IS_ERROR");
            } else if (mcpResult.kind() == McpResultKind.PROTOCOL_ERROR) {
                operationService.transitionItem(ledgerAttempt.itemId(), "failed",
                        null, null, null, mcpResult.errorCode());
            } else {
                operationService.transitionItem(ledgerAttempt.itemId(), "completed",
                        null, null, null, null);
            }
        } catch (CpApiException e) {
            if (!"OPERATION_STATE_CONFLICT".equals(e.getCode())) {
                logger.error("[LIFECYCLE] service=cp event=operation_mcp_attempt_finish_failed attemptId={}",
                        ledgerAttempt.attemptId(), e);
            }
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=operation_mcp_attempt_finish_failed attemptId={}",
                    ledgerAttempt.attemptId(), e);
        }
    }

    /**
     * PLAN-0346 (gap A) four-way MCP tools/call verdict from a 2xx body:
     * completed / tool error ({@code result.isError=true}) / protocol error
     * (JSON-RPC {@code error} object; detail = {@code error.code} only, message
     * text is never persisted) / {@code null} = undecidable (unparseable body
     * → leave the item to the reconciler).
     */
    private McpResult parseMcpResult(String responseBody) {
        if (responseBody == null || responseBody.isBlank()) {
            return null;
        }
        try {
            var root = objectMapper.readTree(responseBody);
            var error = root.path("error");
            if (error.isObject()) {
                String suffix = error.hasNonNull("code") ? ":" + error.get("code").asInt() : "";
                return new McpResult(McpResultKind.PROTOCOL_ERROR, "MCP_PROTOCOL_ERROR" + suffix);
            }
            var result = root.path("result");
            if (result.isMissingNode() || !result.isObject()) {
                return null;
            }
            return result.path("isError").asBoolean(false)
                    ? new McpResult(McpResultKind.TOOL_ERROR, "MCP_RESULT_IS_ERROR")
                    : new McpResult(McpResultKind.COMPLETED, null);
        } catch (Exception e) {
            return null;
        }
    }

    private enum McpResultKind { COMPLETED, TOOL_ERROR, PROTOCOL_ERROR }

    private record McpResult(McpResultKind kind, String errorCode) {}

    private void appendMcpExtension(LedgerAttempt ledgerAttempt, String serverId, String requestBody,
                                    int responseStatus, String responseBody, String mcpErrorCode,
                                    String protocolVersion) {
        if (ledgerAttempt == null) {
            return;
        }
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("protocolVersion", protocolVersion == null ? "2026-07-28" : protocolVersion);
            payload.put("transport", "http");
            payload.put("serverId", serverId);
            payload.put("method", extractMethod(requestBody));
            payload.put("backendToolName", extractToolName(requestBody));
            payload.put("requestHash", sha256(requestBody));
            payload.put("responseHash", responseBody == null ? null : sha256(responseBody));
            payload.put("responseStatus", responseStatus);
            payload.put("mcpErrorCode", mcpErrorCode);
            payload.put("requestBytes", requestBody == null ? 0 : requestBody.getBytes(StandardCharsets.UTF_8).length);
            payload.put("responseBytes", responseBody == null ? 0 : responseBody.getBytes(StandardCharsets.UTF_8).length);
            operationService.appendExtension(null, ledgerAttempt.attemptId(), "mcp_call", 1,
                    objectMapper.writeValueAsString(payload));
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=operation_mcp_extension_failed attemptId={}",
                    ledgerAttempt.attemptId(), e);
        }
    }

    /**
     * PLAN-0328 T1.15：把该次派发的安全 Verdict 快照挂到既有账本条目（不新建条目）。
     * 条目缺失（无 operation 头 / 条目已终态）→ 跳过并记生命周期事件；挂载失败
     * 只记日志，不影响派发本身。
     */
    private void attachPolicySummary(LedgerAttempt ledgerAttempt, String policySummary,
                                     ForwardWait forwardWait) {
        if (policySummary == null || policySummary.isBlank()) {
            return;
        }
        if (ledgerAttempt == null) {
            logger.info("[LIFECYCLE] service=cp event=operation_policy_summary_skipped tool={} reason=ledger_item_missing",
                    forwardWait == null ? "-" : idOrDash(forwardWait.toolName()));
            return;
        }
        try {
            operationService.attachPolicySummary(ledgerAttempt.itemId(), policySummary);
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=operation_policy_summary_failed itemId={} failureType={}",
                    ledgerAttempt.itemId(), e.getClass().getName());
        }
    }

    private String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest((value == null ? "" : value).getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private String safeLedgerPreview(String body) {
        String preview = body == null ? "" : body;
        return preview.length() <= 4096 ? preview : preview.substring(0, 4096);
    }

    /**
     * PLAN-0317 决策 #12：CP 与 Runtime 共用的规范化口径。UUID 值原样规范化，
     * 其它值走 {@code nameUUIDFromBytes}；缺失时退化为对请求体求名（与
     * {@code startLedgerAttempt} 的兜底一致，保证同一调用两端同键）。
     */
    private String canonicalOperationItemId(String raw, String body) {
        if (raw == null || raw.isBlank()) {
            return UUID.nameUUIDFromBytes(body.getBytes(StandardCharsets.UTF_8)).toString();
        }
        try {
            return UUID.fromString(raw).toString();
        } catch (IllegalArgumentException e) {
            return UUID.nameUUIDFromBytes(raw.getBytes(StandardCharsets.UTF_8)).toString();
        }
    }

    private void copyOperationHeaders(HttpHeaders headers, HttpRequest.Builder builder) {
        // PLAN-0308 M1（spec S5.1）：关联键随请求透传到 Runtime（同一 toolCallId 串起三层日志）。
        for (String headerName : List.of(
                "X-Operation-Id", "X-Operation-Item-Id", "X-Operation-Attempt-Id",
                "X-Request-Id", "X-Chat-Run-Id")) {
            String value = headers.getFirst(headerName);
            if (value != null && !value.isBlank()) {
                builder.header(headerName, value);
            }
        }
    }

    private record LedgerAttempt(UUID itemId, UUID attemptId, String toolCallId) {}

    private long nextGeneration(String wsId) {
        return toolGenerations.computeIfAbsent(wsId, key -> new AtomicLong()).incrementAndGet();
    }

    private long currentGeneration(String wsId) {
        AtomicLong generation = toolGenerations.get(wsId);
        return generation == null ? 0L : generation.get();
    }

    private String aliasDetail(String serverId, String backendName, long generation) {
        return "serverId=" + serverId + " backendName=" + backendName + " generation=" + generation;
    }

    /** PLAN-242 M2: a serverId backed by an enabled McpServer row is remote. */
    private Optional<McpServer> remoteServer(String wsId, String serverId) {
        try {
            return mcpServers.findById(UUID.fromString(serverId))
                    .filter(server -> wsId.equals(server.getWorkspaceId()) && server.isEnabled());
        } catch (Exception e) {
            logger.warn("Remote server lookup failed, falling back to stdio: {}", e.getMessage());
            return Optional.empty();
        }
    }

    /** Sticky issue policy: bare name when free, else server-qualified. Pure, unit-tested. */
    static String stickyIssuedName(String serverId, String backendName, boolean bareFree) {
        // PLAN-242 M2: ToolNameRewriter wired as the conflict-only naming policy.
        return bareFree ? backendName : new ToolNameRewriter().addPrefix(serverId, backendName);
    }

    /** Resolve an issued name back to its backend tool name. Pure, unit-tested. */
    static String backendFromIssued(String issuedName) {
        if (issuedName == null) {
            return null;
        }
        return new ToolNameRewriter().removePrefix(issuedName)[1];
    }

    private ResponseEntity<String> forwardRemoteToRuntime(
            String wsId, McpServer server, String body, HttpHeaders headers,
            String sessionId, AccessContext access) {
        return forwardRemoteToRuntime(wsId, server, body, headers, sessionId, access, (ForwardWait) null, null);
    }

    private ResponseEntity<String> forwardRemoteToRuntime(
            String wsId, McpServer server, String body, HttpHeaders headers,
            String sessionId, AccessContext access, ForwardWait forwardWait, String policySummary) {
        long waitSeconds = forwardWait == null
                ? forwardTimeoutS
                : (forwardWait.seconds() > 0 ? forwardWait.seconds() : forwardTimeoutS);
        long startedMs = System.currentTimeMillis();
        String method = extractMethod(body);
        LedgerAttempt ledgerAttempt = startLedgerAttempt(body, headers, sessionId, access);
        attachPolicySummary(ledgerAttempt, policySummary, forwardWait);
        try {
            ObjectNode request = objectMapper.createObjectNode();
            request.put("endpoint", server.getEndpoint());
            request.put("userId", access.userId());
            request.put("scope", REMOTE_SCOPE);
            request.put("authMode", server.getAuthMode() == null ? "oauth" : server.getAuthMode());
            if ("tools/list".equals(method)) {
                request.put("tool", "");
                request.set("arguments", objectMapper.createObjectNode());
                request.put("listTools", true);
            } else if ("tools/call".equals(method)) {
                String issued = extractToolName(body);
                if (issued == null || issued.isEmpty()) {
                    return problem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Tool name is required");
                }
                String backend = aliases.findByWorkspaceIdAndIssuedName(UUID.fromString(wsId), issued)
                        .map(McpToolAlias::getBackendName).orElseGet(() -> backendFromIssued(issued));
                JsonNode params;
                try {
                    params = objectMapper.readTree(body).path("params");
                } catch (Exception parseError) {
                    return problem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Invalid tools/call body");
                }
                JsonNode args = params.path("arguments");
                request.put("tool", backend);
                request.set("arguments",
                        args.isMissingNode() || args.isNull() ? objectMapper.createObjectNode() : args);
                request.put("listTools", false);
            } else {
                return problem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "Remote MCP servers support tools/list and tools/call only");
            }

            String target = runtimeBaseUrl + "/internal/v1/runtime/remote-mcp/"
                    + wsId + "/" + server.getId() + "/call";
            HttpRequest.Builder forwardBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(target))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + runtimeServiceToken)
                    .header("X-Workspace-Id", wsId);
            copyOperationHeaders(headers, forwardBuilder);
            copyOutboundPolicyHeaders(headers, forwardBuilder);
            HttpRequest forwardRequest = forwardBuilder
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(request)))
                    .timeout(Duration.ofSeconds(waitSeconds > 0 ? waitSeconds : 30))
                    .build();
            HttpResponse<String> response = httpClient.send(forwardRequest, HttpResponse.BodyHandlers.ofString());
            finishLedgerAttempt(ledgerAttempt, response.statusCode(), null, response.body());
            appendMcpExtension(ledgerAttempt, server.getId().toString(), body,
                    response.statusCode(), response.body(), null, headers.getFirst("MCP-Protocol-Version"));
            HttpHeaders responseHeaders = new HttpHeaders();
            responseHeaders.set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
            audit.record(sessionId, method, "allow",
                    aliasDetail(server.getId().toString(), request.path("tool").asText(""), currentGeneration(wsId)));
            if (forwardWait != null) {
                logger.info(
                        "[LIFECYCLE] service=cp event=tool_forward_result tool={} toolCallId={} runId={}"
                                + " outcome={} status={} durationMs={} origin={}",
                        idOrDash(forwardWait.toolName()), idOrDash(forwardWait.toolCallId()),
                        idOrDash(forwardWait.runId()),
                        response.statusCode() >= 400 ? "error" : "ok", response.statusCode(),
                        System.currentTimeMillis() - startedMs,
                        response.statusCode() >= 400 ? "downstream" : "-");
            }
            return new ResponseEntity<>(response.body(), responseHeaders,
                    HttpStatus.valueOf(response.statusCode()));
        } catch (Exception e) {
            // A transport failure after dispatch cannot prove whether the tool ran.
            finishLedgerAttempt(ledgerAttempt, 502, "REMOTE_MCP_UNKNOWN");
            appendMcpExtension(ledgerAttempt, server.getId().toString(), body,
                    502, null, "REMOTE_MCP_UNKNOWN", headers.getFirst("MCP-Protocol-Version"));
            if (forwardWait != null) {
                boolean timeout = e instanceof java.net.http.HttpTimeoutException;
                logger.error(
                        "[LIFECYCLE] service=cp event={} layer=cp_forward tool={} toolCallId={} runId={}"
                                + " effectiveSeconds={} source={} valueOrigin={} overriddenValue={} origin={} error={}",
                        timeout ? "tool_forward_timeout" : "tool_forward_failed",
                        idOrDash(forwardWait.toolName()), idOrDash(forwardWait.toolCallId()),
                        idOrDash(forwardWait.runId()), forwardWait.seconds(), forwardWait.source(),
                        forwardWait.valueOrigin(),
                        forwardWait.overriddenValue() == null ? "-" : forwardWait.overriddenValue(),
                        timeout ? "self" : "unknown", e.getMessage());
            }
            logger.error("Remote MCP forward failed: wsId={} server={} method={}",
                    wsId, server.getId(), method, e);
            audit.record(sessionId, method, "error", e.getMessage());
            return problem(HttpStatus.BAD_GATEWAY, "REMOTE_MCP_UNAVAILABLE", "Remote MCP request failed");
        }
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> fetchRemoteTools(
            String wsId, McpServer server, String sessionId, AccessContext access) {
        String listBody = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1,\"params\":{}}";
        ResponseEntity<String> resp = forwardRemoteToRuntime(
                wsId, server, listBody, new HttpHeaders(), sessionId, access);
        if (resp == null || !resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null) {
            logger.warn("Remote tools/list failed: wsId={} server={} status={}",
                    wsId, server.getId(), resp == null ? "null" : resp.getStatusCode());
            return Collections.emptyList();
        }
        try {
            JsonNode root = objectMapper.readTree(resp.getBody());
            JsonNode tools = root.has("tools") ? root.get("tools") : root.path("result").path("tools");
            if (tools != null && tools.isArray()) {
                return objectMapper.convertValue(tools, List.class);
            }
        } catch (Exception e) {
            logger.warn("Remote tools/list parse failed: wsId={} server={}: {}",
                    wsId, server.getId(), e.getMessage());
        }
        return Collections.emptyList();
    }

    private String normalizeRuntimeBody(String body, String protocolVersion) {
        try {
            JsonNode parsed = objectMapper.readTree(body);
            if (!(parsed instanceof ObjectNode request)) {
                return body;
            }
            String method = request.path("method").asText();
            if ("initialize".equals(method) || "server/discover".equals(method)) {
                return body;
            }

            ObjectNode params = request.get("params") instanceof ObjectNode existing
                ? existing
                : objectMapper.createObjectNode();
            ObjectNode meta = params.get("_meta") instanceof ObjectNode existing
                ? existing
                : objectMapper.createObjectNode();
            if (!meta.has("io.modelcontextprotocol/protocolVersion")) {
                meta.put("io.modelcontextprotocol/protocolVersion", protocolVersion);
            }
            meta.set("io.modelcontextprotocol/clientInfo", objectMapper.valueToTree(
                Map.of("name", "xihe-cp-gateway", "version", "0.1.0")));
            meta.set("io.modelcontextprotocol/clientCapabilities", objectMapper.createObjectNode());
            params.set("_meta", meta);
            request.set("params", params);
            return objectMapper.writeValueAsString(request);
        } catch (Exception e) {
            logger.warn("Failed to normalize MCP request metadata: {}", e.getMessage());
            return body;
        }
    }

    /**
     * 回显调用方的 JSON-RPC id 作为合并响应 id。
     *
     * 无会话世代（2026-07-28）客户端在**同一连接内逐请求递增 id**（tools/call=1、
     * 校验补发的 tools/list=2…）；此前硬编码 {@code "id": 1} 只适用于每请求 id 恒为 1
     * 的 1.x 会话模型，modern 客户端会把该响应按「未知/迟到 id」丢弃，等待者永久挂起。
     */
    private JsonNode readJsonRpcId(String body) {
        try {
            JsonNode id = objectMapper.readTree(body).get("id");
            if (id != null && !id.isNull() && !id.isMissingNode()) {
                return id;
            }
        } catch (Exception e) {
            logger.warn("Failed to read JSON-RPC id from request: {}", e.getMessage());
        }
        return objectMapper.getNodeFactory().numberNode(1);
    }

    private void refreshCacheIfNeeded(String wsId) {        Instant lastRefresh = cacheTimestamps.get(wsId);
        if (lastRefresh == null || Duration.between(lastRefresh, Instant.now()).compareTo(CACHE_TTL) > 0) {
            toolServerCache.remove(wsId);
            toolServerCache.put(wsId, new ConcurrentHashMap<>());
            cacheTimestamps.put(wsId, Instant.now());
        }
    }

    /**
     * Resolve the request subject before any workspace-scoped MCP operation.
     * User JWTs provide the user and workspace; the internal Agent principal
     * provides neither, so its workspace is resolved to the persisted owner.
     * A protocol session is accepted only after CP has bound it to that same
     * user/workspace pair.
     */
    private AuthorizationResult authorize(
            HttpHeaders headers, String body, @SuppressWarnings("unused") boolean allowMissingMcpSession) {
        String gatewaySessionId = headerValue(headers, "mcp-session-id");
        String signedWorkspaceId = null;
        if (gatewaySessionId != null) {
            signedWorkspaceId = verifySessionId(gatewaySessionId);
            if (signedWorkspaceId == null) {
                return AuthorizationResult.failure(problem(
                        HttpStatus.FORBIDDEN, "MCP_SESSION_INVALID", "MCP session is invalid"));
            }
        }

        String headerWorkspaceId = headerValue(headers, "X-Workspace-Id");
        String bodyWorkspaceId = bodyValue(body, "workspaceId");
        if (conflicts(headerWorkspaceId, bodyWorkspaceId)
                || conflicts(headerWorkspaceId, signedWorkspaceId)
                || conflicts(bodyWorkspaceId, signedWorkspaceId)) {
            return AuthorizationResult.failure(problem(
                    HttpStatus.FORBIDDEN, "FORBIDDEN", "Workspace context does not match MCP session"));
        }

        String applicationSessionId = firstNonBlank(
                headerValue(headers, "X-Session-Id"), bodyValue(body, "sessionId"));
        String claimedUserId = firstNonBlank(
                headerValue(headers, "X-User-Id"), bodyValue(body, "userId"));
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        boolean internalService = isInternalService(authentication);

        String workspaceId;
        String userId;
        if (internalService) {
            workspaceId = firstNonBlank(headerWorkspaceId, signedWorkspaceId, bodyWorkspaceId);
            if (workspaceId == null) {
                return AuthorizationResult.failure(problem(
                        HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Workspace context is required"));
            }

            Workspace workspace;
            try {
                workspace = workspaceService.requireActiveWorkspace(workspaceId);
            } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
                return AuthorizationResult.failure(problem(e.getStatus(), e.getCode(), e.getMessage()));
            }

            if (applicationSessionId != null) {
                Session session = sessionRepository.findById(UUID.fromString(applicationSessionId)).orElse(null);
                if (!matchesSession(session, workspaceId, null)) {
                    return AuthorizationResult.failure(problem(
                            HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
                }
                if (claimedUserId != null && !claimedUserId.equals(session.getUserId())) {
                    return AuthorizationResult.failure(problem(
                            HttpStatus.FORBIDDEN, "FORBIDDEN", "Session owner does not match user context"));
                }
                userId = session.getUserId();
            } else {
                if (claimedUserId != null) {
                    return AuthorizationResult.failure(problem(
                            HttpStatus.FORBIDDEN, "FORBIDDEN", "User context requires an owned session"));
                }
                userId = workspace.getOwnerId();
            }
        } else {
            userId = TenantContext.getUserId();
            String tokenWorkspaceId = TenantContext.getWorkspaceId();
            if (userId == null || tokenWorkspaceId == null) {
                return AuthorizationResult.failure(problem(
                        HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authorization required"));
            }
            if (conflicts(tokenWorkspaceId, headerWorkspaceId)
                    || conflicts(tokenWorkspaceId, bodyWorkspaceId)
                    || conflicts(tokenWorkspaceId, signedWorkspaceId)) {
                return AuthorizationResult.failure(problem(
                        HttpStatus.FORBIDDEN, "FORBIDDEN", "Workspace context does not match user context"));
            }
            workspaceId = tokenWorkspaceId;
            if (claimedUserId != null && !claimedUserId.equals(userId)) {
                return AuthorizationResult.failure(problem(
                        HttpStatus.FORBIDDEN, "FORBIDDEN", "User context does not match authenticated user"));
            }
            if (applicationSessionId != null) {
                Session session = sessionRepository.findById(UUID.fromString(applicationSessionId)).orElse(null);
                if (!matchesSession(session, workspaceId, userId)) {
                    return AuthorizationResult.failure(problem(
                            HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
                }
            }
        }

        if (!workspaceService.isWorkspaceMember(workspaceId, userId)) {
            return AuthorizationResult.failure(problem(
                    HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found"));
        }

        // MCP 2026-07-28 (SEP-2567) removed protocol sessions; the Runtime
        // serves that version statelessly and returns no Mcp-Session-Id.
        // A protocol session therefore becomes an optional binding: when
        // present it must match the resolved user/workspace pair, but its
        // absence is never an error.
        McpSessionBinding binding = gatewaySessionId == null
                ? null : mcpSessionBindings.get(gatewaySessionId);
        if (binding != null && (!workspaceId.equals(binding.workspaceId())
                || !userId.equals(binding.userId()))) {
            return AuthorizationResult.failure(problem(
                    HttpStatus.FORBIDDEN, "FORBIDDEN", "MCP session owner does not match request"));
        }
        if (binding != null && binding.applicationSessionId() != null
                && !binding.applicationSessionId().equals(applicationSessionId)) {
            return AuthorizationResult.failure(problem(
                    HttpStatus.FORBIDDEN, "FORBIDDEN", "MCP application session does not match request"));
        }

        return AuthorizationResult.success(new AccessContext(
                workspaceId, userId, applicationSessionId, gatewaySessionId, internalService));
    }

    private boolean isInternalService(Authentication authentication) {
        return authentication != null && authentication.getAuthorities().stream()
                .anyMatch(authority -> "ROLE_INTERNAL_SERVICE".equals(authority.getAuthority()));
    }

    private boolean matchesSession(Session session, String workspaceId, String userId) {
        return session != null
                && !session.isArchived()
                && workspaceId.equals(session.getWorkspaceId())
                && (userId == null || userId.equals(session.getUserId()));
    }

    private String headerValue(HttpHeaders headers, String name) {
        return firstNonBlank(headers.getFirst(name), null);
    }

    private String bodyValue(String body, String field) {
        if (body == null || body.isBlank()) {
            return null;
        }
        try {
            JsonNode root = objectMapper.readTree(body);
            JsonNode value = root == null ? null : root.get(field);
            return value != null && value.isTextual() ? firstNonBlank(value.asText(), null) : null;
        } catch (Exception e) {
            logger.debug("Failed to parse MCP request metadata field {}: {}", field, e.getMessage());
            return null;
        }
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    private boolean conflicts(String first, String second) {
        return first != null && second != null && !first.equals(second);
    }

    private String signSessionId(String wsId, String rawSessionId) {
        try {
            long timestamp = Instant.now().getEpochSecond();
            String payload = wsId + ":" + rawSessionId + ":" + timestamp;
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            SecretKeySpec key = new SecretKeySpec(sessionIdHmacSecret.getBytes(StandardCharsets.UTF_8), HMAC_ALGORITHM);
            mac.init(key);
            byte[] signature = mac.doFinal(payload.getBytes(StandardCharsets.UTF_8));
            String sigB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(signature);
            String payloadB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.UTF_8));
            return payloadB64 + "." + sigB64;
        } catch (Exception e) {
            logger.error("Failed to sign session-id: {}", e.getMessage(), e);
            throw new IllegalStateException("Unable to sign MCP session id", e);
        }
    }

    /** Verify an HMAC-signed session-id and extract ws_id. Returns null on failure. */
    private String verifySessionId(String signedSessionId) {
        try {
            String[] parts = signedSessionId.split("\\.");
            if (parts.length != 2) {
                return null;
            }
            String payloadB64 = parts[0];
            String sigB64 = parts[1];

            // Verify signature
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            SecretKeySpec key = new SecretKeySpec(sessionIdHmacSecret.getBytes(StandardCharsets.UTF_8), HMAC_ALGORITHM);
            mac.init(key);
            byte[] expectedSig = mac.doFinal(Base64.getUrlDecoder().decode(payloadB64));
            String expectedSigB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(expectedSig);
            if (!MessageDigest.isEqual(expectedSigB64.getBytes(StandardCharsets.US_ASCII), sigB64.getBytes(StandardCharsets.US_ASCII))) {
                return null;
            }

            // Parse payload
            String payload = new String(Base64.getUrlDecoder().decode(payloadB64), StandardCharsets.UTF_8);
            String[] fields = payload.split(":");
            if (fields.length < 3) {
                return null;
            }
            long timestamp = Long.parseLong(fields[2]);
            if (Math.abs(Instant.now().getEpochSecond() - timestamp) > Duration.ofDays(1).getSeconds()) {
                return null;
            }
            return fields[0]; // workspace id
        } catch (Exception e) {
            logger.debug("Session-id verification failed: {}", e.getMessage());
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> extractToolsFromResponse(String responseBody) {
        try {
            JsonNode root = objectMapper.readTree(extractJsonPayload(responseBody));
            JsonNode result = root.get("result");
            if (result != null && result.has("tools")) {
                return objectMapper.convertValue(result.get("tools"), List.class);
            }
        } catch (Exception e) {
            logger.debug("Failed to extract tools from response: {}", e.getMessage());
        }
        return null;
    }

    private String extractJsonPayload(String body) {
        if (body == null) {
            return "{}";
        }
        String trimmed = body.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            return trimmed;
        }
        for (String line : trimmed.split("\n")) {
            if (line.startsWith("data:")) {
                String data = line.substring(5).trim();
                if (data.startsWith("{")) {
                    return data;
                }
            }
        }
        return trimmed;
    }

    private String extractMethod(String body) {
        try {
            JsonNode root = objectMapper.readTree(body);
            return root.path("method").asText();
        } catch (Exception e) {
            logger.debug("Failed to parse MCP method: {}", e.getMessage());
            return "";
        }
    }

    private String extractToolName(String body) {
        try {
            JsonNode root = objectMapper.readTree(body);
            String method = root.path("method").asText();
            if ("tools/call".equals(method)) {
                return root.path("params").path("name").asText();
            }
            return null;
        } catch (Exception e) {
            logger.debug("Failed to extract tool name: {}", e.getMessage());
            return null;
        }
    }

    private String extractProtocolVersion(String body) {
        try {
            JsonNode root = objectMapper.readTree(body);
            if ("initialize".equals(root.path("method").asText())) {
                String version = root.path("params").path("protocolVersion").asText();
                return version.isEmpty() ? null : version;
            }
            return null;
        } catch (Exception e) {
            logger.debug("Failed to extract protocol version: {}", e.getMessage());
            return null;
        }
    }

    private String extractBearerToken(HttpHeaders headers) {
        String auth = headers.getFirst("Authorization");
        if (auth != null && auth.startsWith("Bearer ")) {
            return auth.substring(7);
        }
        return null;
    }

    private record AccessContext(
            String workspaceId, String userId, String applicationSessionId, String mcpSessionId,
            boolean internalService) {
        String auditSessionId() {
            if (applicationSessionId != null) {
                return applicationSessionId;
            }
            return mcpSessionId == null ? "mcp-init" : mcpSessionId;
        }
    }

    private record McpSessionBinding(String workspaceId, String userId, String applicationSessionId) {
    }

    private record AuthorizationResult(AccessContext context, ResponseEntity<String> failure) {
        static AuthorizationResult success(AccessContext context) {
            return new AuthorizationResult(context, null);
        }

        static AuthorizationResult failure(ResponseEntity<String> failure) {
            return new AuthorizationResult(null, failure);
        }

        boolean allowed() {
            return context != null;
        }
    }

    private ResponseEntity<String> problem(HttpStatus status, String code, String detail) {
        String requestId = UUID.randomUUID().toString();
        String body = "{\"type\":\"https://xihe.dev/problems/" + code.toLowerCase(Locale.ROOT)
                + "\",\"title\":\"Request failed\",\"status\":" + status.value()
                + ",\"code\":\"" + code + "\",\"detail\":\"" + detail
                + "\",\"requestId\":\"" + requestId + "\"}";
        return ResponseEntity.status(status)
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .header("X-Request-Id", requestId)
                .body(body);
    }
}
