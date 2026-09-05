package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.cc01cc.p.xihe.cp.entity.ConfigAuditEntity;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

@Service
public class ConfigService {

    private static final Logger log = LoggerFactory.getLogger(ConfigService.class);

    private static final String DEFAULT_ENV = "default";

    private static final List<String> RESOLVE_ORDER = List.of("user", "admin", "system");

    @Autowired
    private ConfigJpaRepository repo;

    @Autowired
    private ConfigAuditRepository auditRepo;

    @Autowired
    private ConfigDomainSchema schemaValidator;

    @Autowired
    private ObjectMapper objectMapper;

    @Value("${spring.profiles.active:}")
    private String activeProfiles;

    @Value("${cp.system.db-url:}")
    private String dbUrl;

    @Value("${cp.system.jwt-secret:}")
    private String jwtSecret;

    @PostConstruct
    public void init() {
        if (repo.countByEnvironmentAndLayer(DEFAULT_ENV, "system") == 0) {
            Map<String, String> infra = new LinkedHashMap<>();
            infra.put("dbUrl", dbUrl);
            infra.put("jwtSecret", jwtSecret);
            putLayerInternal(DEFAULT_ENV, "system", "infrastructure", infra, "system");
            log.info("Seeded infrastructure domain from OS env");
        }
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        // dev 启动时的配置导入由 scripts/dev-all.sh 通过 POST /api/v1/config/import 完成
        // 不在此处自动导入 classpath JSONC
    }

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

    @Transactional
    public void importJsoncFromClasspath(String classpath, String layer) {
        try {
            ClassPathResource resource = new ClassPathResource(classpath);
            if (!resource.exists()) {
                log.warn("JSONC file not found: {}", classpath);
                return;
            }
            try (InputStream is = resource.getInputStream()) {
                String content = new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                JsonNode root = objectMapper.readTree(stripJsoncComments(content));
                importJsoncNode(root, layer);
            }
        } catch (IOException e) {
            log.error("Failed to import JSONC from {}: {}", classpath, e.getMessage(), e);
        }
    }

    @Transactional
    public void importJsonc(String jsoncContent, String layer) {
        String stripped = stripJsoncComments(jsoncContent);
        try {
            JsonNode root = objectMapper.readTree(stripped);
            importJsoncNode(root, layer);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Invalid JSONC content: " + e.getMessage(), e);
        }
    }

