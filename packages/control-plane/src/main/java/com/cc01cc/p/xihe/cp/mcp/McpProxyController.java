package com.cc01cc.p.xihe.cp.mcp;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.core.JsonProcessingException;
import org.springframework.beans.factory.annotation.Value;
import jakarta.annotation.PostConstruct;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.AgentSpawnExecutionService;
import com.cc01cc.p.xihe.cp.chat.ChatSubmissionService;
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
import com.cc01cc.p.xihe.cp.policy.SafePolicySummary;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.logging.RequestIdFilter;

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
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

@RestController
public class McpProxyController {

    private static final Logger logger = LoggerFactory.getLogger(McpProxyController.class);
    private final McpToolTimeoutService toolTimeoutService;
    private static final String HMAC_ALGORITHM = "HmacSHA256";
    private static final String CP_MCP_SERVER_ID = "__cp__";
    private static final String SPAWN_AGENT_TOOL = ChatSubmissionService.SPAWN_TOOL_NAME;
    private static final Set<String> USER_WORKSPACE_FILE_TOOLS = Set.of(
            "list_directory", "read_file", "read_file_range", "write_file", "delete_file",
            "move_file", "copy_file", "mkdir");
    /** An invocation without a ChatRun is a direct-user MCP call. */
    private static final Set<String> AGENT_EXECUTION_CONTEXT_HEADERS = Set.of(
            "X-Chat-Run-Id", "X-Tool-Call-Id", "X-Mcp-Invocation-Id");

    @Value("${cp.mcp.session-id.hmac-secret}")
    private String sessionIdHmacSecret;
    private static final String REMOTE_SCOPE = "mcp:tools";
    /** T1.7/T1.9 post-gate approval lifetime: the durable row expires after five minutes. */
    private static final long APPROVAL_REQUEST_TTL_SECONDS = ApprovalService.DEFAULT_GATE_TTL_SECONDS;
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

