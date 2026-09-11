package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
import com.cc01cc.p.xihe.cp.provider.ProviderConnectionService;

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
    private ProviderConnectionService providerConnectionService;

    @Autowired
    private org.springframework.context.ApplicationEventPublisher events;

    @Autowired
    private ConfigDomainSchema schemaValidator;

    @Autowired
    private EnvOverlayRegistry envOverlay;

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
        // PLAN-0307 T2.14 (P1-1): the single-key channel merges env first, so
        // env-locked keys cannot silently fall back to a DB value.
        String envValue = envOverlay.activeOverrides(domain).get(key);
        if (envValue != null) return envValue;
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
        return envOverlay.activeOverrides(domain).keySet();
    }

    /** PLAN-0307 T2.14: env-effective values for the UI lock metadata (T2.17). */
    public Map<String, String> envOverridden(String domain) {
        return envOverlay.activeOverrides(domain);
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
        // PLAN-0307 T2.14: overlay source is the registry (decision #22); the
        // merge chain stays env > workspace > user > instance > code default.
        Map<String, String> overrides = envOverlay.activeOverrides(domain);
        overrides.forEach(merged::put);
        return !overrides.isEmpty();
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
                ImportReport report = importJsoncNode(root, layer, userId, workspaceId);
                if (!report.warnings().isEmpty()) {
                    log.warn("Config import warnings from {}: {}", classpath, report.warnings());
                }
            }
        } catch (IOException e) {
            log.error("Failed to import JSONC from {}: {}", classpath, e.getMessage(), e);
        }
    }

    /** PLAN-0307 T2.21: import outcome (credentials are never restored). */
    public record ImportReport(int imported, int skipped, List<String> warnings) {}

    @Transactional
    public ImportReport importJsonc(String jsoncContent, String layer, UUID userId, UUID workspaceId) {
        String stripped = stripJsoncComments(jsoncContent);
        try {
            JsonNode root = objectMapper.readTree(stripped);
            return importJsoncNode(root, layer, userId, workspaceId);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Invalid JSONC content: " + e.getMessage(), e);
        }
    }

    private ImportReport importJsoncNode(JsonNode root, String layer, UUID userId, UUID workspaceId) {
        int imported = 0;
        int skipped = 0;
        List<String> warnings = new ArrayList<>();
        Iterator<Map.Entry<String, JsonNode>> fields = root.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> entry = fields.next();
            String domain = entry.getKey();
            JsonNode domainNode = entry.getValue();
            if ("provider-connections".equals(domain)) {
                // PLAN-0307 T2.21 (decision #37): never restore credentials on
                // import — owner/workspace ids are not portable across instances.
                if (domainNode.isArray() && !domainNode.isEmpty()) {
                    skipped += domainNode.size();
                    warnings.add("provider-connections: " + domainNode.size()
                        + " credential(s) skipped - imports never restore credentials; "
                        + "rebuild them via the provider connections API/UI");
                }
                continue;
            }
            if (domainNode.isObject()) {
                Map<String, String> entries = new LinkedHashMap<>();
                Iterator<Map.Entry<String, JsonNode>> domainFields = domainNode.fields();
                while (domainFields.hasNext()) {
                    Map.Entry<String, JsonNode> df = domainFields.next();
                    // PLAN-0307 T2.17: nested structured values round-trip as
                    // JSON text (decision #24 storage contract) instead of being
                    // flattened to an empty scalar string.
                    String value = df.getValue().isNull()
                        ? ""
                        : (df.getValue().isContainerNode()
                            ? df.getValue().toString()
                            : df.getValue().asText());
                    entries.put(df.getKey(), value);
                }
                putLayer(layer, domain, entries, "import", userId, workspaceId);
                imported += entries.size();
            }
        }
        return new ImportReport(imported, skipped, warnings);
    }

    @Transactional
    public String exportJsonc(String layer, UUID userId, UUID workspaceId) {
        return exportJsonc(layer, userId, workspaceId, true);
    }

    /**
     * PLAN-0307 T2.21/T2.25: export = config KV (never key columns) + provider
     * connection metadata; `includeSecrets=false` additionally drops plaintext
     * credentials (ciphertext and key version are never exported either way).
     */
    @Transactional
    public String exportJsonc(String layer, UUID userId, UUID workspaceId, boolean includeSecrets) {
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
            ObjectNode root = objectMapper.createObjectNode();
            for (Map.Entry<String, Map<String, String>> domainEntry : byDomain.entrySet()) {
                ObjectNode domainNode = root.putObject(domainEntry.getKey());
                domainEntry.getValue().forEach(domainNode::put);
            }
            List<ProviderConnection> connections = providerConnections.findAll();
            if (!connections.isEmpty()) {
                ArrayNode connectionNodes = objectMapper.createArrayNode();
                for (ProviderConnection connection : connections) {
                    ObjectNode node = objectMapper.createObjectNode();
                    node.put("providerId", connection.getProviderId());
                    node.put("label", connection.getLabel());
                    node.put("ownerType", connection.getOwnerType());
                    node.put("ownerId", connection.getOwnerId());
                    if (connection.getBaseUrl() != null) {
                        node.put("baseUrl", connection.getBaseUrl());
                    }
                    node.put("status", connection.getStatus());
                    node.put("enabled", connection.isEnabled());
                    node.put("modelDiscovery", connection.getModelDiscovery());
                    if (connection.getManualModels() != null) {
                        node.set("manualModels", objectMapper.readTree(connection.getManualModels()));
                    }
                    if (includeSecrets) {
                        String apiKey = providerConnectionService.exportPlaintextCredential(connection);
                        if (apiKey != null) {
                            node.put("apiKey", apiKey);
                        }
                    }
                    connectionNodes.add(node);
                }
                root.set("provider-connections", connectionNodes);
            }
            return objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(root);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Failed to serialize export", e);
        }
    }

    /** PLAN-0307 T2.25: connection count for the export audit record. */
    public long countProviderConnections() {
        return providerConnections.count();
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
        // PLAN-0307 T2.17: structured values are stored as JSON text (decision
        // #24 storage contract). Container text must be parsed before schema
        // validation so nested domains (context-policy) validate as shapes
        // rather than strings; scalar text stays a string.
        Map<String, Object> raw = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : entries.entrySet()) {
            String value = entry.getValue();
            String trimmed = value == null ? "" : value.trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                try {
                    raw.put(entry.getKey(), objectMapper.readTree(trimmed));
                } catch (JsonProcessingException e) {
                    return List.of(entry.getKey() + " is not valid JSON");
                }
            } else {
                raw.put(entry.getKey(), value);
            }
        }
        JsonNode body = objectMapper.convertValue(raw, JsonNode.class);
        return schemaValidator.validate(domain, body);
    }
}
