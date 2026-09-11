package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.cc01cc.p.xihe.cp.entity.ConfigAuditEntity;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/**
 * PLAN-0307: three-tier config resolution (workspace > user > instance) with
 * layer encapsulation (decision #19). Execution modules only ever consume the
 * merged effective view; layer concepts stay inside CP and the UI.
 */
@Service
public class ConfigService {

    private static final Logger log = LoggerFactory.getLogger(ConfigService.class);

    /** Eight-domain target set (decision #13/#17/#37). */
    public static final Set<String> DOMAINS = Set.of(
        "llm-provider", "context-policy", "embedding", "rag",
        "agent-runtime", "agent-profile", "user-preference", "logging");

    private static final Set<String> USER_WRITABLE_DOMAINS = Set.of(
        "llm-provider", "context-policy", "embedding", "rag",
        "agent-runtime", "agent-profile", "user-preference");

    private static final Set<String> WORKSPACE_WRITABLE_DOMAINS = Set.of(
        "llm-provider", "context-policy", "embedding", "rag", "agent-runtime");

    /** Decision #17: instructions is instance-level behaviour, never user/workspace writable. */
    private static final Map<String, Set<String>> INSTANCE_ONLY_KEYS = Map.of(
        "agent-runtime", Set.of("instructions"));

    /**
     * Decision #22: env overlay for keys that still have a deployment env source.
     * logging is intentionally absent (decision #23: DB is runtime authority, env bootstraps only).
     */
    private static final Map<String, List<String>> ENV_OVERLAY = Map.of(
        "embedding.model", List.of("XIHE_EMBEDDING_MODEL"));

    /**
     * Decision #24: resolved/effective include code defaults so the UI and the
     * execution modules agree on fallback values.
     */
    private static final Map<String, Map<String, String>> CODE_DEFAULTS = Map.of(
        "rag", Map.of(
            "chunkSize", "1000",
            "chunkOverlap", "200",
            "topK", "5",
            "minScore", "0.0"),
        "embedding", Map.of(
            "model", "text-embedding-3-small",
            "dimensions", "1536"),
        "logging", Map.of(
            "logLevel", "INFO",
            "levelCp", "INFO",
            "levelAgent", "INFO",
            "levelRuntime", "INFO"));

    @Autowired
    private ConfigJpaRepository repo;

    @Autowired
    private ConfigAuditRepository auditRepo;

    @Autowired
    private ProviderConnectionRepository providerConnections;

    @Autowired
    private org.springframework.context.ApplicationEventPublisher events;

    @Autowired
    private ConfigDomainSchema schemaValidator;

    @Autowired
    private ObjectMapper objectMapper;

    public record EffectiveConfig(String domain, String revision, String source,
                                  Map<String, String> entries) {}