    private final Map<String, McpSessionBinding> mcpSessionBindings = new ConcurrentHashMap<>();
    private final WorkspaceService workspaceService;
    private final SessionRepository sessionRepository;
    private final JobStateService jobStateService;
    private final AgentSpawnExecutionService agentSpawnExecutionService;
    private final McpInvocationService mcpInvocationService;

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
            JobStateService jobStateService,
            ConfigService configService,
            ToolTimeoutPolicy toolTimeoutPolicy,
            org.springframework.core.env.Environment environment,
            AgentSpawnExecutionService agentSpawnExecutionService,
            McpInvocationService mcpInvocationService,
            McpToolTimeoutService toolTimeoutService) {
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
        this.jobStateService = jobStateService;
        this.configService = configService;
        this.toolTimeoutPolicy = toolTimeoutPolicy;
        this.environment = environment;
        this.agentSpawnExecutionService = agentSpawnExecutionService;
        this.mcpInvocationService = mcpInvocationService;
        this.toolTimeoutService = toolTimeoutService;
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
        Map<String, String> mapping = toolTimeoutService.mappingFor(wsId);

        try {
            List<Map<String, Object>> allTools = new ArrayList<>(populateSystemTools(wsId, headers, access));
            mapping = toolTimeoutService.mappingFor(wsId);

            // 2. Call each STDIO server's tools/list
            Set<String> seenNames = new HashSet<>();
            for (Map.Entry<String, String> entry : mapping.entrySet()) {
                if ("__system__".equals(entry.getValue()) || CP_MCP_SERVER_ID.equals(entry.getValue())) {
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

            toolTimeoutService.putMapping(wsId, mapping);

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
        Map<String, String> mapping = toolTimeoutService.mappingForUpdate(wsId);
        List<Map<String, Object>> result = new ArrayList<>();
        if (access != null && access.internalService()) {
            mapping.put(SPAWN_AGENT_TOOL, CP_MCP_SERVER_ID);
            result.add(spawnAgentToolDefinition());
        }
        String listBody = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1,\"params\":{}}";
        ResponseEntity<String> sysResp = forwardToRuntime(
                wsId, null, listBody, headers, access.auditSessionId(), access);
        if (!sysResp.getStatusCode().is2xxSuccessful()) {
            logger.warn("System tools/list failed: wsId={} status={}", wsId, sysResp.getStatusCode());
            return result;
        }
        List<Map<String, Object>> sysTools = extractToolsFromResponse(sysResp.getBody());
        if (sysTools == null || sysTools.isEmpty()) {
            String bodyPreview = sysResp.getBody() == null ? "null"
                    : sysResp.getBody().substring(0, Math.min(500, sysResp.getBody().length()));
            logger.warn("System tools/list returned no tools: wsId={} status={} body={}",
                    wsId, sysResp.getStatusCode(), bodyPreview);
            return result;
        }
        for (Map<String, Object> tool : sysTools) {
            String name = (String) tool.get("name");
            if (SPAWN_AGENT_TOOL.equals(name)) {
                logger.warn("Runtime tool name '{}' is reserved by the CP-owned tool surface", name);
            } else if (name != null) {
                mapping.put(name, "__system__");
                result.add(tool);
            }
        }
        return result;
    }

    private static Map<String, Object> spawnAgentToolDefinition() {
        return Map.of(
                "name", SPAWN_AGENT_TOOL,
                "description", "Create a child Agent Session in the current Workspace. The child inherits a narrowed permission snapshot.",
                "inputSchema", Map.of(
                        "type", "object",
                        "properties", Map.of("prompt", Map.of(
                                "type", "string",
                                "minLength", 1,
                                "description", "The task for the child Agent")),
                        "required", List.of("prompt"),
                        "additionalProperties", false));
    }

    private ResponseEntity<String> handleToolsCall(
            String wsId, String body, HttpHeaders headers, String sessionId, AccessContext access) {
        String toolName = extractToolName(body);
        if (toolName == null) {
            return problem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Tool name is required");
        }

        if (access == null) {
            audit.record(sessionId, toolName, "caller_context_rejected", "missing authenticated caller");
            return problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "Tool execution is not permitted");
        }
        if (!access.internalService()) {
            if (!USER_WORKSPACE_FILE_TOOLS.contains(toolName) || hasAgentExecutionContext(headers)) {
                audit.record(sessionId, toolName, "caller_tool_denied", "user caller is outside workspace UI tool path");
                return problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "Tool execution is not permitted");
            }
        } else if (access.applicationSessionId() == null || access.applicationSessionId().isBlank()) {
            audit.record(sessionId, toolName, "agent_session_required", "Agent tools/call requires an application Session");
            return problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "Tool execution is not permitted");
        }

        Map<String, String> mapping = toolTimeoutService.mappingFor(wsId);
        String serverId = mapping.get(toolName);

        if (serverId == null) {
            populateSystemTools(wsId, headers, access);
            mapping = toolTimeoutService.mappingFor(wsId);
            serverId = mapping.get(toolName);
        }

        if (SPAWN_AGENT_TOOL.equals(toolName)) {
            if (!access.internalService()) {
                return problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "This MCP tool is available only to Agent services");
            }
            serverId = CP_MCP_SERVER_ID;
        }

        if (serverId == null) {
            return problem(HttpStatus.BAD_REQUEST, "UNKNOWN_TOOL", "Requested tool is unavailable");
        }
        // PLAN-0463 T1.2/T1.3 (gate order): the agent-source invocation must exist
        // BEFORE grant context validation, so the new ChatRun+invocation verdict
        // never depends on an operation/item row. Creation is idempotent on
        // (runId, toolCallId); the SSE relay may win the same key earlier.
        // Without a caller-supplied tool-call key there is nothing stable to key
        // on (a body-derived id would not match the relay's derivation), so the
        // invocation is skipped and validation keeps the legacy path.
        String gateToolCallId = canonicalToolCallIdFromHeader(headers);
        if (access.internalService() && gateToolCallId != null) {
            mcpInvocationService.openAgentInvocation(
                    headers.getFirst("X-Chat-Run-Id"),
                    gateToolCallId,
                    toolName,
                    headers.getFirst("X-Request-Id"),
                    safePreview(body));
        }
        if (access.internalService() && !policy.hasCurrentAgentToolCall(
                access.userId(), wsId, access.applicationSessionId(),
                headers.getFirst("X-Chat-Run-Id"),
                canonicalToolCallId(headers, body), toolName)) {
            audit.record(sessionId, toolName, "agent_tool_call_context_rejected",
                    "durable Session/Run/Invocation/ToolCall mismatch");
            return problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "Tool execution is not permitted");
        }
        boolean cpOwnedSpawn = CP_MCP_SERVER_ID.equals(serverId) && SPAWN_AGENT_TOOL.equals(toolName);
        ChatSubmissionService.SpawnInvocation spawnInvocation = null;
        if (cpOwnedSpawn) {
            try {
                spawnInvocation = agentSpawnExecutionService.prepareMcpInvocation(
                        body, headers, access.applicationSessionId(), access.userId(), wsId);
            } catch (CpApiException e) {
                audit.record(sessionId, toolName, "spawn_context_rejected", e.getCode());
                return cpToolErrorResponse(body, e.getCode());
            }
        }

        // PLAN-275 M1: All tools, including __system__, go through policy evaluation.
        // __system__ tools are auto_allow (read-only) or require_approval (mutations).
        // Unknown tools are deny (fail-closed).
        String rewritten = rewriter.rewrite(toolName, body, sessionId);
        // PLAN-0328 M1：闸门按分层 Verdict 判定（身份入参供 instance/user/workspace 层解析；
        // mode 传 null 表示由会话态决定）。硬保护/模式/命中层已在引擎内记录审计。
        // T1.15：同一次加载的 context 同时供 Verdict 与工具面解析使用（不二次加载）。
        PolicyContext policyContext = policy.loadContext(access.userId(), wsId, sessionId);
        boolean userPrincipalOnly = !access.internalService();
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
        String deferredApprovalGrantId = null;
        if (verdict.effect() == PolicyEffect.ASK) {
            String grantId = headers.getFirst("X-Xihe-Approval-Request-Id");
            if (grantId != null && cpOwnedSpawn) {
                deferredApprovalGrantId = grantId;
            } else if (grantId != null && approvalService.consumeApprovedGrant(
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
        String policySummary = SafePolicySummary.buildSnapshot(
                verdict, face, policyContext,
                reusedSessionGrant ? Boolean.TRUE : null).orElse(null);

        if (cpOwnedSpawn) {
            return dispatchCpOwnedSpawn(body, headers, sessionId, access, spawnInvocation,
                    deferredApprovalGrantId, policySummary);
        }

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
        Integer configSeconds = toolTimeoutService.resolveConfigTimeoutSeconds(wsId, serverId, access.userId());
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
        // PLAN-0308 M1 + PLAN-0407 T2.10（spec S2/S5.1）：三跳日志共用 LangChain tool
        // callback run_id; Agent and Runtime correlate through the canonical toolCallId.
        ForwardWait forwardWait = forwardWaitFor(waits, perCallSeconds);
        forwardWait = forwardWait.withIdentity(
                toolName, canonicalToolCallId(headers, body), headers.getFirst("X-Chat-Run-Id"));
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
                    toolName, idOrDash(canonicalToolCallId(headers, body)),
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

    private ResponseEntity<String> dispatchCpOwnedSpawn(
            String body, HttpHeaders headers, String sessionId, AccessContext access,
            ChatSubmissionService.SpawnInvocation invocation, String approvalGrantId, String policySummary) {
        McpDispatch dispatch = startMcpDispatch(body, headers, sessionId, access);
        attachPolicySummary(dispatch, policySummary);
        String responseBody;
        try {
            ChatSubmissionService.SpawnResult child = agentSpawnExecutionService.execute(invocation,
                    new ChatSubmissionService.SpawnAuthorization(
                            invocation.authorizationBody(), approvalGrantId, policySummary));
            Map<String, Object> output = Map.of(
                    "sessionId", child.sessionId(),
                    "runId", child.runId(),
                    "principalId", child.principalId(),
                    "workspaceId", child.workspaceId());
            responseBody = cpToolResult(body, output, null);
            audit.record(sessionId, SPAWN_AGENT_TOOL, "allow",
                    "childRunId=" + child.runId() + " childSessionId=" + child.sessionId());
        } catch (CpApiException e) {
            responseBody = cpToolResult(body, null, e.getCode());
            audit.record(sessionId, SPAWN_AGENT_TOOL, "tool_error", e.getCode());
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=spawn_mcp_dispatch_failed sessionId={} runId={} invocationId={} failureType={}",
                    sessionId, invocation.parentRunId(), invocation.mcpInvocationId(),
                    e.getClass().getSimpleName(), e);
            responseBody = cpToolResult(body, null, "SPAWN_EXECUTION_FAILED");
            audit.record(sessionId, SPAWN_AGENT_TOOL, "tool_error", "SPAWN_EXECUTION_FAILED");
        }

        finishMcpDispatchAttempt(dispatch, 200, null, responseBody);
        return mcpJsonResponse(responseBody);
    }

    private ResponseEntity<String> cpToolErrorResponse(String body, String code) {
        return mcpJsonResponse(cpToolResult(body, null, code));
    }

    private String cpToolResult(String requestBody, Map<String, Object> output, String errorCode) {
        ObjectNode response = objectMapper.createObjectNode();
        response.put("jsonrpc", "2.0");
        response.set("id", objectMapper.valueToTree(readJsonRpcId(requestBody)));
        ObjectNode result = response.putObject("result");
        result.put("resultType", "complete");
        ObjectNode text = result.putArray("content").addObject();
        text.put("type", "text");
        if (errorCode != null) {
            result.put("isError", true);
            text.put("text", "Tool error: " + errorCode);
            return response.toString();
        }
        ObjectNode structured = objectMapper.valueToTree(output);
        result.set("structuredContent", structured);
        text.put("text", structured.toString());
        return response.toString();
    }

    private ResponseEntity<String> mcpJsonResponse(String body) {
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .header("MCP-Protocol-Version", STATELESS_PROTOCOL_VERSION)
                .body(body);
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
        McpDispatch dispatch = null;
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
            dispatch = startMcpDispatch(body, headers, sessionId, access);
            attachPolicySummary(dispatch, policySummary);
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
            copyDomainCorrelationHeaders(headers, requestBuilder);
            copyOutboundPolicyHeaders(headers, requestBuilder);
            String outboundToolCallId = dispatch == null ? null : dispatch.toolCallId();
            if (outboundToolCallId == null) {
                outboundToolCallId = canonicalToolCallId(headers, body);
            }
            if (outboundToolCallId != null) {
                requestBuilder.setHeader("X-Tool-Call-Id", outboundToolCallId);
            }
            if (dispatch != null && dispatch.invocationId() != null) {
                requestBuilder.setHeader("X-Mcp-Invocation-Id", dispatch.invocationId().toString());
            }
            String jobId = headers.getFirst("X-Job-Id");
            if (jobId != null && !jobId.isBlank()) {
                requestBuilder.setHeader("X-Job-Id", jobId);
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

            finishMcpDispatchAttempt(dispatch, response.statusCode(), null, responseBody);
            recordJobState(dispatch, wsId, headers, sessionId, access, body, responseBody);

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
            finishMcpDispatchAttempt(dispatch, 502, "MCP_FORWARD_UNKNOWN", null);
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
     * Synchronize start/get/cancel tool results to the owning Workspace Job row.
     * best-effort（JobStateService 内部兜底异常），不影响工具派发链路。
     */
    private void recordJobState(McpDispatch dispatch, String wsId, HttpHeaders headers,
                                String sessionId, AccessContext access, String requestBody,
                                String responseBody) {
        if (responseBody == null) {
            return;
        }
        String toolName = extractToolName(requestBody);
        if (toolName == null || !JOB_TOOLS.contains(toolName)) {
            return;
        }
        String runId = headers == null ? null : headers.getFirst("X-Chat-Run-Id");
        String toolCallId = dispatch == null ? canonicalToolCallId(headers, requestBody)
                : dispatch.toolCallId();
        jobStateService.applyToolResult(
                new JobStateService.ToolJobProvenance(wsId,
                        access == null ? null : access.userId(),
                        sessionId, runId, toolCallId),
                toolName, responseBody);
    }

    private static boolean isUserDirectMutation(HttpHeaders headers, AccessContext access) {
        if (access == null || access.internalService()) {
            return false;
        }
        String runId = headers.getFirst("X-Chat-Run-Id");
        return runId == null || runId.isBlank();
    }

    private static boolean hasAgentExecutionContext(HttpHeaders headers) {
        return AGENT_EXECUTION_CONTEXT_HEADERS.stream()
                .map(headers::getFirst)
                .anyMatch(value -> value != null && !value.isBlank());
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

    private McpDispatch startMcpDispatch(String body, HttpHeaders headers, String sessionId, AccessContext access) {
        if (!"tools/call".equals(extractMethod(body))) {
            return null;
        }
        String toolName = extractToolName(body);
        if (toolName == null || toolName.isBlank()) {
            return null;
        }
        String toolCallId = canonicalToolCallId(headers, body);
        if (toolCallId == null) {
            return null;
        }
        String requestId = headers.getFirst("X-Request-Id");
        UUID invocationId = null;
        if (isUserDirectMutation(headers, access) && isWorkspaceUserMutationTool(toolName)) {
            invocationId = mcpInvocationService.openDirectUserInvocation(
                    sessionId, com.cc01cc.p.xihe.cp.config.TenantContext.getWorkspaceId(),
                    com.cc01cc.p.xihe.cp.config.TenantContext.getUserId(), toolCallId, toolName,
                    requestId, safePreview(body)).orElse(null);
        } else {
            invocationId = mcpInvocationService.findAgentInvocation(
                    headers.getFirst("X-Chat-Run-Id"), toolCallId).orElse(null);
        }
        UUID dispatchAttemptId = startAgentDispatchAttempt(invocationId, requestId);
        return new McpDispatch(toolCallId, invocationId, dispatchAttemptId);
    }

    // Three-tier MCP dispatch settlement:
    //   HTTP 2xx + MCP result.isError=false → completed
    //   HTTP 2xx + MCP result.isError=true  → failed (detail=mcp_is_error)
    //   unparseable body / non-2xx / transport error → undecidable or failed attempt.
    private void finishMcpDispatchAttempt(McpDispatch dispatch, int httpStatus,
                                          String errorCode, String responseBody) {
        if (dispatch == null || dispatch.invocationId() == null || dispatch.dispatchAttemptId() == null) {
            return;
        }
        McpResult mcpResult = parseMcpResult(responseBody);
        McpInvocationService.McpDispatchVerdict verdict =
                mcpResult == null ? McpInvocationService.McpDispatchVerdict.UNDECIDABLE
                        : switch (mcpResult.kind()) {
                            case TOOL_ERROR -> McpInvocationService.McpDispatchVerdict.TOOL_ERROR;
                            case PROTOCOL_ERROR -> McpInvocationService.McpDispatchVerdict.PROTOCOL_ERROR;
                            case COMPLETED -> McpInvocationService.McpDispatchVerdict.COMPLETED;
                        };
        try {
            mcpInvocationService.finishDispatchAttempt(dispatch.invocationId(),
                    dispatch.dispatchAttemptId(), httpStatus, errorCode, verdict);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_dispatch_attempt_finish_failed invocationId={} attemptId={} failureType={}",
                    dispatch.invocationId(), dispatch.dispatchAttemptId(),
                    e.getClass().getName(), e);
        }
    }

    /**
     * PLAN-0346 (gap A) four-way MCP tools/call verdict from a 2xx body:
     * completed / tool error ({@code result.isError=true}) / protocol error
      * (JSON-RPC {@code error} object; detail = {@code error.code} only, message
      * text is never persisted) / {@code null} = undecidable (unparseable body).
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

    /** Attach the safe policy snapshot to its MCP invocation when one exists. */
    private void attachPolicySummary(McpDispatch dispatch, String policySummary) {
        if (policySummary == null || policySummary.isBlank()) {
            return;
        }
        if (dispatch == null || dispatch.invocationId() == null) {
            return;
        }
        try {
            mcpInvocationService.attachPolicySummary(dispatch.invocationId(), policySummary);
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=mcp_invocation_policy_summary_failed invocationId={} failureType={}",
                    dispatch.invocationId(), e.getClass().getName());
        }
    }

    private String safePreview(String body) {
        String preview = body == null ? "" : body;
        return preview.length() <= 4096 ? preview : preview.substring(0, 4096);
    }

    /**
     * CP and Runtime use one deterministic MCP tool-call correlation key.
     */
    private String canonicalToolCallId(String raw, String body) {
        if (raw == null || raw.isBlank()) {
            return UUID.nameUUIDFromBytes(body.getBytes(StandardCharsets.UTF_8)).toString();
        }
        try {
            return UUID.fromString(raw).toString();
        } catch (IllegalArgumentException e) {
            return UUID.nameUUIDFromBytes(raw.getBytes(StandardCharsets.UTF_8)).toString();
        }
    }

    private String canonicalToolCallIdFromHeader(HttpHeaders headers) {
        String raw = headers.getFirst("X-Tool-Call-Id");
        if (raw == null || raw.isBlank()) {
            return null;
        }
        return canonicalToolCallId(raw.trim(), null);
    }

    /** Header-first key; falls back to the body-derived id (legacy behavior). */
    private String canonicalToolCallId(HttpHeaders headers, String body) {
        String fromHeader = canonicalToolCallIdFromHeader(headers);
        return fromHeader != null ? fromHeader
                : UUID.nameUUIDFromBytes(body.getBytes(StandardCharsets.UTF_8)).toString();
    }

    private void copyDomainCorrelationHeaders(HttpHeaders headers, HttpRequest.Builder builder) {
        for (String headerName : List.of(
                "X-Tool-Call-Id", "X-Mcp-Invocation-Id", "X-Job-Id",
                "X-Request-Id", "X-Chat-Run-Id")) {
            String value = headers.getFirst(headerName);
            if (value != null && !value.isBlank()) {
                builder.header(headerName, value);
            }
        }
    }

    private UUID startAgentDispatchAttempt(UUID invocationId, String requestId) {
        if (invocationId == null) {
            return null;
        }
        try {
            return mcpInvocationService.startDispatchAttempt(invocationId, requestId).orElse(null);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_dispatch_attempt_start_failed invocationId={} failureType={}",
                    invocationId, e.getClass().getName(), e);
            return null;
        }
    }

    /**
     * PLAN-0463: dispatch tracking is owned by the MCP execution domain.
     * {@code invocationId}/{@code dispatchAttemptId} are null when the invocation
     * or attempt could not be recorded; there is no Ledger fallback.
     */
    private record McpDispatch(String toolCallId, UUID invocationId, UUID dispatchAttemptId) {}

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
        McpDispatch dispatch = startMcpDispatch(body, headers, sessionId, access);
        attachPolicySummary(dispatch, policySummary);
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
            copyDomainCorrelationHeaders(headers, forwardBuilder);
            copyOutboundPolicyHeaders(headers, forwardBuilder);
            String remoteToolCallId = dispatch != null ? dispatch.toolCallId()
                    : canonicalToolCallId(headers, body);
            if (remoteToolCallId != null) {
                forwardBuilder.setHeader("X-Tool-Call-Id", remoteToolCallId);
            }
            if (dispatch != null && dispatch.invocationId() != null) {
                forwardBuilder.setHeader("X-Mcp-Invocation-Id", dispatch.invocationId().toString());
            }
            String remoteJobId = headers.getFirst("X-Job-Id");
            if (remoteJobId != null && !remoteJobId.isBlank()) {
                forwardBuilder.setHeader("X-Job-Id", remoteJobId);
            }
            HttpRequest forwardRequest = forwardBuilder
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(request)))
                    .timeout(Duration.ofSeconds(waitSeconds > 0 ? waitSeconds : 30))
                    .build();
            HttpResponse<String> response = httpClient.send(forwardRequest, HttpResponse.BodyHandlers.ofString());
            finishMcpDispatchAttempt(dispatch, response.statusCode(), null, response.body());
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
            finishMcpDispatchAttempt(dispatch, 502, "REMOTE_MCP_UNKNOWN", null);
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
        UUID applicationSessionUuid = null;
        if (applicationSessionId != null) {
            try {
                applicationSessionUuid = UUID.fromString(applicationSessionId);
                if (!applicationSessionUuid.toString().equalsIgnoreCase(applicationSessionId)) {
                    throw new IllegalArgumentException("Session ID is not a canonical UUID");
                }
            } catch (IllegalArgumentException e) {
                logger.warn("MCP request rejected: malformed application Session ID requestId={}",
                        MDC.get(RequestIdFilter.MDC_KEY));
                return AuthorizationResult.failure(problem(
                        HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
            }
        }
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
                Session session = sessionRepository.findById(applicationSessionUuid).orElse(null);
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
                Session session = sessionRepository.findById(applicationSessionUuid).orElse(null);
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
        String requestId = MDC.get(RequestIdFilter.MDC_KEY);
        if (requestId == null || requestId.isBlank()) {
            requestId = UUID.randomUUID().toString();
        }
        ObjectNode problem = objectMapper.createObjectNode();
        problem.put("type", "https://xihe.dev/problems/" + code.toLowerCase(Locale.ROOT));
        problem.put("title", "Request failed");
        problem.put("status", status.value());
        problem.put("code", code);
        problem.put("detail", detail == null ? "Request failed" : detail);
        problem.put("requestId", requestId);
        String body;
        try {
            body = objectMapper.writeValueAsString(problem);
        } catch (JsonProcessingException e) {
            logger.error("MCP Problem Details serialization failed code={} requestId={}", code, requestId, e);
            throw new IllegalStateException("Failed to serialize MCP Problem Details", e);
        }
        return ResponseEntity.status(status)
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .header(RequestIdFilter.HEADER, requestId)
                .body(body);
    }
}
