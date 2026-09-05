package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;

@RestController
public class ConfigController {

    private static final Logger log = LoggerFactory.getLogger(ConfigController.class);

    private final ConfigService configService;
    private final ConfigJpaRepository configRepo;
    private final WorkspaceService workspaceService;
    private final ObjectMapper objectMapper;

    public ConfigController(ConfigService configService, ConfigJpaRepository configRepo,
                            WorkspaceService workspaceService, ObjectMapper objectMapper) {
        this.configService = configService;
        this.configRepo = configRepo;
        this.workspaceService = workspaceService;
        this.objectMapper = objectMapper;
    }

    private static final Set<String> SENSITIVE_DOMAINS = Set.of("llm-provider", "embedding");

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

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/config/{domain}")
    public ResponseEntity<Map<String, String>> getConfig(@PathVariable String domain) {
        Map<String, String> resolved = configService.resolveDomain("default", domain);
        if (SENSITIVE_DOMAINS.contains(domain)) {
            Map<String, String> masked = new LinkedHashMap<>();
            for (Map.Entry<String, String> e : resolved.entrySet()) {
                masked.put(e.getKey(), maskIfNotAdmin(e.getKey(), e.getValue()));
            }
            return ResponseEntity.ok(masked);
        }
        return ResponseEntity.ok(resolved);
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PutMapping("/api/v1/config/admin/{domain}")
    public ResponseEntity<Map<String, Object>> putAdminConfig(
            @PathVariable String domain,
            @RequestBody Map<String, String> body) {
        try {
            configService.putLayer("default", "admin", domain, body, "admin");
            log.info("Admin config updated: domain={}, keys={}", domain, body.size());
            return ResponseEntity.ok(Map.of("status", "ok", "keys", body.size()));
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Configuration update is invalid");
        }
    }

    private static final Set<String> USER_WRITABLE_DOMAINS = Set.of(
        "user-preference", "llm-provider", "embedding", "logging", "workspace-config", "rag");

    @PreAuthorize("hasRole('USER')")
    @PutMapping("/api/v1/config/user/{domain}")
    public ResponseEntity<Map<String, Object>> putUserConfig(
            @PathVariable String domain,
            @RequestBody Map<String, String> body) {
        if (!USER_WRITABLE_DOMAINS.contains(domain)) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "Configuration domain is not writable");
        }
        try {
            configService.putLayer("default", "user", domain, body, "user");
            log.info("User config updated: domain={}, keys={}", domain, body.size());
            return ResponseEntity.ok(Map.of("status", "ok", "keys", body.size()));
        } catch (ConfigService.ConfigOwnershipException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.FORBIDDEN,
                    "CONFIG_OWNERSHIP_VIOLATION",
                    "Provider credentials belong to the admin layer");
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Configuration update is invalid");
        }
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/api/v1/config/import")
    public ResponseEntity<Map<String, Object>> importConfig(
            @RequestBody String jsoncContent) {
        if (jsoncContent.length() > 1_048_576) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "Import content exceeds the size limit");
        }
        try {
            configService.importJsonc(jsoncContent, "admin");
            log.info("Config imported via POST body ({} chars)", jsoncContent.length());
            return ResponseEntity.ok(Map.of("status", "ok"));
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Configuration import is invalid");
        }
    }

    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/api/v1/config/export")
    public ResponseEntity<String> exportConfig(
            @RequestParam(value = "layer", defaultValue = "admin") String layer) {
        String jsonc = configService.exportJsonc(layer);
        return ResponseEntity.ok()
            .header("Content-Type", "application/json")
            .body(jsonc);
    }

    @GetMapping("/internal/v1/config/{layer}/{domain}")
    public ResponseEntity<Map<String, String>> getInternalConfig(
            @PathVariable String layer,
            @PathVariable String domain) {
        if (!List.of("system", "admin", "user").contains(layer)) {
            return ResponseEntity.badRequest().build();
        }
        List<ConfigEntity> configs = configRepo.findByEnvironmentAndLayerAndDomain(
            "default", layer, domain);
        Map<String, String> entries = new LinkedHashMap<>();
        for (ConfigEntity e : configs) {
            entries.put(e.getConfigKey(), e.getConfigValue());
        }
        return ResponseEntity.ok(entries);
    }

    @GetMapping("/api/v1/providers")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<List<ProviderConfig>> getProvidersCompat() {
        Map<String, String> merged = configService.resolveDomain("default", "llm-provider");
        List<ProviderConfig> result = new ArrayList<>();
        String baseUrl = merged.getOrDefault("baseUrl", "");
        String[] providerKeys = {"openai", "deepseek", "xiaomi", "anthropic", "dashscope"};
        for (String p : providerKeys) {
            String apiKey = merged.get(p + "ApiKey");
            if (apiKey != null && !apiKey.isEmpty()) {
                result.add(new ProviderConfig(
                        p,
                        isAdmin() ? apiKey : maskIfNotAdmin(p + "ApiKey", apiKey),
                        isAdmin() ? baseUrl : ""));
            }
        }
        return ResponseEntity.ok(result);
    }

    @PutMapping("/api/v1/providers")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Map<String, Object>> updateProvidersCompat(
            @RequestBody List<ProviderConfig> configs) {
        Map<String, String> entries = new LinkedHashMap<>();
        for (ProviderConfig pc : configs) {
            String key = pc.provider() + "ApiKey";
            entries.put(key, pc.apiKey());
        }
        configService.putLayer("default", "admin", "llm-provider", entries, "admin");
        return ResponseEntity.ok(Map.of("status", "ok", "count", configs.size()));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/workspaces/{workspaceId}/mcp-config")
    public ResponseEntity<Map<String, Object>> getMcpConfig(@PathVariable("workspaceId") String wsId) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    org.springframework.http.HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        workspaceService.requireAccessibleWorkspace(wsId, userId);
        return getMcpConfigForWorkspace(wsId);
    }

    @GetMapping("/internal/v1/config/workspaces/{workspaceId}/mcp-config")
    public ResponseEntity<Map<String, Object>> getInternalMcpConfig(
            @PathVariable("workspaceId") String wsId) {
        workspaceService.requireActiveWorkspace(wsId);
        return getMcpConfigForWorkspace(wsId);
    }

    private ResponseEntity<Map<String, Object>> getMcpConfigForWorkspace(String wsId) {
        Optional<ConfigEntity> opt = configRepo
            .findByEnvironmentAndLayerAndDomainAndConfigKey(wsId, "workspace", "mcp", "mcpServers");
        if (opt.isEmpty() || opt.get().getMcpConfig() == null) {
            return ResponseEntity.ok(Map.of("mcpServers", Map.of()));
        }
        try {
            JsonNode root = objectMapper.readTree(opt.get().getMcpConfig());
            JsonNode servers = root == null ? null : root.get("mcpServers");
            if (servers == null || !servers.isObject()) {
                log.error("Persisted MCP config is not an envelope for workspace {}", wsId);
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.INTERNAL_SERVER_ERROR, "INVALID_MCP_CONFIG", "Persisted MCP configuration is invalid");
            }
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("mcpServers", objectMapper.convertValue(
                    servers, new TypeReference<Map<String, Object>>() { }));
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to read MCP config for workspace {}", wsId, e);
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.INTERNAL_SERVER_ERROR, "INVALID_MCP_CONFIG", "Persisted MCP configuration is invalid");
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PutMapping("/api/v1/workspaces/{workspaceId}/mcp-config")
    public ResponseEntity<Map<String, Object>> putMcpConfig(
            @PathVariable("workspaceId") String wsId,
            @RequestBody Map<String, Object> body) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    org.springframework.http.HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        workspaceService.requireAccessibleWorkspace(wsId, userId);
        Object raw = body == null ? null : body.get("mcpServers");
        if (!(raw instanceof Map<?, ?>)) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "mcpServers is required");
        }
        String jsonStr;
        try {
            Map<String, Object> envelope = new LinkedHashMap<>();
            envelope.put("mcpServers", raw);
            jsonStr = objectMapper.writeValueAsString(envelope);
        } catch (Exception e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "MCP configuration is invalid");
        }

        Optional<ConfigEntity> opt = configRepo
            .findByEnvironmentAndLayerAndDomainAndConfigKey(wsId, "workspace", "mcp", "mcpServers");
        ConfigEntity entity = opt.orElseGet(ConfigEntity::new);
        if (opt.isEmpty()) {
            entity.setEnvironment(wsId);
            entity.setLayer("workspace");
            entity.setDomain("mcp");
            entity.setConfigKey("mcpServers");
        }
        entity.setMcpConfig(jsonStr);
        entity.setUpdatedBy(userId);
        configRepo.save(entity);
        log.info("MCP config saved for workspace {}: {} chars", wsId, jsonStr.length());
        return ResponseEntity.ok(Map.of("status", "ok"));
    }
}