    static String stripJsoncComments(String jsonc) {
        String[] lines = jsonc.split("\n", -1);
        StringBuilder sb = new StringBuilder(jsonc.length());
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.startsWith("//")) {
                sb.append('\n');
            } else {
                sb.append(line).append('\n');
            }
        }
        if (sb.length() > 0) sb.setLength(sb.length() - 1);
        return sb.toString();
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    /** Merged view for the current context; env overlay applied (decision #22). */
    public Map<String, String> resolveDomain(String domain, UUID userId, UUID workspaceId) {
        EffectiveConfig effective = effective(domain, userId, workspaceId);
        return effective.entries();
    }

    public String resolve(String domain, String key, UUID userId, UUID workspaceId) {
        String workspaceValue = workspaceId == null ? null
            : keyOf(repo.findByWorkspaceIdAndDomainAndConfigKey(workspaceId, domain, key));
        if (workspaceValue != null) return workspaceValue;
        String userValue = userId == null ? null
            : keyOf(repo.findByUserIdAndDomainAndConfigKey(userId, domain, key));
        if (userValue != null) return userValue;
        String instanceValue = keyOf(repo.findByLayerAndDomainAndConfigKey("instance", domain, key));
        if (instanceValue != null) return instanceValue;
        Map<String, String> defaults = CODE_DEFAULTS.getOrDefault(domain, Map.of());
        return defaults.get(key);
    }

    /** Raw single-layer entries for the UI (?layer=...) — no env overlay, no defaults. */
    public Map<String, String> layerEntries(String layer, String domain, UUID userId, UUID workspaceId) {
        Map<String, String> result = new LinkedHashMap<>();
        for (ConfigEntity entity : rowsForLayer(layer, domain, userId, workspaceId)) {
            result.put(entity.getConfigKey(), entity.getConfigValue());
        }
        return result;
    }

    /**
     * PLAN-0307 T2.7 (decisions #3/#22/#37): run-payload delivery of explicit
     * single-layer rows for the given domains. Env-locked keys are omitted so
     * the receiver's env-derived base keeps winning (executor transparency);
     * domains without explicit rows are omitted entirely.
     */
    public Map<String, Map<String, String>> overrides(String layer, Collection<String> domains,
                                                       UUID userId, UUID workspaceId) {
        Map<String, Map<String, String>> result = new LinkedHashMap<>();
        for (String domain : domains) {
            Map<String, String> entries = layerEntries(layer, domain, userId, workspaceId);
            if (entries.isEmpty()) {
                continue;
            }
            Set<String> envLocked = envOverriddenKeys(domain);
            if (!envLocked.isEmpty()) {
                entries.keySet().removeIf(envLocked::contains);
            }
            if (!entries.isEmpty()) {
                result.put(domain, entries);
            }
        }
        return result;
    }

    /** Keys whose env overlay is currently active for the domain (decision #22). */
    public Set<String> envOverriddenKeys(String domain) {
        Set<String> keys = new LinkedHashSet<>();
        for (Map.Entry<String, List<String>> entry : ENV_OVERLAY.entrySet()) {
            String[] parts = entry.getKey().split("\\.", 2);
            if (parts.length != 2 || !parts[0].equals(domain)) {
                continue;
            }
            for (String envName : entry.getValue()) {
                String value = System.getenv(envName);
                if (value != null && !value.isBlank()) {
                    keys.add(parts[1]);
                    break;
                }
            }
        }
        return keys;
    }

    public EffectiveConfig effective(String domain, UUID userId, UUID workspaceId) {
        Map<String, String> merged = new LinkedHashMap<>();
        List<ConfigEntity> rows = new ArrayList<>();
        String source = "default";

        List<ConfigEntity> instanceRows = rowsForLayer("instance", domain, null, null);
        rows.addAll(instanceRows);
        instanceRows.forEach(e -> merged.put(e.getConfigKey(), e.getConfigValue()));
        if (!instanceRows.isEmpty()) source = "instance";

        List<ConfigEntity> userRows = rowsForLayer("user", domain, userId, null);
        rows.addAll(userRows);
        userRows.forEach(e -> merged.put(e.getConfigKey(), e.getConfigValue()));
        if (!userRows.isEmpty()) source = "user";

        List<ConfigEntity> workspaceRows = rowsForLayer("workspace", domain, null, workspaceId);
        rows.addAll(workspaceRows);
        workspaceRows.forEach(e -> merged.put(e.getConfigKey(), e.getConfigValue()));
        if (!workspaceRows.isEmpty()) source = "workspace";

        if (applyEnvOverlay(domain, merged)) {
            source = "env";
        }

        CODE_DEFAULTS.getOrDefault(domain, Map.of()).forEach(merged::putIfAbsent);
        return new EffectiveConfig(domain, revisionOf(rows), source, merged);
    }

    private boolean applyEnvOverlay(String domain, Map<String, String> merged) {
        boolean applied = false;
        for (Map.Entry<String, List<String>> entry : ENV_OVERLAY.entrySet()) {
            String[] parts = entry.getKey().split("\\.", 2);
            if (parts.length != 2 || !parts[0].equals(domain)) {
                continue;
            }
            for (String envName : entry.getValue()) {
                String value = System.getenv(envName);
                if (value != null && !value.isBlank()) {
                    merged.put(parts[1], value);
                    applied = true;
                    break;
                }
            }
        }
        return applied;
    }

    private static String revisionOf(List<ConfigEntity> rows) {
        long maxUpdatedAt = rows.stream()
            .map(ConfigEntity::getUpdatedAt)
            .filter(Objects::nonNull)
            .mapToLong(java.time.Instant::toEpochMilli)
            .max()
            .orElse(0L);
        return maxUpdatedAt + ":" + rows.size();
    }

    private static String keyOf(Optional<ConfigEntity> entity) {
        return entity.map(ConfigEntity::getConfigValue).orElse(null);
    }

    private List<ConfigEntity> rowsForLayer(String layer, String domain, UUID userId, UUID workspaceId) {
        List<ConfigEntity> rows = new ArrayList<>(switch (layer) {
            case "instance" -> repo.findByLayerAndDomain("instance", domain);
            case "user" -> userId == null ? List.of() : repo.findByUserIdAndDomain(userId, domain);
            case "workspace" -> workspaceId == null ? List.of() : repo.findByWorkspaceIdAndDomain(workspaceId, domain);
            default -> List.of();
        });
        rows.sort(Comparator.comparing(ConfigEntity::getConfigKey));
        return rows;
    }

    // ------------------------------------------------------------------
    // Writes
    // ------------------------------------------------------------------

    @Transactional
    public void putLayer(String layer, String domain, Map<String, String> entries,
                         String changedBy, UUID userId, UUID workspaceId) {
        validateLayerScope(layer, domain, entries, userId, workspaceId);
        rejectProviderSecrets(domain, entries);
        validateInstructionsScope(layer, domain, entries);
        List<String> errors = validateBySchema(domain, entries);
        if (!errors.isEmpty()) {
            throw new IllegalArgumentException(
                "Schema validation failed: " + String.join("; ", errors));
        }
        if ("llm-provider".equals(domain)) {
            List<String> providerErrors = validateProviderBinding(
                layer, entries, userId, workspaceId);
            if (!providerErrors.isEmpty()) {
                throw new IllegalArgumentException(
                    "Provider validation failed: " + String.join("; ", providerErrors));
            }
        }
        putLayerInternal(layer, domain, entries, changedBy, userId, workspaceId);
        publishLoggingChanged(domain, layer);
    }

    /** PLAN-0307 T2.15: notify listeners after a logging instance-layer write. */
    private void publishLoggingChanged(String domain, String layer) {
        if ("logging".equals(domain) && "instance".equals(layer)) {
            events.publishEvent(new LoggingConfigChangedEvent("config-write"));
        }
    }

    private void validateLayerScope(String layer, String domain, Map<String, String> entries,
                                    UUID userId, UUID workspaceId) {
        switch (layer) {
            case "instance" -> {
                // ADMIN-only; enforced by the controller.
            }
            case "user" -> {
                if (userId == null) {
                    throw new ConfigAccessException("User scope requires a user_id");
                }
                if (!USER_WRITABLE_DOMAINS.contains(domain)) {
                    throw new ConfigAccessException("Domain is not writable at the user layer: " + domain);
                }
            }
            case "workspace" -> {
                if (workspaceId == null) {
                    throw new ConfigAccessException("Workspace scope requires a workspace_id");
                }
                if (!WORKSPACE_WRITABLE_DOMAINS.contains(domain)) {
                    throw new ConfigAccessException("Domain is not writable at the workspace layer: " + domain);
                }
            }
            default -> throw new IllegalArgumentException("Unknown config layer: " + layer);
        }
    }

    private void validateInstructionsScope(String layer, String domain, Map<String, String> entries) {
        Set<String> instanceOnly = INSTANCE_ONLY_KEYS.getOrDefault(domain, Set.of());
        if (instanceOnly.isEmpty() || "instance".equals(layer)) {
            return;
        }
        for (String key : instanceOnly) {
            if (entries.containsKey(key)) {
                throw new ConfigAccessException(
                    "Key is instance-only and cannot be written at layer " + layer + ": " + key);
            }
        }
    }

    private void rejectProviderSecrets(String domain, Map<String, String> entries) {
        boolean containsSecret = entries.keySet().stream().anyMatch(ConfigService::isProviderSecretKey);
        if (containsSecret) {
            throw new ConfigOwnershipException(
                "Provider credentials are stored in provider_connections, not in config layers");
        }
    }

    private static boolean isProviderSecretKey(String key) {
        String normalized = key.toLowerCase(Locale.ROOT);
        if (normalized.contains("apikey")
                || normalized.contains("secret")
                || normalized.contains("password")) {
            return true;
        }
        // maxTokens is a generation parameter, not a credential.
        return normalized.contains("token") && !normalized.contains("maxtoken");
    }

    private List<String> validateProviderBinding(String layer, Map<String, String> entries,
                                                 UUID userId, UUID workspaceId) {
        List<String> errors = new ArrayList<>();
        String defaultProvider = entries.getOrDefault("defaultProvider", "").trim();
        if (!defaultProvider.isEmpty()) {
            Set<String> supported = Set.of("openai", "deepseek", "xiaomi", "anthropic", "dashscope");
            if (!supported.contains(defaultProvider)) {
                errors.add("defaultProvider is unsupported: " + defaultProvider);
            } else if (requiresReadyConnection(layer)
                    && !hasReadyProviderConnection(defaultProvider, userId, workspaceId)) {
                // PLAN-0307 T2.24 (review P1-5): provider readiness is grounded
                // in provider_connections, not config keys (decision #21/#37).
                errors.add("No ready provider connection for: " + defaultProvider);
            }
        }
        for (String key : List.of("baseUrl", "openaiApiBase", "deepseekApiBase", "xiaomiApiBase", "anthropicApiBase", "dashscopeApiBase")) {
            String value = entries.getOrDefault(key, "").trim();
            if (!value.isEmpty()) {
                try {
                    URI uri = URI.create(value);
                    if (!"http".equalsIgnoreCase(uri.getScheme())
                            && !"https".equalsIgnoreCase(uri.getScheme())) {
                        errors.add(key + " must use http or https");
                    }
                    if (value.length() > 2048) {
                        errors.add(key + " exceeds 2048 characters");
                    }
                } catch (IllegalArgumentException e) {
                    errors.add(key + " is not a valid URL");
                }
            }
        }
        return errors;
    }

    private static boolean requiresReadyConnection(String layer) {
        return "user".equals(layer) || "workspace".equals(layer);
    }

    private boolean hasReadyProviderConnection(String provider, UUID userId, UUID workspaceId) {
        if (workspaceId != null && isReadyProviderConnection(
                ProviderConnection.OWNER_WORKSPACE, workspaceId.toString(), provider)) {
            return true;
        }
        return userId != null && isReadyProviderConnection(
                ProviderConnection.OWNER_USER, userId.toString(), provider);
    }

    private boolean isReadyProviderConnection(String ownerType, String ownerId, String provider) {
        return providerConnections
                .findByOwnerTypeAndOwnerIdAndProviderId(ownerType, ownerId, provider)
                .filter(connection -> connection.isEnabled()
                        && ProviderConnection.STATUS_READY.equals(connection.getStatus()))
                .isPresent();
    }

    public static class ConfigOwnershipException extends IllegalArgumentException {
        public ConfigOwnershipException(String message) {
            super(message);
        }
    }

    /** Layer/domain/scope violation (mapped to 403 by the controller). */
    public static class ConfigAccessException extends IllegalArgumentException {
        public ConfigAccessException(String message) {
            super(message);
        }
    }

    private void putLayerInternal(String layer, String domain, Map<String, String> entries,
                                  String changedBy, UUID userId, UUID workspaceId) {
        for (Map.Entry<String, String> entry : entries.entrySet()) {
            String key = entry.getKey();
            String value = entry.getValue();

            Optional<ConfigEntity> existing = findExisting(layer, domain, key, userId, workspaceId);
            if (existing.isPresent()) {
                ConfigEntity entity = existing.get();
                String oldValue = entity.getConfigValue();
                entity.setConfigValue(value);
                entity.setUpdatedBy(changedBy);
                repo.save(entity);
                createAudit(entity, oldValue, value, changedBy);
            } else {
                ConfigEntity entity = new ConfigEntity();
                entity.setLayer(layer);
                entity.setUserId("user".equals(layer) ? userId : null);
                entity.setWorkspaceId("workspace".equals(layer) ? workspaceId : null);
                entity.setDomain(domain);
                entity.setConfigKey(key);
                entity.setConfigValue(value);
                entity.setUpdatedBy(changedBy);
                repo.save(entity);
                createAudit(entity, null, value, changedBy);
            }
        }
    }

    private Optional<ConfigEntity> findExisting(String layer, String domain, String key,
                                                UUID userId, UUID workspaceId) {
        return switch (layer) {
            case "instance" -> repo.findByLayerAndDomainAndConfigKey("instance", domain, key);
            case "user" -> repo.findByUserIdAndDomainAndConfigKey(userId, domain, key);
            case "workspace" -> repo.findByWorkspaceIdAndDomainAndConfigKey(workspaceId, domain, key);
            default -> Optional.empty();
        };
    }

    @Transactional
    public void deleteKey(String layer, String domain, String configKey, String changedBy,
                          UUID userId, UUID workspaceId) {
        Optional<ConfigEntity> existing = findExisting(layer, domain, configKey, userId, workspaceId);
        if (existing.isPresent()) {
            ConfigEntity entity = existing.get();
            createAudit(entity, entity.getConfigValue(), null, changedBy);
            repo.delete(entity);
            publishLoggingChanged(domain, layer);
        }
    }

    public List<ConfigAuditEntity> getAuditLogByConfigId(String configId) {
        return auditRepo.findByConfigIdOrderByChangedAtDesc(configId);
    }

    // ------------------------------------------------------------------
    // Import / export (management plane, instance layer)
    // ------------------------------------------------------------------

    @Transactional
    public void importJsoncFromClasspath(String classpath, String layer, UUID userId, UUID workspaceId) {
        try {
            ClassPathResource resource = new ClassPathResource(classpath);
            if (!resource.exists()) {
                log.warn("JSONC file not found: {}", classpath);
                return;
            }
            try (InputStream is = resource.getInputStream()) {
                String content = new String(is.readAllBytes(), StandardCharsets.UTF_8);
                JsonNode root = objectMapper.readTree(stripJsoncComments(content));
                importJsoncNode(root, layer, userId, workspaceId);
            }
        } catch (IOException e) {
            log.error("Failed to import JSONC from {}: {}", classpath, e.getMessage(), e);
        }
    }

    @Transactional
    public void importJsonc(String jsoncContent, String layer, UUID userId, UUID workspaceId) {
        String stripped = stripJsoncComments(jsoncContent);
        try {
            JsonNode root = objectMapper.readTree(stripped);
            importJsoncNode(root, layer, userId, workspaceId);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Invalid JSONC content: " + e.getMessage(), e);
        }
    }

    private void importJsoncNode(JsonNode root, String layer, UUID userId, UUID workspaceId) {
        Iterator<Map.Entry<String, JsonNode>> fields = root.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> entry = fields.next();
            String domain = entry.getKey();
            JsonNode domainNode = entry.getValue();
            if (domainNode.isObject()) {
                Map<String, String> entries = new LinkedHashMap<>();
                Iterator<Map.Entry<String, JsonNode>> domainFields = domainNode.fields();
                while (domainFields.hasNext()) {
                    Map.Entry<String, JsonNode> df = domainFields.next();
                    String value = df.getValue().isNull() ? "" : df.getValue().asText();
                    entries.put(df.getKey(), value);
                }
                putLayer(layer, domain, entries, "import", userId, workspaceId);
            }
        }
    }

    @Transactional
    public String exportJsonc(String layer, UUID userId, UUID workspaceId) {
        List<ConfigEntity> configs = new ArrayList<>();
        if ("instance".equals(layer)) {
            for (String domain : DOMAINS) {
                configs.addAll(rowsForLayer(layer, domain, null, null));
            }
        } else {
            for (String domain : DOMAINS) {
                configs.addAll(rowsForLayer(layer, domain, userId, workspaceId));
            }
        }
        Map<String, Map<String, String>> byDomain = new LinkedHashMap<>();
        for (ConfigEntity c : configs) {
            byDomain.computeIfAbsent(c.getDomain(), k -> new LinkedHashMap<>())
                .put(c.getConfigKey(), c.getConfigValue());
        }
        try {
            return objectMapper.writerWithDefaultPrettyPrinter()
                .writeValueAsString(byDomain);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Failed to serialize export", e);
        }
    }

    private void createAudit(ConfigEntity entity, String oldValue,
                             String newValue, String changedBy) {
        ConfigAuditEntity audit = new ConfigAuditEntity();
        audit.setConfigId(entity.getId().toString());
        audit.setLayer(entity.getLayer());
        audit.setDomain(entity.getDomain());
        audit.setConfigKey(entity.getConfigKey());
        audit.setOldValue(auditValue(entity, oldValue));
        audit.setNewValue(auditValue(entity, newValue));
        audit.setChangedBy(changedBy);
        auditRepo.save(audit);
    }

    private String auditValue(ConfigEntity entity, String value) {
        if (!"llm-provider".equals(entity.getDomain())
                || !isProviderSecretKey(entity.getConfigKey())) {
            return value;
        }
        if (value == null || value.isBlank()) {
            return "missing";
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return "present:" + HexFormat.of().formatHex(digest);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private List<String> validateBySchema(String domain, Map<String, String> entries) {
        if (!DOMAINS.contains(domain)) {
            return List.of("Unsupported domain: " + domain);
        }
        if (!schemaValidator.hasSchema(domain)) {
            return List.of();
        }
        Map<String, Object> raw = new LinkedHashMap<>(entries);
        JsonNode body = objectMapper.convertValue(raw, JsonNode.class);
        return schemaValidator.validate(domain, body);
    }
}
