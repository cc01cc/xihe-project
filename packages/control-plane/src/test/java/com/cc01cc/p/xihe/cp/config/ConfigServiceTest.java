package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import com.cc01cc.p.xihe.cp.entity.ConfigAuditEntity;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;

import java.util.List;
import java.util.Map;
import java.util.UUID;

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

    @Autowired
    private ProviderConnectionRepository providerConnections;

    @Autowired
    @org.springframework.beans.factory.annotation.Qualifier("providerCredentialEncryption")
    private com.cc01cc.p.xihe.cp.oauth.EnvelopeEncryptionService credentialEncryption;

    private final UUID userA = UUID.randomUUID();
    private final UUID userB = UUID.randomUUID();
    private final UUID wsA = UUID.randomUUID();
    private final UUID wsB = UUID.randomUUID();

    @BeforeEach
    void cleanDb() {
        auditRepo.deleteAll();
        repo.deleteAll();
        providerConnections.deleteAll();
    }

    @Test
    void putLayer_instance_isScopedWithoutIdentifiers() {
        configService.putLayer("instance", "logging", Map.of("logLevel", "WARN"), "admin", null, null);

        Map<String, String> entries = configService.layerEntries("instance", "logging", null, null);
        assertEquals("WARN", entries.get("logLevel"));
    }

    @Test
    void resolve_workspaceOverridesUserOverridesInstance() {
        configService.putLayer("instance", "llm-provider",
            Map.of("defaultModel", "instance-model"), "admin", null, null);
        configService.putLayer("user", "llm-provider",
            Map.of("defaultModel", "user-model"), "user", userA, null);
        configService.putLayer("workspace", "llm-provider",
            Map.of("defaultModel", "workspace-model"), "user", null, wsA);

        assertEquals("workspace-model",
            configService.resolveDomain("llm-provider", userA, wsA).get("defaultModel"));
        assertEquals("user-model",
            configService.resolveDomain("llm-provider", userA, null).get("defaultModel"));
        assertEquals("instance-model",
            configService.resolveDomain("llm-provider", null, null).get("defaultModel"));
    }

    @Test
    void resolve_userLayerIsIsolatedByUserId() {
        configService.putLayer("user", "llm-provider",
            Map.of("defaultModel", "model-a"), "user", userA, null);
        configService.putLayer("user", "llm-provider",
            Map.of("defaultModel", "model-b"), "user", userB, null);

        assertEquals("model-a", configService.resolveDomain("llm-provider", userA, null).get("defaultModel"));
        assertEquals("model-b", configService.resolveDomain("llm-provider", userB, null).get("defaultModel"));
    }

    @Test
    void resolve_workspaceLayerIsIsolatedByWorkspaceId() {
        configService.putLayer("workspace", "rag",
            Map.of("chunkSize", "256"), "user", null, wsA);
        configService.putLayer("workspace", "rag",
            Map.of("chunkSize", "2048"), "user", null, wsB);

        assertEquals("256", configService.resolveDomain("rag", null, wsA).get("chunkSize"));
        assertEquals("2048", configService.resolveDomain("rag", null, wsB).get("chunkSize"));
    }

    @Test
    void effective_includesCodeDefaultsWhenUnset() {
        ConfigService.EffectiveConfig effective = configService.effective("rag", null, null);

        assertEquals("default", effective.source());
        assertEquals("1000", effective.entries().get("chunkSize"));
        assertEquals("5", effective.entries().get("topK"));
        assertNotNull(effective.revision());
    }

    @Test
    void effective_revisionChangesWhenRowsChange() {
        ConfigService.EffectiveConfig before = configService.effective("logging", null, null);
        configService.putLayer("instance", "logging", Map.of("logLevel", "DEBUG"), "admin", null, null);
        ConfigService.EffectiveConfig after = configService.effective("logging", null, null);

        assertNotEquals(before.revision(), after.revision());
        assertEquals("instance", after.source());
    }

    @Test
    void putLayer_userLoggingDomain_isRejected() {
        assertThrows(ConfigService.ConfigAccessException.class, () ->
            configService.putLayer("user", "logging", Map.of("logLevel", "DEBUG"), "user", userA, null));
    }

    @Test
    void putLayer_userPreferenceAtWorkspaceLayer_isRejected() {
        assertThrows(ConfigService.ConfigAccessException.class, () ->
            configService.putLayer("workspace", "user-preference", Map.of("theme", "dark"), "user", null, wsA));
    }

    @Test
    void putLayer_instructionsAtUserLayer_isRejected() {
        configService.putLayer("instance", "agent-runtime",
            Map.of("instructions", "baseline prompt"), "admin", null, null);
        assertThrows(ConfigService.ConfigAccessException.class, () ->
            configService.putLayer("user", "agent-runtime",
                Map.of("instructions", "override"), "user", userA, null));
        configService.putLayer("user", "agent-runtime",
            Map.of("useRegistry", "true"), "user", userA, null);
    }

    @Test
    void putLayer_providerSecrets_areRejectedAtEveryLayer() {
        assertThrows(ConfigService.ConfigOwnershipException.class, () ->
            configService.putLayer("instance", "llm-provider",
                Map.of("openaiApiKey", "sk-test"), "admin", null, null));
        assertThrows(ConfigService.ConfigOwnershipException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("deepseekApiKey", "sk-test"), "user", userA, null));
    }

    @Test
    void putLayer_unknownDomain_isRejected() {
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "nonexistent-domain",
                Map.of("key", "value"), "admin", null, null));
    }

    @Test
    void putLayer_withValidation_rejectsInvalidData() {
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "logging",
                Map.of("logLevel", "INVALID_LEVEL"), "admin", null, null));
    }

    @Test
    void putLayer_extraProperty_rejectedByAdditionalProperties() {
        Map<String, String> entries = new java.util.LinkedHashMap<>();
        entries.put("logLevel", "INFO");
        entries.put("unknownField", "value");
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "logging", entries, "admin", null, null));
    }

    @Test
    void deleteKey_removesEntryAndCreatesAudit() {
        configService.putLayer("instance", "logging", Map.of("logLevel", "DEBUG"), "admin", null, null);
        configService.deleteKey("instance", "logging", "logLevel", "tester", null, null);

        assertNull(configService.layerEntries("instance", "logging", null, null).get("logLevel"));
        List<ConfigAuditEntity> audits = auditRepo.findAll();
        assertFalse(audits.isEmpty(), "delete should create an audit entry");
    }

    @Test
    void putLayer_createsAuditEntryWithNewLayerValue() {
        configService.putLayer("user", "llm-provider",
            Map.of("defaultModel", "m"), "tester", userA, null);

        List<ConfigAuditEntity> audits = auditRepo.findAll();
        assertFalse(audits.isEmpty());
        ConfigAuditEntity audit = audits.get(audits.size() - 1);
        assertEquals("user", audit.getLayer());
        assertEquals("m", audit.getNewValue());
        assertEquals("tester", audit.getChangedBy());
    }

    @Test
    void importJsonc_writesInstanceLayer() {
        String jsonc = "{\n  // comment\n  \"logging\": { \"logLevel\": \"TRACE\" }\n}";
        configService.importJsonc(jsonc, "instance", null, null);

        assertEquals("TRACE", configService.layerEntries("instance", "logging", null, null).get("logLevel"));
    }

    @Test
    void importJsonc_acceptsNumericValues() {
        String jsonc = "{\"llm-provider\":{\"maxTokens\":8192,\"temperature\":0.5}}";
        configService.importJsonc(jsonc, "instance", null, null);

        Map<String, String> entries = configService.layerEntries("instance", "llm-provider", null, null);
        assertEquals("8192", entries.get("maxTokens"));
        assertEquals("0.5", entries.get("temperature"));
    }

    @Test
    void importJsonc_invalidContent_throws() {
        assertThrows(IllegalArgumentException.class, () ->
            configService.importJsonc("not json", "instance", null, null));
    }

    @Test
    void importJsonc_mergesByDomainWithoutDroppingOtherKeys() {
        // PLAN-0307 T2.12 (decision #20): import semantics = per-domain merge;
        // a second import updates only the keys it carries.
        configService.importJsonc(
            "{\"llm-provider\":{\"defaultModel\":\"model-one\",\"maxTokens\":3000}}", "instance", null, null);
        configService.importJsonc(
            "{\"llm-provider\":{\"defaultModel\":\"model-two\"}}", "instance", null, null);

        Map<String, String> entries = configService.layerEntries("instance", "llm-provider", null, null);
        assertEquals("model-two", entries.get("defaultModel"));
        assertEquals("3000", entries.get("maxTokens"));
    }

    @Test
    void putLayer_contextPolicyAcceptsStructuredJsonText() {
        // PLAN-0307 T2.17: nested domains travel as JSON text (decision #24);
        // the CP parses container text for schema validation before storing.
        String defaults = "{\"softThresholdPct\":0.8,\"hardThresholdPct\":0.95,\"keepRecentMessages\":30}";
        configService.putLayer("instance", "context-policy",
            Map.of("defaults", defaults), "admin", null, null);

        assertEquals(defaults,
            configService.layerEntries("instance", "context-policy", null, null).get("defaults"));
    }

    @Test
    void putLayer_contextPolicyRejectsMalformedOrWrongShapeJsonText() {
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "context-policy",
                Map.of("defaults", "{not json"), "admin", null, null));
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "context-policy",
                Map.of("defaults", "{\"softThresholdPct\":\"high\"}"), "admin", null, null));
    }

    @Test
    void importJsonc_preservesNestedStructuredValues() {
        // PLAN-0307 T2.17: nested import values must not flatten to empty
        // strings; they round-trip to config_value JSON text.
        configService.importJsonc(
            "{\"context-policy\":{\"defaults\":{\"softThresholdPct\":0.8}}}", "instance", null, null);

        String stored = configService.layerEntries("instance", "context-policy", null, null).get("defaults");
        assertNotNull(stored);
        assertTrue(stored.contains("softThresholdPct"),
            "nested value should round-trip as JSON text: " + stored);
    }

    @Test
    void exportJsonc_returnsInstanceKeys() {
        configService.putLayer("instance", "logging", Map.of("logLevel", "INFO"), "admin", null, null);

        String exported = configService.exportJsonc("instance", null, null);
        assertTrue(exported.contains("logLevel"));
        assertTrue(exported.contains("INFO"));
    }

    // ------------------------------------------------------------------
    // PLAN-0307 T2.7: run-payload overrides (decision #3)
    // ------------------------------------------------------------------

    @Test
    void overrides_returnsExplicitLayerRowsPerDomain() {
        configService.putLayer("instance", "llm-provider",
            Map.of("defaultModel", "instance-model"), "admin", null, null);
        configService.putLayer("user", "llm-provider",
            Map.of("defaultModel", "mimo-v2.5"), "user", userA, null);
        configService.putLayer("user", "agent-profile",
            Map.of("userName", "Alice"), "user", userA, null);
        configService.putLayer("workspace", "llm-provider",
            Map.of("temperature", "0.2"), "user", userA, wsA);

        Map<String, Map<String, String>> userOverrides = configService.overrides(
            "user", List.of("llm-provider", "agent-profile"), userA, wsA);
        assertEquals(Map.of("defaultModel", "mimo-v2.5"), userOverrides.get("llm-provider"));
        assertEquals(Map.of("userName", "Alice"), userOverrides.get("agent-profile"));

        Map<String, Map<String, String>> workspaceOverrides = configService.overrides(
            "workspace", List.of("llm-provider", "agent-profile"), userA, wsA);
        assertEquals(Map.of("temperature", "0.2"), workspaceOverrides.get("llm-provider"));
        assertFalse(workspaceOverrides.containsKey("agent-profile"));
    }

    @Test
    void overrides_areScopedByUserAndWorkspace() {
        configService.putLayer("user", "llm-provider",
            Map.of("defaultModel", "user-a-model"), "user", userA, null);
        configService.putLayer("workspace", "llm-provider",
            Map.of("defaultModel", "ws-a-model"), "user", userA, wsA);

        assertTrue(configService.overrides(
            "user", List.of("llm-provider"), userB, wsA).isEmpty());
        assertTrue(configService.overrides(
            "workspace", List.of("llm-provider"), userA, wsB).isEmpty());
    }

    @Test
    void overrides_omitDomainsWithoutRows() {
        assertTrue(configService.overrides(
            "user", List.of("llm-provider", "agent-profile"), userA, wsA).isEmpty());
    }

    @Test
    void envOverriddenKeys_hasNoOverlayForRunOverrideDomains() {
        // ENV_OVERLAY currently covers only embedding.model; run override domains
        // must stay overlay-free or the filter would have to strip them.
        assertTrue(configService.envOverriddenKeys("llm-provider").isEmpty());
        assertTrue(configService.envOverriddenKeys("agent-profile").isEmpty());
    }

    // ------------------------------------------------------------------
    // PLAN-0307 T2.24 (review P1-5): provider readiness via provider_connections
    // ------------------------------------------------------------------

    private void saveConnection(String ownerType, String ownerId, String providerId,
                                boolean enabled, String status) {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType(ownerType);
        connection.setOwnerId(ownerId);
        connection.setProviderId(providerId);
        connection.setLabel("test-connection");
        connection.setEnabled(enabled);
        connection.setStatus(status);
        connection.setEncryptionKeyVersion("v1");
        providerConnections.save(connection);
    }

    @Test
    void putLayer_userDefaultProviderRejectedWithoutReadyConnection() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("defaultProvider", "deepseek"), "user", userA, null));

        assertTrue(error.getMessage().contains("No ready provider connection for: deepseek"));
    }

    @Test
    void putLayer_userDefaultProviderRejectedWhenConnectionNotReady() {
        saveConnection("USER", userA.toString(), "deepseek", true, "VERIFYING");
        saveConnection("USER", userA.toString(), "openai", false, "READY");

        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("defaultProvider", "deepseek"), "user", userA, null));
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("defaultProvider", "openai"), "user", userA, null));
    }

    @Test
    void putLayer_userDefaultProviderAcceptedWithReadyUserConnection() {
        saveConnection("USER", userA.toString(), "deepseek", true, "READY");

        configService.putLayer("user", "llm-provider",
            Map.of("defaultProvider", "deepseek"), "user", userA, null);

        assertEquals("deepseek",
            configService.layerEntries("user", "llm-provider", userA, null).get("defaultProvider"));
    }

    @Test
    void putLayer_workspaceDefaultProviderAcceptedWithReadyWorkspaceConnection() {
        saveConnection("WORKSPACE", wsA.toString(), "xiaomi", true, "READY");

        configService.putLayer("workspace", "llm-provider",
            Map.of("defaultProvider", "xiaomi"), "user", userA, wsA);

        assertEquals("xiaomi",
            configService.layerEntries("workspace", "llm-provider", null, wsA).get("defaultProvider"));
    }

    @Test
    void putLayer_instanceDefaultProviderStaysContextFree() {
        // No user/workspace context exists at the instance layer; credentials are
        // per user/workspace under decision #37, so no readiness gate applies.
        configService.putLayer("instance", "llm-provider",
            Map.of("defaultProvider", "deepseek"), "admin", null, null);

        assertEquals("deepseek",
            configService.layerEntries("instance", "llm-provider", null, null).get("defaultProvider"));
    }

    // ------------------------------------------------------------------
    // PLAN-0307 T2.15 (decision #23): logging hot reload
    // ------------------------------------------------------------------

    @Test
    void putLayer_loggingInstanceAppliesLevelDynamically() {
        try {
            configService.putLayer("instance", "logging",
                Map.of("levelCp", "DEBUG"), "admin", null, null);
            assertTrue(LoggerFactory.getLogger("com.cc01cc.p.xihe.cp").isDebugEnabled());
        } finally {
            configService.putLayer("instance", "logging",
                Map.of("levelCp", "INFO"), "admin", null, null);
        }
        assertFalse(LoggerFactory.getLogger("com.cc01cc.p.xihe.cp").isDebugEnabled());
    }

    // ------------------------------------------------------------------
    // PLAN-0307 T2.21/T2.25: credential-aware import/export
    // ------------------------------------------------------------------

    @Test
    void exportJsonc_emptyConnectionsHasNoCredentialSection() {
        configService.putLayer("instance", "logging", Map.of("logLevel", "INFO"), "admin", null, null);

        String exported = configService.exportJsonc("instance", null, null, false);

        assertTrue(exported.contains("logLevel"));
        assertFalse(exported.contains("provider-connections"));
    }

    @Test
    void exportJsonc_includesConnectionMetadataAndHonorsIncludeSecrets() {
        UUID id = UUID.randomUUID();
        String ownerId = userA.toString();
        String aad = "deepseek|USER|" + ownerId + "|" + id;
        ProviderConnection connection = new ProviderConnection();
        connection.setId(id);
        connection.setOwnerType("USER");
        connection.setOwnerId(ownerId);
        connection.setProviderId("deepseek");
        connection.setLabel("Personal");
        connection.setEnabled(true);
        connection.setStatus("READY");
        connection.setModelDiscovery("manual");
        connection.setManualModels("[\"deepseek-chat\"]");
        connection.setEncryptionKeyVersion("v1");
        connection.setCredentialCiphertext(credentialEncryption.encrypt("sk-export-secret", aad));
        providerConnections.save(connection);

        String withSecrets = configService.exportJsonc("instance", null, null, true);
        assertTrue(withSecrets.contains("provider-connections"));
        assertTrue(withSecrets.contains("READY"));
        assertTrue(withSecrets.contains("manual"));
        assertTrue(withSecrets.contains("sk-export-secret"));
        assertFalse(withSecrets.contains("credential_ciphertext"));

        String withoutSecrets = configService.exportJsonc("instance", null, null, false);
        assertTrue(withoutSecrets.contains("label"));
        assertFalse(withoutSecrets.contains("sk-export-secret"));
        assertFalse(withoutSecrets.contains("apiKey"));
        assertFalse(withoutSecrets.contains("credential_ciphertext"));
    }

    @Test
    void importJsonc_skipsProviderConnectionsWithWarnings() {
        String content = "{\"logging\":{\"logLevel\":\"WARN\"},"
            + "\"provider-connections\":[{\"providerId\":\"deepseek\",\"apiKey\":\"sk-x\"}]}";

        ConfigService.ImportReport report = configService.importJsonc(content, "instance", null, null);

        assertEquals(1, report.imported());
        assertEquals(1, report.skipped());
        assertTrue(report.warnings().get(0).contains("never restore credentials"));
        assertEquals(0, providerConnections.count());
    }
}