    private void importJsoncNode(JsonNode root, String layer) {
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
                putLayer(DEFAULT_ENV, layer, domain, entries, "import");
            }
        }
    }

    @Transactional
    public String exportJsonc(String layer) {
        List<ConfigEntity> configs = repo.findByEnvironmentAndLayer(DEFAULT_ENV, layer);
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

    public Map<String, String> resolveDomain(String environment, String domain) {
        Map<String, String> merged = new LinkedHashMap<>();
        for (String layer : RESOLVE_ORDER) {
            List<ConfigEntity> entries = repo.findByEnvironmentAndLayerAndDomain(
                environment, layer, domain);
            for (ConfigEntity e : entries) {
                merged.putIfAbsent(e.getConfigKey(), e.getConfigValue());
            }
        }
        return merged;
    }

    public String resolve(String environment, String domain, String key) {
        for (String layer : RESOLVE_ORDER) {
            Optional<ConfigEntity> opt = repo.findByEnvironmentAndLayerAndDomainAndConfigKey(
                environment, layer, domain, key);
            if (opt.isPresent()) {
                return opt.get().getConfigValue();
            }
        }
        return null;
    }

    @Transactional
    public void putLayer(String environment, String layer, String domain,
                         Map<String, String> entries, String changedBy) {
        rejectUserProviderSecrets(layer, domain, entries);
        List<String> errors = validateBySchema(domain, entries);
        if (!errors.isEmpty()) {
            throw new IllegalArgumentException(
                "Schema validation failed: " + String.join("; ", errors));
        }
        if ("llm-provider".equals(domain)) {
            List<String> providerErrors = validateProviderBinding(environment, layer, entries);
            if (!providerErrors.isEmpty()) {
                throw new IllegalArgumentException(
                    "Provider validation failed: " + String.join("; ", providerErrors));
            }
        }
        putLayerInternal(environment, layer, domain, entries, changedBy);
    }

    private void rejectUserProviderSecrets(String layer, String domain, Map<String, String> entries) {
        if (!"user".equals(layer) || !"llm-provider".equals(domain)) {
            return;
        }
        boolean containsSecret = entries.keySet().stream().anyMatch(ConfigService::isProviderSecretKey);
        if (containsSecret) {
            throw new ConfigOwnershipException("Provider credentials belong to the admin layer");
        }
    }

    private static boolean isProviderSecretKey(String key) {
        String normalized = key.toLowerCase(Locale.ROOT);
        return normalized.contains("apikey")
            || normalized.contains("secret")
            || normalized.contains("password")
            || normalized.contains("token");
    }

    private List<String> validateProviderBinding(
            String environment, String layer, Map<String, String> entries) {
        Map<String, String> candidate = resolveDomain(environment, "llm-provider");
        candidate.putAll(entries);
        List<String> errors = new ArrayList<>();
        String defaultProvider = candidate.getOrDefault("defaultProvider", "").trim();
        if (!defaultProvider.isEmpty()) {
            Set<String> supported = Set.of("openai", "deepseek", "xiaomi", "anthropic", "dashscope");
            if (!supported.contains(defaultProvider)) {
                errors.add("defaultProvider is unsupported: " + defaultProvider);
            } else if (candidate.getOrDefault(defaultProvider + "ApiKey", "").isBlank()) {
                errors.add("defaultProvider requires a non-empty " + defaultProvider + "ApiKey");
            }
        }
        for (String key : List.of("baseUrl", "openaiApiBase", "deepseekApiBase", "xiaomiApiBase")) {
            String value = candidate.getOrDefault(key, "").trim();
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

    public static class ConfigOwnershipException extends IllegalArgumentException {
        public ConfigOwnershipException(String message) {
            super(message);
        }
    }

    private void putLayerInternal(String environment, String layer, String domain,
                                  Map<String, String> entries, String changedBy) {
        for (Map.Entry<String, String> entry : entries.entrySet()) {
            String key = entry.getKey();
            String value = entry.getValue();

            Optional<ConfigEntity> existing =
                repo.findByEnvironmentAndLayerAndDomainAndConfigKey(environment, layer, domain, key);

            if (existing.isPresent()) {
                ConfigEntity entity = existing.get();
                String oldValue = entity.getConfigValue();
                entity.setConfigValue(value);
                entity.setIsSet(true);
                entity.setUpdatedBy(changedBy);
                repo.save(entity);
                createAudit(entity, oldValue, value, changedBy);
            } else {
                ConfigEntity entity = new ConfigEntity();
                entity.setEnvironment(environment);
                entity.setLayer(layer);
                entity.setDomain(domain);
                entity.setConfigKey(key);
                entity.setConfigValue(value);
                entity.setIsSet(value != null && !value.isEmpty());
                entity.setUpdatedBy(changedBy);
                repo.save(entity);
                createAudit(entity, null, value, changedBy);
            }
        }
    }

    @Transactional
    public void deleteKey(String environment, String layer, String domain,
                          String configKey, String changedBy) {
        Optional<ConfigEntity> existing =
            repo.findByEnvironmentAndLayerAndDomainAndConfigKey(environment, layer, domain, configKey);
        if (existing.isPresent()) {
            ConfigEntity entity = existing.get();
            createAudit(entity, entity.getConfigValue(), null, changedBy);
            repo.delete(entity);
        }
    }

    public List<ConfigAuditEntity> getAuditLogByConfigId(Long configId) {
        return auditRepo.findByConfigIdOrderByChangedAtDesc(configId);
    }

    private void createAudit(ConfigEntity entity, String oldValue,
                             String newValue, String changedBy) {
        ConfigAuditEntity audit = new ConfigAuditEntity();
        audit.setConfigId(entity.getId());
        audit.setEnvironment(entity.getEnvironment());
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
        if (!schemaValidator.hasSchema(domain)) {
            return List.of();
        }
        Map<String, Object> raw = new LinkedHashMap<>(entries);
        JsonNode body = objectMapper.convertValue(raw, JsonNode.class);
        return schemaValidator.validate(domain, body);
    }

    public boolean isSystemLayerEmpty() {
        return repo.countByEnvironmentAndLayer(DEFAULT_ENV, "system") == 0;
    }
}
