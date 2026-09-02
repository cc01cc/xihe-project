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
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;

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
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

@RestController
public class McpProxyController {

    private static final Logger logger = LoggerFactory.getLogger(McpProxyController.class);
    private static final Duration CACHE_TTL = Duration.ofMinutes(5);
    private static final String HMAC_ALGORITHM = "HmacSHA256";
    private static final String HMAC_SECRET = "xihe-mcp-session-hmac-key-2026";

    private final HttpClient httpClient;
    private final RequestRewriter rewriter;
    private final PolicyEngine policy;
    private final AuditLogger audit;
    private final ObjectMapper objectMapper;
    private final SseEmitterManager sse;
    private final ConfigJpaRepository configRepo;

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

    public McpProxyController(
            RequestRewriter rewriter,
            PolicyEngine policy,
            AuditLogger audit,
            ObjectMapper objectMapper,
            SseEmitterManager sse,
            ConfigJpaRepository configRepo,
            WorkspaceService workspaceService,
            SessionRepository sessionRepository) {
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.rewriter = rewriter;
        this.policy = policy;
        this.audit = audit;
        this.objectMapper = objectMapper;
        this.sse = sse;
        this.configRepo = configRepo;
        this.workspaceService = workspaceService;
        this.sessionRepository = sessionRepository;
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

        if ("__system__".equals(serverId)) {
            return forwardToRuntime(wsId, null, body, headers, sessionId, access);
        }

        String rewritten = rewriter.rewrite(toolName, body, sessionId);
        PolicyEngine.PolicyDecision decision = policy.evaluate(toolName, rewritten, sessionId);
        audit.record(sessionId, toolName, "request", rewritten);

        if (decision.getResult() == PolicyEngine.PolicyDecision.PolicyResult.DENY) {
            sse.send(sessionId, "tool_exec_denied",
                Map.of("tool", toolName, "reason", decision.getReason()));
            audit.record(sessionId, toolName, "deny", decision.getReason());
            return problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "Tool execution is not permitted");
        }

        body = rewritten;
        return forwardToRuntime(wsId, serverId, body, headers, sessionId, access);
    }

    private ResponseEntity<String> forwardToRuntime(
            String wsId, String serverId, String body, HttpHeaders headers,
            String sessionId, AccessContext access) {
        try {
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
            logger.error("MCP forward failed: wsId={} serverId={} method={}", wsId, serverId, extractMethod(body), e);
            audit.record(sessionId, extractMethod(body), "error", e.getMessage());
            return problem(HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime MCP request failed");
        }
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
            HttpHeaders headers, String body, boolean allowMissingMcpSession) {
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
                Session session = sessionRepository.findById(applicationSessionId).orElse(null);
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
                Session session = sessionRepository.findById(applicationSessionId).orElse(null);
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

        if (gatewaySessionId == null && !allowMissingMcpSession) {
            return AuthorizationResult.failure(problem(
                    HttpStatus.BAD_REQUEST, "MCP_SESSION_REQUIRED", "MCP session is required"));
        }
        McpSessionBinding binding = gatewaySessionId == null
                ? null : mcpSessionBindings.get(gatewaySessionId);
        if (gatewaySessionId != null && binding == null) {
            return AuthorizationResult.failure(problem(
                    HttpStatus.FORBIDDEN, "MCP_SESSION_NOT_FOUND", "MCP session is not recognized"));
        }
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
