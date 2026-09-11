package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.entity.McpStdioServer;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;

/**
 * PLAN-0307: config management surface (UI) + effective endpoint (execution
 * modules). Layers are visible here only; Agent/Runtime consume the merged
 * effective view (decision #19).
 */
@RestController
public class ConfigController {

    private static final Logger log = LoggerFactory.getLogger(ConfigController.class);

    private final ConfigService configService;
    private final WorkspaceService workspaceService;
    private final ObjectMapper objectMapper;
    private final McpStdioServerRepository stdioRepo;
    private final McpServerRepository remoteRepo;

    public ConfigController(ConfigService configService,
                            WorkspaceService workspaceService,
                            ObjectMapper objectMapper,
                            McpStdioServerRepository stdioRepo,
                            McpServerRepository remoteRepo) {
        this.configService = configService;
        this.workspaceService = workspaceService;
        this.objectMapper = objectMapper;
        this.stdioRepo = stdioRepo;
        this.remoteRepo = remoteRepo;
    }

    /** Decision #33: agent-runtime (instructions / workersDir) is not readable by non-admins. */
    private static final Set<String> ADMIN_ONLY_READ_DOMAINS = Set.of("agent-runtime");

    private static boolean isAdmin() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null) return false;
        return auth.getAuthorities().stream()
            .map(GrantedAuthority::getAuthority)
            .anyMatch(r -> r.equals("ROLE_ADMIN"));
    }

    private static String maskIfNotAdmin(String key, String value) {
        if (value == null || value.isEmpty() || isAdmin()) return value;
        if (key.toLowerCase().contains("apikey") || key.toLowerCase().contains("secret")) {
            if (value.length() > 8) {
                return value.substring(0, 3) + "****" + value.substring(value.length() - 4);
            }
            return "****";
        }
        return value;
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) return null;
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new ConfigService.ConfigAccessException("Invalid identifier: " + value);
        }
    }

    private static UUID currentUserId() {
        return parseUuid(TenantContext.getUserId());
    }

    private static String currentWorkspaceId(String headerWorkspaceId, String queryWorkspaceId) {
        if (headerWorkspaceId != null && !headerWorkspaceId.isBlank()) {
            return headerWorkspaceId;
        }
        if (queryWorkspaceId != null && !queryWorkspaceId.isBlank()) {
            return queryWorkspaceId;
        }
        return TenantContext.getWorkspaceId();
    }

    // ------------------------------------------------------------------
    // Read (UI)
    // ------------------------------------------------------------------

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/config/{domain}")
    public ResponseEntity<Map<String, Object>> getConfig(
            @PathVariable String domain,
            @RequestParam(value = "layer", required = false) String layer,
            @RequestParam(value = "workspaceId", required = false) String queryWorkspaceId,
            @RequestHeader(value = "X-Workspace-Id", required = false) String headerWorkspaceId) {
        if (!ConfigService.DOMAINS.contains(domain)) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_DOMAIN", "Unknown config domain");
        }
        UUID userId = currentUserId();
        String wsId = currentWorkspaceId(headerWorkspaceId, queryWorkspaceId);
        UUID workspaceId = null;
        if (wsId != null && !wsId.isBlank()) {
            if (userId == null) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
            }
            workspaceService.requireAccessibleWorkspace(wsId, userId.toString());
            workspaceId = parseUuid(wsId);
        }

        Map<String, String> raw;
        try {
            raw = layer != null
                    ? readLayer(domain, layer, userId, workspaceId)
                    : configService.resolveDomain(domain, userId, workspaceId);
        } catch (ConfigService.ConfigAccessException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.FORBIDDEN, "FORBIDDEN", "Configuration layer is not readable");
        }
        if (raw == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.FORBIDDEN, "FORBIDDEN", "Configuration layer is not readable");
        }

        Map<String, Object> shaped = new LinkedHashMap<>();
        boolean hideAll = !isAdmin() && ADMIN_ONLY_READ_DOMAINS.contains(domain);
        for (Map.Entry<String, String> e : raw.entrySet()) {
            if (hideAll) {
                shaped.put(e.getKey(), "****");
            } else {
                shaped.put(e.getKey(), maskIfNotAdmin(e.getKey(), e.getValue()));
            }
        }
        return ResponseEntity.ok(shaped);
    }

    private Map<String, String> readLayer(String domain, String layer, UUID userId, UUID workspaceId) {
        return switch (layer) {
            case "instance" -> configService.layerEntries("instance", domain, null, null);
            case "user" -> userId == null
                    ? null
                    : configService.layerEntries("user", domain, userId, null);
            case "workspace" -> workspaceId == null
                    ? null
                    : configService.layerEntries("workspace", domain, null, workspaceId);
            default -> throw new ConfigService.ConfigAccessException("Unknown config layer: " + layer);
        };
    }

    // ------------------------------------------------------------------
    // Write (UI)
    // ------------------------------------------------------------------

    @PreAuthorize("hasRole('ADMIN')")
    @PutMapping("/api/v1/config/instance/{domain}")
    public ResponseEntity<Map<String, Object>> putInstanceConfig(
            @PathVariable String domain,
            @RequestBody Map<String, String> body) {
        return writeLayer("instance", domain, body, "admin", null, null);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PutMapping("/api/v1/config/user/{domain}")
    public ResponseEntity<Map<String, Object>> putUserConfig(
            @PathVariable String domain,
            @RequestBody Map<String, String> body) {
        UUID userId = currentUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "User context is required");
        }
        return writeLayer("user", domain, body, "user", userId, null);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PutMapping("/api/v1/config/workspace/{domain}")
    public ResponseEntity<Map<String, Object>> putWorkspaceConfig(
            @PathVariable String domain,
            @RequestParam(value = "workspaceId", required = false) String queryWorkspaceId,
            @RequestHeader(value = "X-Workspace-Id", required = false) String headerWorkspaceId,
            @RequestBody Map<String, String> body) {
        UUID userId = currentUserId();
        String wsId = currentWorkspaceId(headerWorkspaceId, queryWorkspaceId);
        if (userId == null || wsId == null || wsId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        workspaceService.requireAccessibleWorkspace(wsId, userId.toString());
        return writeLayer("workspace", domain, body, "user", null, parseUuid(wsId));
    }

    private ResponseEntity<Map<String, Object>> writeLayer(
            String layer, String domain, Map<String, String> body, String changedBy,
            UUID userId, UUID workspaceId) {
        try {
            configService.putLayer(layer, domain, body, changedBy, userId, workspaceId);
            log.info("Config updated: layer={}, domain={}, keys={}", layer, domain, body.size());
            return ResponseEntity.ok(Map.of("status", "ok", "keys", body.size()));
        } catch (ConfigService.ConfigOwnershipException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.FORBIDDEN,
                    "CONFIG_OWNERSHIP_VIOLATION",
                    "Provider credentials belong to provider_connections");
        } catch (ConfigService.ConfigAccessException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.FORBIDDEN, "FORBIDDEN", "Configuration write is not allowed");
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Configuration update is invalid");
        }
    }

    // ------------------------------------------------------------------
    // Import / export (management plane, instance layer)
    // ------------------------------------------------------------------

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/api/v1/config/import")
    public ResponseEntity<Map<String, Object>> importConfig(
            @RequestParam(value = "layer", defaultValue = "instance") String layer,
            @RequestBody String jsoncContent) {
        if (!"instance".equals(layer)) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Only the instance layer can be imported");
        }
        if (jsoncContent.length() > 1_048_576) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "Import content exceeds the size limit");
        }
        try {
            configService.importJsonc(jsoncContent, "instance", null, null);
            log.info("Config imported via POST body ({} chars)", jsoncContent.length());
            return ResponseEntity.ok(Map.of("status", "ok"));
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Configuration import is invalid");
        }
    }

    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/api/v1/config/export")
    public ResponseEntity<?> exportConfig(
            @RequestParam(value = "layer", defaultValue = "instance") String layer) {
        if (!"instance".equals(layer)) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Only the instance layer can be exported");
        }
        String jsonc = configService.exportJsonc("instance", null, null);
        return ResponseEntity.ok()
            .header("Content-Type", "application/json")
            .body(jsonc);
    }

    // ------------------------------------------------------------------
    // Effective endpoint (execution modules, decision #19)
    // ------------------------------------------------------------------

    @GetMapping("/internal/v1/config/effective/{domain}")
    public ResponseEntity<Map<String, Object>> getEffectiveConfig(
            @PathVariable String domain,
            @RequestParam(value = "userId", required = false) String queryUserId,
            @RequestParam(value = "workspaceId", required = false) String queryWorkspaceId) {
        if (!ConfigService.DOMAINS.contains(domain)) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_DOMAIN", "Unknown config domain");
        }
        ConfigService.EffectiveConfig effective;
        try {
            effective = configService.effective(
                    domain, parseUuid(queryUserId), parseUuid(queryWorkspaceId));
        } catch (ConfigService.ConfigAccessException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Invalid config context");
        }
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("domain", effective.domain());
        response.put("revision", effective.revision());
        response.put("source", effective.source());
        response.put("entries", effective.entries());
        return ResponseEntity.ok(response);
    }

    // ------------------------------------------------------------------
    // MCP stdio servers (decision #27)
    // ------------------------------------------------------------------

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/workspaces/{workspaceId}/stdio-servers")
    public ResponseEntity<Map<String, Object>> getStdioServers(
            @PathVariable("workspaceId") String wsId) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        workspaceService.requireAccessibleWorkspace(wsId, userId);
        try {
            StdioSnapshot snapshot = stdioSnapshot(wsId);
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("generation", snapshot.generation());
            response.put("hash", snapshot.hash());
            response.put("servers", plainServers(snapshot.servers()));
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to read stdio servers for workspace {}", wsId, e);
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.INTERNAL_SERVER_ERROR, "INVALID_MCP_CONFIG", "Persisted MCP configuration is invalid");
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PutMapping("/api/v1/workspaces/{workspaceId}/stdio-servers")
    public ResponseEntity<Map<String, Object>> putStdioServers(
            @PathVariable("workspaceId") String wsId,
            @RequestBody Map<String, Object> body) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        workspaceService.requireAccessibleWorkspace(wsId, userId);

        Object rawServers = body == null ? null : body.get("servers");
        if (!(rawServers instanceof Map<?, ?> servers)) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "servers is required");
        }
        Object rawGeneration = body.get("generation");
        Long expectedGeneration = rawGeneration instanceof Number number
                ? number.longValue()
                : null;
        if (expectedGeneration == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "generation is required");
        }

        try {
            StdioSnapshot current = stdioSnapshot(wsId);
            if (current.generation() != expectedGeneration) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.CONFLICT, "GENERATION_CONFLICT", "MCP configuration was updated concurrently");
            }
            Map<String, JsonNode> next = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : servers.entrySet()) {
                if (!(entry.getKey() instanceof String name) || entry.getValue() == null) {
                    return ProblemDetailsHandler.problemResponse(
                            HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Invalid stdio server entry");
                }
                JsonNode node = objectMapper.valueToTree(entry.getValue());
                if (!node.isObject()) {
                    return ProblemDetailsHandler.problemResponse(
                            HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Stdio server config must be an object");
                }
                next.put(name, node);
            }
            replaceStdioServers(wsId, next);
            StdioSnapshot updated = stdioSnapshot(wsId);
            return ResponseEntity.ok(Map.of(
                    "status", "ok",
                    "generation", updated.generation(),
                    "hash", updated.hash()));
        } catch (Exception e) {
            log.error("Failed to persist stdio servers for workspace {}", wsId, e);
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "MCP configuration is invalid");
        }
    }

    @GetMapping("/internal/v1/workspaces/{workspaceId}/stdio-servers")
    public ResponseEntity<Map<String, Object>> getInternalStdioServers(
            @PathVariable("workspaceId") String wsId) {
        workspaceService.requireActiveWorkspace(wsId);
        try {
            StdioSnapshot snapshot = stdioSnapshot(wsId);
            List<Map<String, Object>> servers = new ArrayList<>();
            for (Map.Entry<String, JsonNode> entry : snapshot.servers().entrySet()) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("name", entry.getKey());
                item.put("config", objectMapper.convertValue(entry.getValue(), Object.class));
                servers.add(item);
            }
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("generation", snapshot.generation());
            response.put("hash", snapshot.hash());
            response.put("servers", servers);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to build stdio server view for workspace {}", wsId, e);
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.INTERNAL_SERVER_ERROR, "INVALID_MCP_CONFIG", "Persisted MCP configuration is invalid");
        }
    }

    private record StdioSnapshot(long generation, String hash, Map<String, JsonNode> servers) {}

    private StdioSnapshot stdioSnapshot(String wsId) throws Exception {
        List<McpStdioServer> rows = stdioRepo.findByWorkspaceIdOrderByNameAsc(wsId);
        Map<String, JsonNode> servers = new LinkedHashMap<>();
        long generation = 0L;
        for (McpStdioServer row : rows) {
            servers.put(row.getName(), row.getConfig());
            if (row.getUpdatedAt() != null) {
                generation = Math.max(generation, row.getUpdatedAt().toEpochMilli());
            }
        }
        String hash = "sha256:" + sha256(objectMapper.writeValueAsString(servers));
        return new StdioSnapshot(generation, hash, servers);
    }

    private Map<String, Object> plainServers(Map<String, JsonNode> servers) {
        Map<String, Object> plain = new LinkedHashMap<>();
        for (Map.Entry<String, JsonNode> entry : servers.entrySet()) {
            plain.put(entry.getKey(), objectMapper.convertValue(entry.getValue(), Object.class));
        }
        return plain;
    }

    private void replaceStdioServers(String wsId, Map<String, JsonNode> next) {
        List<McpStdioServer> existing = stdioRepo.findByWorkspaceIdOrderByNameAsc(wsId);
        for (McpStdioServer row : existing) {
            if (!next.containsKey(row.getName())) {
                stdioRepo.delete(row);
            }
        }
        for (Map.Entry<String, JsonNode> entry : next.entrySet()) {
            McpStdioServer row = stdioRepo.findByWorkspaceIdAndName(wsId, entry.getKey())
                    .orElseGet(() -> new McpStdioServer(wsId, entry.getKey(), entry.getValue()));
            row.setConfig(entry.getValue());
            stdioRepo.save(row);
        }
    }

    private static String sha256(String value) throws NoSuchAlgorithmException {
        byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
        return HexFormat.of().formatHex(digest);
    }

    // ------------------------------------------------------------------
    // Legacy mixed mcp-config endpoint (Claude Desktop paste experience)
    // ------------------------------------------------------------------

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/workspaces/{workspaceId}/mcp-config")
    public ResponseEntity<Map<String, Object>> getMcpConfig(@PathVariable("workspaceId") String wsId) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        workspaceService.requireAccessibleWorkspace(wsId, userId);
        return getMixedMcpConfig(wsId);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PutMapping("/api/v1/workspaces/{workspaceId}/mcp-config")
    public ResponseEntity<Map<String, Object>> putMcpConfig(
            @PathVariable("workspaceId") String wsId,
            @RequestBody Map<String, Object> body) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        workspaceService.requireAccessibleWorkspace(wsId, userId);
        Object raw = body == null ? null : body.get("mcpServers");
        if (!(raw instanceof Map<?, ?> servers)) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "mcpServers is required");
        }
        Map<String, JsonNode> stdio = new LinkedHashMap<>();
        Map<String, String> remoteEndpoints = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : servers.entrySet()) {
            if (!(entry.getKey() instanceof String name) || !(entry.getValue() instanceof Map<?, ?> value)) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Invalid mcpServers entry");
            }
            boolean hasCommand = value.containsKey("command") || value.containsKey("args");
            boolean hasRemote = value.containsKey("url") || value.containsKey("endpoint")
                    || "http".equals(value.get("type"));
            if (hasCommand && hasRemote) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "MCP server entry mixes stdio and remote fields: " + name);
            }
            if (hasCommand) {
                stdio.put(name, objectMapper.valueToTree(value));
            } else if (hasRemote) {
                Object endpoint = value.containsKey("url") ? value.get("url") : value.get("endpoint");
                if (!(endpoint instanceof String url) || url.isBlank()) {
                    return ProblemDetailsHandler.problemResponse(
                            HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Remote MCP server requires a url");
                }
                remoteEndpoints.put(name, url);
            } else {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "MCP server entry has neither stdio nor remote fields: " + name);
            }
        }
        replaceStdioServers(wsId, stdio);
        for (Map.Entry<String, String> entry : remoteEndpoints.entrySet()) {
            McpServer row = remoteRepo.findByWorkspaceIdAndName(wsId, entry.getKey())
                    .orElseGet(() -> new McpServer(wsId, entry.getKey(), entry.getValue()));
            row.setEndpoint(entry.getValue());
            row.setEnabled(true);
            remoteRepo.save(row);
        }
        log.info("MCP config saved for workspace {}: stdio={}, remote={}",
                wsId, stdio.size(), remoteEndpoints.size());
        return ResponseEntity.ok(Map.of("status", "ok"));
    }

    private ResponseEntity<Map<String, Object>> getMixedMcpConfig(String wsId) {
        try {
            Map<String, Object> servers = new LinkedHashMap<>();
            for (McpStdioServer row : stdioRepo.findByWorkspaceIdOrderByNameAsc(wsId)) {
                servers.put(row.getName(), objectMapper.convertValue(row.getConfig(), Object.class));
            }
            for (McpServer row : remoteRepo.findByWorkspaceIdAndEnabledTrue(wsId)) {
                Map<String, Object> value = new LinkedHashMap<>();
                value.put("url", row.getEndpoint());
                value.put("type", "http");
                servers.putIfAbsent(row.getName(), value);
            }
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("mcpServers", servers);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to read MCP config for workspace {}", wsId, e);
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.INTERNAL_SERVER_ERROR, "INVALID_MCP_CONFIG", "Persisted MCP configuration is invalid");
        }
    }
}
