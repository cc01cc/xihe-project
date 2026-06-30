package com.cc01cc.p.xihe.cp.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
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

@RestController
public class ConfigController {

    private static final Logger log = LoggerFactory.getLogger(ConfigController.class);

    private final ConfigService configService;
    private final ConfigJpaRepository configRepo;

    public ConfigController(ConfigService configService, ConfigJpaRepository configRepo) {
        this.configService = configService;
        this.configRepo = configRepo;
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
    @GetMapping("/config/{domain}")
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
    @PutMapping("/config/admin/{domain}")
    public ResponseEntity<Map<String, Object>> putAdminConfig(
            @PathVariable String domain,
            @RequestBody Map<String, String> body) {
        try {
            configService.putLayer("default", "admin", domain, body, "admin");
            log.info("Admin config updated: domain={}, keys={}", domain, body.size());
            return ResponseEntity.ok(Map.of("status", "ok", "keys", body.size()));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of(
                "status", "error", "message", e.getMessage()));
        }
    }

    private static final Set<String> USER_WRITABLE_DOMAINS = Set.of(
        "user-preference", "llm-provider", "embedding", "logging", "workspace-config", "rag");

    @PreAuthorize("hasRole('USER')")
    @PutMapping("/config/user/{domain}")
    public ResponseEntity<Map<String, Object>> putUserConfig(
            @PathVariable String domain,
            @RequestBody Map<String, String> body) {
        if (!USER_WRITABLE_DOMAINS.contains(domain)) {
            return ResponseEntity.badRequest().body(Map.of(
                "status", "error", "message", "User cannot write domain: " + domain));
        }
        try {
            configService.putLayer("default", "user", domain, body, "user");
            log.info("User config updated: domain={}, keys={}", domain, body.size());
            return ResponseEntity.ok(Map.of("status", "ok", "keys", body.size()));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of(
                "status", "error", "message", e.getMessage()));
        }
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/config/import")
    public ResponseEntity<Map<String, Object>> importConfig(
            @RequestBody String jsoncContent) {
        if (jsoncContent.length() > 1_048_576) {
            return ResponseEntity.badRequest().body(Map.of(
                "status", "error", "message", "Import content exceeds 1MB limit"));
        }
        try {
            configService.importJsonc(jsoncContent, "admin");
            log.info("Config imported via POST body ({} chars)", jsoncContent.length());
            return ResponseEntity.ok(Map.of("status", "ok"));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of(
                "status", "error", "message", e.getMessage()));
        }
    }

    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/config/export")
    public ResponseEntity<String> exportConfig(
            @RequestParam(value = "layer", defaultValue = "admin") String layer) {
        String jsonc = configService.exportJsonc(layer);
        return ResponseEntity.ok()
            .header("Content-Type", "application/json")
            .body(jsonc);
    }

    @GetMapping("/internal/config/{layer}/{domain}")
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

    @GetMapping("/providers")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<List<ProviderConfig>> getProvidersCompat() {
        Map<String, String> merged = configService.resolveDomain("default", "llm-provider");
        List<ProviderConfig> result = new ArrayList<>();
        String baseUrl = merged.getOrDefault("baseUrl", "");
        String[] providerKeys = {"openai", "deepseek", "xiaomi", "anthropic", "dashscope"};
        for (String p : providerKeys) {
            String apiKey = merged.get(p + "ApiKey");
            if (apiKey != null && !apiKey.isEmpty()) {
                result.add(new ProviderConfig(p, apiKey, baseUrl));
            }
        }
        return ResponseEntity.ok(result);
    }

    @PutMapping("/providers")
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
    @GetMapping("/workspaces/{wsId}/mcp-config")
    public ResponseEntity<Map<String, Object>> getMcpConfig(@PathVariable String wsId) {
        Optional<ConfigEntity> opt = configRepo
            .findByEnvironmentAndLayerAndDomainAndConfigKey(wsId, "workspace", "mcp", "mcpServers");
        if (opt.isPresent() && opt.get().getMcpConfig() != null) {
            return ResponseEntity.ok(Map.of("mcpServers", opt.get().getMcpConfig()));
        }
        return ResponseEntity.ok(Map.of());
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PutMapping("/workspaces/{wsId}/mcp-config")
    public ResponseEntity<Map<String, Object>> putMcpConfig(
            @PathVariable String wsId,
            @RequestBody Map<String, Object> body) {
        Object raw = body.get("mcpServers");
        if (raw == null) {
            return ResponseEntity.badRequest().body(
                Map.of("status", "error", "message", "Missing 'mcpServers' key"));
        }
        String jsonStr;
        try {
            jsonStr = new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(raw);
        } catch (Exception e) {
            return ResponseEntity.badRequest().body(
                Map.of("status", "error", "message", "Invalid JSON: " + e.getMessage()));
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
        entity.setUpdatedBy("user");
        configRepo.save(entity);
        log.info("MCP config saved for workspace {}: {} chars", wsId, jsonStr.length());
        return ResponseEntity.ok(Map.of("status", "ok"));
    }
}
