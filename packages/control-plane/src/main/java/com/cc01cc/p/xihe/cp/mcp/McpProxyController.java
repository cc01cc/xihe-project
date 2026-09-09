package com.cc01cc.p.xihe.cp.mcp;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.entity.McpToolAlias;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;

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
    private static final String HMAC_SECRET = "xihe-mcp-session-hmac-key-2026";
    private static final String REMOTE_SCOPE = "mcp:tools";

    private final HttpClient httpClient;
    private final RequestRewriter rewriter;
    private final PolicyEngine policy;
    private final AuditLogger audit;
    private final ApprovalService approvalService;
    private final ObjectMapper objectMapper;
    private final SseEmitterManager sse;
    private final ConfigJpaRepository configRepo;
    private final McpServerRepository mcpServers;
    private final McpToolAliasRepository aliases;
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

    public McpProxyController(
            RequestRewriter rewriter,
            PolicyEngine policy,
            AuditLogger audit,
            ApprovalService approvalService,
            ObjectMapper objectMapper,
            SseEmitterManager sse,
            ConfigJpaRepository configRepo,
            McpServerRepository mcpServers,
            McpToolAliasRepository aliases,
            WorkspaceService workspaceService,
            SessionRepository sessionRepository,
            OperationService operationService) {
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        this.rewriter = rewriter;
        this.policy = policy;
        this.audit = audit;
        this.approvalService = approvalService;
        this.objectMapper = objectMapper;
        this.sse = sse;
        this.configRepo = configRepo;
        this.mcpServers = mcpServers;
        this.aliases = aliases;
        this.workspaceService = workspaceService;
        this.sessionRepository = sessionRepository;
        this.operationService = operationService;
    }

    @PostMapping("/api/v1/mcp")
    public ResponseEntity<String> proxy(
            @RequestBody String body,
            @RequestHeader HttpHeaders headers) {

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

    @GetMapping("/api/v1/mcp")
    public ResponseEntity<String> stream(
            @RequestHeader HttpHeaders headers) {
        AuthorizationResult authorization = authorize(headers, null, false);
        if (!authorization.allowed()) {
            return authorization.failure();
        }
        return forwardGetToRuntime(authorization.context(), headers);
    }

    @DeleteMapping("/api/v1/mcp")
    public ResponseEntity<String> disconnect(
            @RequestHeader HttpHeaders headers) {
        AuthorizationResult authorization = authorize(headers, null, false);
        if (!authorization.allowed()) {
            return authorization.failure();
        }
        AccessContext access = authorization.context();
        String sessionId = access.auditSessionId();
        String wsId = access.workspaceId();
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(runtimeBaseUrl + "/internal/v1/runtime/workspaces/" + wsId + "/mcp"))
                    .timeout(Duration.ofSeconds(30))
                    .header("MCP-Protocol-Version", "2026-07-28")
                    .header("Authorization", "Bearer " + runtimeServiceToken)
                    .header("Accept", "application/json")
                    .header("X-Workspace-Id", wsId)
                    .DELETE();
            copySessionHeaders(headers, builder);
            HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            HttpHeaders responseHeaders = new HttpHeaders();
            response.headers().firstValue("content-type").ifPresent(value -> responseHeaders.set("Content-Type", value));
            audit.record(sessionId, "mcp/disconnect", "allow", "session disconnected");
            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                String gatewaySessionId = headers.getFirst("mcp-session-id");
                if (gatewaySessionId != null) {
                    runtimeSessionByGatewaySession.remove(gatewaySessionId);
                    mcpSessionBindings.remove(gatewaySessionId);
                }
            }
            return new ResponseEntity<>(response.body(), responseHeaders, HttpStatus.valueOf(response.statusCode()));
        } catch (Exception e) {
            logger.error("MCP disconnect failed: wsId={} sessionId={}", wsId, sessionId, e);
            return problem(HttpStatus.BAD_GATEWAY, "MCP_DISCONNECT_UNAVAILABLE", "MCP disconnect unavailable");
        }
    }

    private void copySessionHeaders(HttpHeaders headers, HttpRequest.Builder builder) {
        for (String name : List.of("mcp-session-id", "Last-Event-ID")) {
            String value = headers.getFirst(name);
            if (value != null && !value.isBlank()) {
                if ("mcp-session-id".equalsIgnoreCase(name)) {
                    value = runtimeSessionByGatewaySession.getOrDefault(value, value);
                }
                builder.header(name, value);
            }
        }
    }

    private ResponseEntity<String> forwardGetToRuntime(AccessContext access, HttpHeaders headers) {
        String wsId = access.workspaceId();
        String sessionId = access.auditSessionId();
        try {
            String requestedAccept = headers.getFirst("Accept");
            String accept = requestedAccept != null && requestedAccept.contains(MediaType.TEXT_EVENT_STREAM_VALUE)
                    ? requestedAccept : MediaType.TEXT_EVENT_STREAM_VALUE;
            var builder = HttpRequest.newBuilder()
                    .uri(URI.create(runtimeBaseUrl + "/internal/v1/runtime/workspaces/" + wsId + "/mcp"))
                    .timeout(Duration.ofSeconds(30))
                    .header("Accept", accept)
                    .header("MCP-Protocol-Version", "2026-07-28")
                    .header("Authorization", "Bearer " + runtimeServiceToken)
                    .GET();
            for (String name : List.of("Last-Event-ID", "mcp-session-id")) {
                String value = headers.getFirst(name);
                if ("mcp-session-id".equalsIgnoreCase(name) && value != null) {
                    value = runtimeSessionByGatewaySession.getOrDefault(value, value);
                }
                if (value != null && !value.isBlank()) builder.header(name, value);
            }
            builder.header("X-Workspace-Id", wsId);
            HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            HttpHeaders responseHeaders = new HttpHeaders();
            response.headers().firstValue("content-type").ifPresent(value -> responseHeaders.set("Content-Type", value));
            response.headers().firstValue("mcp-session-id").ifPresent(value -> responseHeaders.set("mcp-session-id", value));
            response.headers().firstValue("last-event-id").ifPresent(value -> responseHeaders.set("Last-Event-ID", value));
            audit.record(sessionId, "mcp/stream", "allow", "SSE response");
            return new ResponseEntity<>(response.body(), responseHeaders, HttpStatus.valueOf(response.statusCode()));
        } catch (Exception e) {
            logger.error("MCP GET stream failed: wsId={} sessionId={}", wsId, sessionId, e);
            return problem(HttpStatus.BAD_GATEWAY, "MCP_STREAM_UNAVAILABLE", "MCP stream unavailable");
        }
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

            String mcpConfig = readMcpConfig(wsId);
            if (mcpConfig != null) {
                try {
                    JsonNode configNode = objectMapper.readTree(mcpConfig);
                    JsonNode servers = configNode.get("mcpServers");
                    if (servers != null && servers.isObject()) {
                        java.util.Iterator<String> serverIds = servers.fieldNames();
                        while (serverIds.hasNext()) {
                            String serverId = serverIds.next();
                            ResponseEntity<String> stdioResp = forwardToRuntime(
                                    wsId, serverId, body, headers, sessionId, access);
                            if (stdioResp.getStatusCode().is2xxSuccessful()) {
                                List<Map<String, Object>> stdioTools = extractToolsFromResponse(stdioResp.getBody());
                                if (stdioTools != null) {
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
                            }
                        }
                    }
                } catch (Exception e) {
                    logger.error("Failed to parse MCP config for tools/list: {}", e.getMessage(), e);
                }
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

            String mergedJson = objectMapper.writeValueAsString(Map.of(
                "jsonrpc", "2.0",
                "result", Map.of("tools", allTools),
                "id", 1
            ));
            return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .body(mergedJson);
        } catch (Exception e) {
            logger.error("tools/list merge failed: {}", e.getMessage(), e);
            return problem(HttpStatus.BAD_GATEWAY, "MCP_TOOLS_UNAVAILABLE", "MCP tools unavailable");
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
        PolicyEngine.PolicyDecision decision = policy.evaluate(toolName, rewritten, sessionId);
        audit.record(sessionId, toolName, "request", rewritten);

        if (decision.getResult() == PolicyEngine.PolicyDecision.PolicyResult.DENY) {
            sse.send(sessionId, "tool_exec_denied",
                Map.of("tool", toolName, "reason", decision.getReason()));
            audit.record(sessionId, toolName, "deny", decision.getReason());
            return problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "Tool execution is not permitted");
        }

        if (decision.getResult() == PolicyEngine.PolicyDecision.PolicyResult.REQUIRE_APPROVAL) {
            String grantId = headers.getFirst("X-Xihe-Approval-Request-Id");
            if (grantId != null && approvalService.consumeApprovedGrant(
                    grantId, access.userId(), wsId, sessionId, toolName, body)) {
                audit.record(sessionId, toolName, "approval_grant_consumed", grantId);
            } else if (isUserDirectMutation(headers) && isWorkspaceUserMutationTool(toolName)) {
                // PLAN-290 B2: user file-panel mutations are UI-confirmed, not Agent-gated.
                audit.record(sessionId, toolName, "user_direct_allow", "no agent grant required");
            } else {
                sse.send(sessionId, "tool_exec_approval_required",
                    Map.of("tool", toolName, "reason", decision.getReason()));
                audit.record(sessionId, toolName, "approval_required", decision.getReason());
                return problem(HttpStatus.CONFLICT, "APPROVAL_REQUIRED",
                        "Tool execution requires approval before dispatch");
            }
        }

        if ("__system__".equals(serverId)) {
            return forwardToRuntime(wsId, null, body, headers, sessionId, access);
        }

        // Policy already evaluated above for all tool types (including __system__).
        // Route by server type: remote or local (system).
        Optional<McpServer> remote = remoteServer(wsId, serverId);
        if (remote.isPresent()) {
            return forwardRemoteToRuntime(wsId, remote.get(), rewritten, headers, sessionId, access);
        }

        body = rewritten;
        return forwardToRuntime(wsId, serverId, body, headers, sessionId, access);
    }

    private ResponseEntity<String> forwardToRuntime(
            String wsId, String serverId, String body, HttpHeaders headers,
            String sessionId, AccessContext access) {
        LedgerAttempt ledgerAttempt = null;
        try {
            // PLAN-242 M2: McpServer rows win over stdio config keys. A serverId
            // present in the table is a remote MCP server, never a bridge.
            if (serverId != null) {
                Optional<McpServer> remote = remoteServer(wsId, serverId);
                if (remote.isPresent()) {
                    return forwardRemoteToRuntime(wsId, remote.get(), body, headers, sessionId, access);
                }
            }
            ledgerAttempt = startLedgerAttempt(body, headers, sessionId);
            String path;
            if (serverId == null) {
                path = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
            } else {
                path = "/internal/v1/runtime/workspaces/" + wsId + "/mcp/stdio/" + serverId;
            }

            String requestedAccept = headers.getFirst("Accept");
            String forwardedAccept = requestedAccept != null
                    && requestedAccept.contains(MediaType.APPLICATION_JSON_VALUE)
                    && requestedAccept.contains(MediaType.TEXT_EVENT_STREAM_VALUE)
                ? requestedAccept
                : "application/json, text/event-stream";

            String protocolVersion = extractProtocolVersion(body);
            if (protocolVersion == null) {
                protocolVersion = headers.getFirst("MCP-Protocol-Version");
            }
            if (protocolVersion == null || protocolVersion.isEmpty()) {
                protocolVersion = "2026-07-28";
            }

            var requestBuilder = HttpRequest.newBuilder()
                .uri(URI.create(runtimeBaseUrl + path))
                .header("Content-Type", "application/json")
                .header("Accept", forwardedAccept)
                .header("MCP-Protocol-Version", protocolVersion)
                .header("Authorization", "Bearer " + runtimeServiceToken);

            for (String headerName : List.of("Last-Event-ID")) {
                String headerValue = headers.getFirst(headerName);
                if (headerValue != null && !headerValue.isEmpty()
                        && !"Authorization".equalsIgnoreCase(headerName)) {
                    requestBuilder.header(headerName, headerValue);
                }
            }

            String gatewaySessionId = headers.getFirst("mcp-session-id");
            if (gatewaySessionId != null && !gatewaySessionId.isEmpty()) {
                String runtimeSessionId = runtimeSessionByGatewaySession
                    .getOrDefault(gatewaySessionId, gatewaySessionId);
                requestBuilder.header("mcp-session-id", runtimeSessionId);
            }

            requestBuilder.header("X-Workspace-Id", wsId);
            copyOperationHeaders(headers, requestBuilder);

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
                .POST(HttpRequest.BodyPublishers.ofString(normalizeRuntimeBody(body, protocolVersion)))
                .timeout(Duration.ofSeconds(30))
                .build();

            HttpResponse<String> response = httpClient.send(forwardRequest, HttpResponse.BodyHandlers.ofString());

            finishLedgerAttempt(ledgerAttempt, response.statusCode(), null);
            appendMcpExtension(ledgerAttempt, serverId, body, response.statusCode(), response.body(), null,
                    protocolVersion);

            audit.record(sessionId, extractMethod(body), "allow", response.body());

            HttpHeaders responseHeaders = new HttpHeaders();
            String runtimeSessionId = response.headers().firstValue("mcp-session-id").orElse(null);
            if (runtimeSessionId != null && !runtimeSessionId.isEmpty()) {
                String signedGatewaySessionId = signSessionId(wsId, runtimeSessionId);
                runtimeSessionByGatewaySession.put(signedGatewaySessionId, runtimeSessionId);
                mcpSessionBindings.put(signedGatewaySessionId, new McpSessionBinding(
                        wsId, access.userId(), access.applicationSessionId()));
                responseHeaders.set("mcp-session-id", signedGatewaySessionId);
            }
            String contentType = response.headers().firstValue("content-type")
                .orElse(MediaType.APPLICATION_JSON_VALUE);
            responseHeaders.set("Content-Type", contentType);
            response.headers().firstValue("MCP-Protocol-Version")
                .ifPresent(value -> responseHeaders.set("MCP-Protocol-Version", value));
            response.headers().firstValue("Last-Event-ID")
                .ifPresent(value -> responseHeaders.set("Last-Event-ID", value));
            return new ResponseEntity<>(response.body(), responseHeaders, HttpStatus.valueOf(response.statusCode()));

        } catch (Exception e) {
            // A transport failure after dispatch cannot prove whether the tool ran.
            finishLedgerAttempt(ledgerAttempt, 502, "MCP_FORWARD_UNKNOWN");
            appendMcpExtension(ledgerAttempt, serverId, body, 502, null, "MCP_FORWARD_UNKNOWN", null);
            logger.error("MCP forward failed: wsId={} serverId={} method={}", wsId, serverId, extractMethod(body), e);
            audit.record(sessionId, extractMethod(body), "error", e.getMessage());
            return problem(HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime MCP request failed");
        }
    }

    private static boolean isUserDirectMutation(HttpHeaders headers) {
        String runId = headers.getFirst("X-Chat-Run-Id");
        String operationId = headers.getFirst("X-Operation-Id");
        return (runId == null || runId.isBlank())
                && (operationId == null || operationId.isBlank());
    }

    private static boolean isWorkspaceUserMutationTool(String toolName) {
        return switch (toolName) {
            case "write_file", "write_file_binary", "edit_file", "delete_file",
                 "delete_directory", "move_file", "copy_file", "mkdir" -> true;
            default -> false;
        };
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
            return new LedgerAttempt(item.getId(), attempt.getId());
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=operation_user_mutation_ledger_failed tool={} error={}",
                    toolName, e.getMessage());
            return null;
        }
    }

    private LedgerAttempt startLedgerAttempt(String body, HttpHeaders headers, String sessionId) {
        String operationHeader = headers.getFirst("X-Operation-Id");
        if (operationHeader == null || operationHeader.isBlank()) {
            if (!"tools/call".equals(extractMethod(body))) {
                return null;
            }
            String toolName = extractToolName(body);
            if (toolName != null && isUserDirectMutation(headers) && isWorkspaceUserMutationTool(toolName)) {
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
            String approvalRequestId = headers.getFirst("X-Xihe-Approval-Request-Id");
            OperationItem item = operationService.findItemByApprovalRequestId(approvalRequestId);
            if (item == null) {
                item = operationService.appendItem(
                        operationId, toolCallId, null, "tool_call", toolName, "mcp",
                        safeLedgerPreview(body), null, null);
            }
            if (List.of("completed", "failed", "aborted", "cancelled", "ambiguous")
                    .contains(item.getStatus())) {
                return null;
            }
            if ("pending".equals(item.getStatus())) {
                operationService.transitionItem(item.getId(), "running", "allow", null, null, null);
            }
            String requestId = headers.getFirst("X-Request-Id");
            OperationAttempt attempt = operationService.startAttempt(
                    item.getId(), "cp_forward", null, "cp", requestId);
            return new LedgerAttempt(item.getId(), attempt.getId());
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=operation_mcp_attempt_start_failed sessionId={}", sessionId, e);
            throw e;
        }
    }

    private void finishLedgerAttempt(LedgerAttempt ledgerAttempt, int httpStatus, String errorCode) {
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
            }
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=operation_mcp_attempt_finish_failed attemptId={}",
                    ledgerAttempt.attemptId(), e);
        }
    }

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

    private String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest((value == null ? "" : value).getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private String safeLedgerPreview(String body) {
        String redacted = LogRedactor.redact(body == null ? "" : body);
        return redacted.length() <= 4096 ? redacted : redacted.substring(0, 4096);
    }

    private void copyOperationHeaders(HttpHeaders headers, HttpRequest.Builder builder) {
        for (String headerName : List.of("X-Operation-Id", "X-Operation-Item-Id", "X-Operation-Attempt-Id")) {
            String value = headers.getFirst(headerName);
            if (value != null && !value.isBlank()) {
                builder.header(headerName, value);
            }
        }
    }

    private record LedgerAttempt(UUID itemId, UUID attemptId) {}

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
        String method = extractMethod(body);
        LedgerAttempt ledgerAttempt = startLedgerAttempt(body, headers, sessionId);
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
            HttpRequest forwardRequest = forwardBuilder
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(request)))
                    .timeout(Duration.ofSeconds(30))
                    .build();
            HttpResponse<String> response = httpClient.send(forwardRequest, HttpResponse.BodyHandlers.ofString());
            finishLedgerAttempt(ledgerAttempt, response.statusCode(), null);
            appendMcpExtension(ledgerAttempt, server.getId().toString(), body,
                    response.statusCode(), response.body(), null, headers.getFirst("MCP-Protocol-Version"));
            HttpHeaders responseHeaders = new HttpHeaders();
            responseHeaders.set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
            audit.record(sessionId, method, "allow",
                    aliasDetail(server.getId().toString(), request.path("tool").asText(""), currentGeneration(wsId)));
            return new ResponseEntity<>(response.body(), responseHeaders,
                    HttpStatus.valueOf(response.statusCode()));
        } catch (Exception e) {
            // A transport failure after dispatch cannot prove whether the tool ran.
            finishLedgerAttempt(ledgerAttempt, 502, "REMOTE_MCP_UNKNOWN");
            appendMcpExtension(ledgerAttempt, server.getId().toString(), body,
                    502, null, "REMOTE_MCP_UNKNOWN", headers.getFirst("MCP-Protocol-Version"));
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

    private void refreshCacheIfNeeded(String wsId) {
        Instant lastRefresh = cacheTimestamps.get(wsId);
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
                workspaceId, userId, applicationSessionId, gatewaySessionId));
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

    private String readMcpConfig(String wsId) {
        Optional<ConfigEntity> opt = configRepo
            .findByEnvironmentAndLayerAndDomainAndConfigKey(wsId, "workspace", "mcp", "mcpServers");
        return opt.map(ConfigEntity::getMcpConfig).orElse(null);
    }

    private String signSessionId(String wsId, String rawSessionId) {
        try {
            long timestamp = Instant.now().getEpochSecond();
            String payload = wsId + ":" + rawSessionId + ":" + timestamp;
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            SecretKeySpec key = new SecretKeySpec(HMAC_SECRET.getBytes(StandardCharsets.UTF_8), HMAC_ALGORITHM);
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
            SecretKeySpec key = new SecretKeySpec(HMAC_SECRET.getBytes(StandardCharsets.UTF_8), HMAC_ALGORITHM);
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
            String workspaceId, String userId, String applicationSessionId, String mcpSessionId) {
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
