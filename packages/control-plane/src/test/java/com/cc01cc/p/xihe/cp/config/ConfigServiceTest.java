package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import com.cc01cc.p.xihe.cp.entity.ConfigAuditEntity;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ConfigServiceTest {

    @Autowired
    private ConfigService configService;

    @Autowired
    private ConfigJpaRepository repo;

    @Autowired
    private ConfigAuditRepository auditRepo;

    @Test
    void init_seedsInfrastructureDomain() {
        // init() is @PostConstruct, but other tests may have cleaned the DB
        // through cleanDb(). Re-invoke to guarantee seed state.
        repo.deleteAll();
        auditRepo.deleteAll();
        configService.init();
        assertTrue(repo.countByEnvironmentAndLayer("default", "system") > 0,
            "init() should seed infrastructure domain");
        assertTrue(repo.findByEnvironmentAndLayerAndDomain("default", "system", "infrastructure")
            .stream().anyMatch(e -> "dbUrl".equals(e.getConfigKey())));
    }

    @Test
    void resolveDomain_returnsUserPrecedence() {
        cleanDb();
        configService.putLayer("default", "system", "logging",
            Map.of("logLevel", "INFO"), "system");
        configService.putLayer("default", "admin", "logging",
            Map.of("logLevel", "DEBUG"), "admin");

        Map<String, String> result = configService.resolveDomain("default", "logging");
        assertEquals("DEBUG", result.get("logLevel"), "admin should override system");
    }

    @Test
    void resolveDomain_userOverridesAdmin() {
        cleanDb();
        configService.putLayer("default", "system", "user-preference",
            Map.of("theme", "light"), "system");
        configService.putLayer("default", "admin", "user-preference",
            Map.of("theme", "dark"), "admin");
        configService.putLayer("default", "user", "user-preference",
            Map.of("theme", "system"), "user");

        Map<String, String> result = configService.resolveDomain("default", "user-preference");
        assertEquals("system", result.get("theme"), "user should override admin");
    }

    @Test
    void resolveDomain_mergesAcrossLayers() {
        cleanDb();
        configService.putLayer("default", "system", "llm-provider",
            Map.of("baseUrl", "https://api.openai.com/v1", "openaiApiKey", ""), "system");
        configService.putLayer("default", "admin", "llm-provider",
            Map.of("openaiApiKey", "sk-test"), "admin");

        Map<String, String> result = configService.resolveDomain("default", "llm-provider");
        assertEquals("sk-test", result.get("openaiApiKey"), "admin value should appear");
        assertEquals("https://api.openai.com/v1", result.get("baseUrl"), "system fallback should appear");
    }

    @Test
    void resolveDomain_emptyLayer_returnsFallback() {
        cleanDb();
        configService.putLayer("default", "system", "logging",
            Map.of("logLevel", "WARN"), "system");

        Map<String, String> result = configService.resolveDomain("default", "logging");
        assertEquals("WARN", result.get("logLevel"));
    }

    @Test
    void resolveDomain_unknownDomain_returnsEmpty() {
        cleanDb();
        Map<String, String> result = configService.resolveDomain("default", "nonexistent-domain");
        assertTrue(result.isEmpty());
    }

    @Test
    void resolve_returnsCorrectSingleValue() {
        cleanDb();
        configService.putLayer("default", "system", "logging",
            Map.of("logLevel", "ERROR"), "system");

        String val = configService.resolve("default", "logging", "logLevel");
        assertEquals("ERROR", val);
    }

    @Test
    void resolve_unknownKey_returnsNull() {
        cleanDb();
        assertNull(configService.resolve("default", "logging", "nonexistentKey"));
    }

    @Test
    void putLayer_withValidation_rejectsInvalidData() {
        cleanDb();
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("default", "admin", "logging",
                Map.of("logLevel", "INVALID_LEVEL"), "admin"),
            "logging schema should reject invalid enum value");
    }

    @Test
    void putLayer_withValidation_acceptsValidData() {
        cleanDb();
        configService.putLayer("default", "admin", "logging",
            Map.of("logLevel", "DEBUG"), "admin");
        Map<String, String> result = configService.resolveDomain("default", "logging");
        assertEquals("DEBUG", result.get("logLevel"));
    }

    @Test
    void putLayer_extraProperty_rejectedByAdditionalProperties() {
        cleanDb();
        Map<String, String> entries = new java.util.LinkedHashMap<>();
        entries.put("logLevel", "INFO");
        entries.put("unknownField", "value");
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("default", "admin", "logging", entries, "admin"));
    }

    @Test
    void deleteKey_removesEntryAndCreatesAudit() {
        cleanDb();
        configService.putLayer("default", "admin", "logging",
            Map.of("logLevel", "DEBUG"), "admin");
        configService.deleteKey("default", "admin", "logging", "logLevel", "tester");

        assertNull(configService.resolve("default", "logging", "logLevel"),
            "deleted key should resolve to null (no system fallback)");

        List<ConfigAuditEntity> audits = auditRepo.findAll();
        assertFalse(audits.isEmpty(), "delete should create an audit entry");
    }

    @Test
    void putLayer_createsAuditEntry() {
        cleanDb();
        configService.putLayer("default", "admin", "logging",
            Map.of("logLevel", "INFO"), "admin");

        List<ConfigAuditEntity> audits = auditRepo.findAll();
        assertFalse(audits.isEmpty());
        assertEquals("INFO", audits.get(audits.size() - 1).getNewValue());
    }

    @Test
    void putLayer_tracksChangedBy() {
        cleanDb();
        configService.putLayer("default", "admin", "logging",
            Map.of("logLevel", "WARN"), "operator-1");

        List<ConfigAuditEntity> audits = auditRepo.findAll();
        String lastChangedBy = audits.get(audits.size() - 1).getChangedBy();
        assertEquals("operator-1", lastChangedBy);
    }

    @Test
    void importJsonc_parsesAndWrites() {
        cleanDb();
        String jsonc = "{\n  // comment\n  \"logging\": { \"logLevel\": \"TRACE\" }\n}";
        configService.importJsonc(jsonc, "admin");

        Map<String, String> result = configService.resolveDomain("default", "logging");
        assertEquals("TRACE", result.get("logLevel"));
    }

    @Test
    void importJsonc_invalidContent_throws() {
        assertThrows(IllegalArgumentException.class, () ->
            configService.importJsonc("not json", "admin"));
    }

    @Test
    void exportJsonc_returnsAllKeys() {
        cleanDb();
        configService.putLayer("default", "admin", "logging",
            Map.of("logLevel", "INFO", "auditConsole", "true"), "admin");

        String exported = configService.exportJsonc("admin");
        assertTrue(exported.contains("logLevel"));
        assertTrue(exported.contains("INFO"));
    }

    @Test
    void environmentIsolation_keepsLayersSeparate() {
        cleanDb();
        configService.putLayer("default", "system", "logging",
            Map.of("logLevel", "INFO"), "system");
        configService.putLayer("default", "admin", "logging",
            Map.of("logLevel", "DEBUG"), "admin");

        Map<String, String> result = configService.resolveDomain("default", "logging");
        assertEquals("DEBUG", result.get("logLevel"));
    }

    @Test
    void isSystemLayerEmpty_returnsCorrectState() {
        cleanDb();
        assertTrue(configService.isSystemLayerEmpty());
        configService.putLayer("default", "system", "infrastructure",
            Map.of("dbUrl", "test"), "system");
        assertFalse(configService.isSystemLayerEmpty());
    }

    private void cleanDb() {
        auditRepo.deleteAll();
        repo.deleteAll();
    }
}
