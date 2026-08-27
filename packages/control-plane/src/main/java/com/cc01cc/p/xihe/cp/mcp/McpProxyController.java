package com.cc01cc.p.xihe.cp.mcp;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;

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

    public McpProxyController(
            RequestRewriter rewriter,
            PolicyEngine policy,
            AuditLogger audit,
            ObjectMapper objectMapper,
            SseEmitterManager sse,
            ConfigJpaRepository configRepo) {
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.rewriter = rewriter;
        this.policy = policy;
        this.audit = audit;
        this.objectMapper = objectMapper;
        this.sse = sse;
        this.configRepo = configRepo;
    }

    @PostMapping("/mcp")
    public ResponseEntity<String> proxy(
            @RequestBody String body,
            @RequestHeader HttpHeaders headers) {

        String method = extractMethod(body);
        String sessionId = extractSessionId(headers);
        String wsId = extractWorkspaceId(headers, sessionId);

        if (wsId == null) {
            return ResponseEntity.badRequest().body("{\"error\": \"Missing workspace ID\"}");
        }

        if ("initialize".equals(method)) {
            return handleInitialize(wsId, body, headers, sessionId);
        }
        if ("tools/list".equals(method)) {
            return handleToolsList(wsId, body, headers, sessionId);
        }
        if ("tools/call".equals(method)) {
            return handleToolsCall(wsId, body, headers, sessionId);
        }
        return forwardToRuntime(wsId, null, body, headers, sessionId);
    }

    private ResponseEntity<String> handleInitialize(String wsId, String body, HttpHeaders headers, String sessionId) {
        String token = extractBearerToken(headers);
        if (token == null) {
            return ResponseEntity.status(401).body("{\"error\": \"Missing JWT\"}");
        }
        return forwardToRuntime(wsId, null, body, headers, sessionId);
    }

    private ResponseEntity<String> handleToolsList(String wsId, String body, HttpHeaders headers, String sessionId) {
        refreshCacheIfNeeded(wsId);
        Map<String, String> mapping = toolServerCache.getOrDefault(wsId, Collections.emptyMap());

        try {
            List<Map<String, Object>> allTools = new ArrayList<>();

            // 1. Call system MCP tools/list
            ResponseEntity<String> sysResp = forwardToRuntime(wsId, null, body, headers, sessionId);
            if (sysResp.getStatusCode().is2xxSuccessful()) {
                List<Map<String, Object>> sysTools = extractToolsFromResponse(sysResp.getBody());
                if (sysTools != null) {
                    for (Map<String, Object> tool : sysTools) {
                        String name = (String) tool.get("name");
                        if (name != null) {
                            mapping.put(name, "__system__");
                            allTools.add(tool);
                        }
                    }
                }
            }

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
                        for (String serverId : servers.propertyNames()) {
                            ResponseEntity<String> stdioResp = forwardToRuntime(wsId, serverId, body, headers, sessionId);
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
            return ResponseEntity.status(502).body("{\"error\": \"Failed to merge tools\"}");
        }
    }

    private ResponseEntity<String> handleToolsCall(String wsId, String body, HttpHeaders headers, String sessionId) {
        String toolName = extractToolName(body);
        if (toolName == null) {
            return ResponseEntity.badRequest().body("{\"error\": \"Missing tool name\"}");
        }

        refreshCacheIfNeeded(wsId);
        Map<String, String> mapping = toolServerCache.getOrDefault(wsId, Collections.emptyMap());
        String serverId = mapping.get(toolName);

        if (serverId == null) {
            return ResponseEntity.badRequest().body("{\"error\": \"Unknown tool: " + toolName + "\"}");
        }

        if ("__system__".equals(serverId)) {
            return forwardToRuntime(wsId, null, body, headers, sessionId);
        }

        String rewritten = rewriter.rewrite(toolName, body, sessionId);
        PolicyEngine.PolicyDecision decision = policy.evaluate(toolName, rewritten, sessionId);
        audit.record(sessionId, toolName, "request", rewritten);

        if (decision.getResult() == PolicyEngine.PolicyDecision.PolicyResult.DENY) {
            sse.send(sessionId, "tool_exec_denied",
                Map.of("tool", toolName, "reason", decision.getReason()));
            audit.record(sessionId, toolName, "deny", decision.getReason());
            return ResponseEntity.status(403).body("{\"error\": \"Permission denied: " + decision.getReason() + "\"}");
        }

        body = rewritten;
        return forwardToRuntime(wsId, serverId, body, headers, sessionId);
    }

    private ResponseEntity<String> forwardToRuntime(String wsId, String serverId, String body, HttpHeaders headers, String sessionId) {
        try {
            String path;
            if (serverId == null) {
                path = "/workspace/" + wsId + "/mcp";
            } else {
                path = "/workspace/" + wsId + "/mcp/stdio/" + serverId;
            }

            String requestedAccept = headers.getFirst("Accept");
            String forwardedAccept = requestedAccept != null
                    && requestedAccept.contains(MediaType.APPLICATION_JSON_VALUE)
                    && requestedAccept.contains(MediaType.TEXT_EVENT_STREAM_VALUE)
                ? requestedAccept
                : "application/json, text/event-stream";

            var requestBuilder = HttpRequest.newBuilder()
                .uri(URI.create(runtimeBaseUrl + path))
                .header("Content-Type", "application/json")
                .header("Accept", forwardedAccept)
                .header("Authorization", "Bearer " + runtimeServiceToken);

            for (String headerName : List.of(
                    "MCP-Protocol-Version", "Last-Event-ID", "X-Workspace-Id", "X-Workspace-Path")) {
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
            String workspacePath = TenantContext.getWorkspacePath();
            if (workspacePath != null && !workspacePath.isEmpty()) {
                requestBuilder.header("X-Workspace-Path", workspacePath);
                requestBuilder.header("X-Workspace-Id", TenantContext.getWorkspaceId());
            }

            HttpRequest forwardRequest = requestBuilder
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .timeout(Duration.ofSeconds(30))
                .build();

            HttpResponse<String> response = httpClient.send(forwardRequest, HttpResponse.BodyHandlers.ofString());

            audit.record(sessionId, extractMethod(body), "allow", response.body());

            HttpHeaders responseHeaders = new HttpHeaders();
            String runtimeSessionId = response.headers().firstValue("mcp-session-id").orElse(null);
            if (runtimeSessionId != null && !runtimeSessionId.isEmpty()) {
                String signedGatewaySessionId = signSessionId(wsId, runtimeSessionId);
                runtimeSessionByGatewaySession.put(signedGatewaySessionId, runtimeSessionId);
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
            return ResponseEntity.status(502).body("{\"error\": \"Runtime error: " + e.getMessage() + "\"}");
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
            // Fallback: unsigned (should not happen)
            String payload = wsId + ":" + rawSessionId + ":" + Instant.now().getEpochSecond();
            return Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes());
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
            if (!expectedSigB64.equals(sigB64)) {
                return null;
            }

            // Parse payload
            String payload = new String(Base64.getUrlDecoder().decode(payloadB64), StandardCharsets.UTF_8);
            String[] fields = payload.split(":");
            if (fields.length < 3) {
                return null;
            }
            return fields[0]; // ws_id
        } catch (Exception e) {
            logger.debug("Session-id verification failed: {}", e.getMessage());
            return null;
        }
    }

    private String extractWorkspaceId(HttpHeaders headers, String sessionId) {
        // First try signed session-id (subsequent requests after initialize)
        String mcpSessionId = headers.getFirst("mcp-session-id");
        if (mcpSessionId != null && !mcpSessionId.isEmpty()) {
            String wsId = verifySessionId(mcpSessionId);
            if (wsId != null) {
                return wsId;
            }
        }
        // Fallback: X-Workspace-Id header (initialize request)
        String wsId = headers.getFirst("X-Workspace-Id");
        if (wsId != null && !wsId.isEmpty()) {
            return wsId;
        }
        return TenantContext.getWorkspaceId();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> extractToolsFromResponse(String responseBody) {
        try {
            JsonNode root = objectMapper.readTree(responseBody);
            JsonNode result = root.get("result");
            if (result != null && result.has("tools")) {
                return objectMapper.convertValue(result.get("tools"), List.class);
            }
        } catch (Exception e) {
            logger.debug("Failed to extract tools from response: {}", e.getMessage());
        }
        return null;
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

    private String extractSessionId(HttpHeaders headers) {
        String token = headers.getFirst("mcp-session-id");
        if (token != null && !token.isEmpty()) {
            return token;
        }
        return "default-" + UUID.randomUUID().toString().substring(0, 8);
    }

    private String extractBearerToken(HttpHeaders headers) {
        String auth = headers.getFirst("Authorization");
        if (auth != null && auth.startsWith("Bearer ")) {
            return auth.substring(7);
        }
        return null;
    }
}
