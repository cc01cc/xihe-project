package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import com.cc01cc.p.xihe.cp.entity.ConfigAuditEntity;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
    private CredentialRepository credentials;

    @Autowired
    @org.springframework.beans.factory.annotation.Qualifier("credentialEncryption")
    private com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService credentialEncryption;

    @Autowired
    @org.springframework.beans.factory.annotation.Qualifier("providerCredentialEncryption")
    private com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService legacyProviderEncryption;

    private final UUID userA = UUID.randomUUID();
    private final UUID userB = UUID.randomUUID();
    private final UUID wsA = UUID.randomUUID();
    private final UUID wsB = UUID.randomUUID();

    @BeforeEach
    void cleanDb() {
        auditRepo.deleteAll();
        repo.deleteAll();
        providerConnections.deleteAll();
        credentials.deleteAll();
    }

    @Test
    void putLayer_instance_isScopedWithoutIdentifiers() {
        configService.putLayer("instance", "logging", Map.of("logLevel", "WARN"), "admin", null, null);

        Map<String, String> entries = configService.layerEntries("instance", "logging", null, null);
        assertEquals("WARN", entries.get("logLevel"));
    }

    @Test
    void resolve_workspaceOverridesUserOverridesInstance() {
        // PLAN-0504: llm-provider identity moved to the profile unit; the
        // generic per-key resolution chain still applies to the kept keys.
        // PLAN-0523 T3.6: imageProvider is the remaining scalar llm-provider
        // key (sampling keys retired to per-model modelParams, decision #13).
        configService.putLayer("instance", "llm-provider",
            Map.of("imageProvider", "inst"), "admin", null, null);
        configService.putLayer("user", "llm-provider",
            Map.of("imageProvider", "usr"), "user", userA, null);
        configService.putLayer("workspace", "llm-provider",
            Map.of("imageProvider", "wrk"), "user", null, wsA);

        assertEquals("wrk",
            configService.resolveDomain("llm-provider", userA, wsA).get("imageProvider"));
        assertEquals("usr",
            configService.resolveDomain("llm-provider", userA, null).get("imageProvider"));
        assertEquals("inst",
            configService.resolveDomain("llm-provider", null, null).get("imageProvider"));
    }

    @Test
    void resolve_userLayerIsIsolatedByUserId() {
        configService.putLayer("user", "llm-provider",
            Map.of("imageProvider", "u-a"), "user", userA, null);
        configService.putLayer("user", "llm-provider",
            Map.of("imageProvider", "u-b"), "user", userB, null);

        assertEquals("u-a", configService.resolveDomain("llm-provider", userA, null).get("imageProvider"));
        assertEquals("u-b", configService.resolveDomain("llm-provider", userB, null).get("imageProvider"));
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
    void putLayer_approvalPolicyIsWorkspaceWritableButNeverUserWritable() {
        configService.putLayer("workspace", "approval-policy", Map.of("mode", "auto"), "user", null, wsA);

        assertEquals("auto", configService.resolve("approval-policy", "mode", null, wsA));

        assertThrows(ConfigService.ConfigAccessException.class, () ->
            configService.putLayer("user", "approval-policy", Map.of("mode", "auto"), "user", userA, null));
    }

    @Test
    void putLayer_approvalPolicyAtInstanceLayer_isAcceptedAsDefaultOverriddenByWorkspace() {
        // PLAN-0364 决策 #9（supersede PLAN-0337 选项①）：instance 层可写默认，workspace 覆盖；
        // 审计来源层由 effective(...).source 反映真实层级。
        configService.putLayer("instance", "approval-policy", Map.of("mode", "auto"), "admin", null, null);

        assertEquals("auto", configService.resolve("approval-policy", "mode", null, wsA));
        assertEquals("instance", configService.effective("approval-policy", null, wsA).source());

        configService.putLayer("workspace", "approval-policy", Map.of("mode", "manual"), "user", null, wsA);

        assertEquals("manual", configService.resolve("approval-policy", "mode", null, wsA));
        assertEquals("workspace", configService.effective("approval-policy", null, wsA).source());
    }

    @Test
    void putLayer_unknownApprovalMode_isRejectedBySchema() {
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("workspace", "approval-policy", Map.of("mode", "yolo"), "user", null, wsA));
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
    void putLayer_embeddingEmptyMap_clearsTheWholeUnitToInherit() {
        String unit = "{\"providerId\":\"dashscope-qwen\",\"connectionKey\":\"emb\",\"model\":\"tongyi-embedding-vision-flash-2026-03-06\"}";
        configService.putLayer("user", "embedding", Map.of("profile", unit), "tester", userA, null);
        assertEquals(unit, configService.layerEntries("user", "embedding", userA, null).get("profile"));

        configService.putLayer("user", "embedding", Map.of(), "tester", userA, null);

        assertTrue(configService.layerEntries("user", "embedding", userA, null).isEmpty(),
                "an empty embedding PUT must remove the whole-unit row so the layer inherits again");
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
        configService.putLayer("instance", "llm-provider",
            Map.of("imageProvider", "deepseek"), "tester", null, null);

        List<ConfigAuditEntity> audits = auditRepo.findAll();
        assertFalse(audits.isEmpty());
        ConfigAuditEntity audit = audits.get(audits.size() - 1);
        assertEquals("instance", audit.getLayer());
        assertEquals("deepseek", audit.getNewValue());
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
        // PLAN-0523 T3.6: llm-provider no longer carries scalar numeric keys;
        // job-policy defaultTimeoutSecs keeps exercising the numeric coercion.
        String jsonc = "{\"job-policy\":{\"defaultTimeoutSecs\":30}}";
        configService.importJsonc(jsonc, "instance", null, null);

        Map<String, String> entries = configService.layerEntries("instance", "job-policy", null, null);
        assertEquals("30", entries.get("defaultTimeoutSecs"));
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
            "{\"llm-provider\":{\"imageProvider\":\"deepseek\",\"modelParams\":\"{\\\"m\\\":{}}\"}}",
            "instance", null, null);
        configService.importJsonc(
            "{\"llm-provider\":{\"imageProvider\":\"xiaomi\"}}", "instance", null, null);

        Map<String, String> entries = configService.layerEntries("instance", "llm-provider", null, null);
        assertEquals("xiaomi", entries.get("imageProvider"));
        assertEquals("{\"m\":{}}", entries.get("modelParams"));
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
            Map.of("imageProvider", "inst"), "admin", null, null);
        configService.putLayer("user", "llm-provider",
            Map.of("imageProvider", "usr"), "user", userA, null);
        configService.putLayer("user", "agent-profile",
            Map.of("userName", "Alice"), "user", userA, null);
        configService.putLayer("workspace", "llm-provider",
            Map.of("imageProvider", "wrk"), "user", userA, wsA);

        Map<String, Map<String, String>> userOverrides = configService.overrides(
            "user", List.of("llm-provider", "agent-profile"), userA, wsA);
        assertEquals(Map.of("imageProvider", "usr"), userOverrides.get("llm-provider"));
        assertEquals(Map.of("userName", "Alice"), userOverrides.get("agent-profile"));

        Map<String, Map<String, String>> workspaceOverrides = configService.overrides(
            "workspace", List.of("llm-provider", "agent-profile"), userA, wsA);
        assertEquals(Map.of("imageProvider", "wrk"), workspaceOverrides.get("llm-provider"));
        assertFalse(workspaceOverrides.containsKey("agent-profile"));
    }

    @Test
    void overrides_areScopedByUserAndWorkspace() {
        configService.putLayer("user", "llm-provider",
            Map.of("imageProvider", "u-a"), "user", userA, null);
        configService.putLayer("workspace", "llm-provider",
            Map.of("imageProvider", "w-a"), "user", userA, wsA);

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
    // PLAN-0504: llm-provider profile — shape / visibility / READY / clear /
    // legacy-key rejection / effective resolution / conflict
    // ------------------------------------------------------------------

    private void saveConnection(String ownerType, String ownerId, String providerId,
                                String connectionKey, boolean enabled, String status) {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType(ownerType);
        connection.setOwnerId(ownerId);
        connection.setProviderId(providerId);
        connection.setConnectionKey(connectionKey);
        connection.setApiTypeId("xiaomi".equals(providerId)
                ? "mimo-responses" : "openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel("test-connection");
        connection.setEnabled(enabled);
        connection.setStatus(status);
        providerConnections.save(connection);
    }

    private void saveConnection(String ownerType, String ownerId, String providerId,
                                boolean enabled, String status) {
        saveConnection(ownerType, ownerId, providerId, "default", enabled, status);
    }

    private static String profile(String providerId, String connectionKey, String model) {
        return "{\"providerId\":\"" + providerId + "\",\"connectionKey\":\""
            + connectionKey + "\",\"model\":\"" + model + "\"}";
    }

    /** Insert a profile row without validation (simulates pre-0552 data). */
    private void saveRawProfile(String layer, UUID userId, UUID workspaceId, String value) {
        ConfigEntity entity = new ConfigEntity();
        entity.setLayer(layer);
        entity.setUserId(userId);
        entity.setWorkspaceId(workspaceId);
        entity.setDomain("llm-provider");
        entity.setConfigKey("profile");
        entity.setConfigValue(value);
        entity.setUpdatedBy("test");
        repo.save(entity);
    }

    private void setLegacyFallback(boolean enabled) {
        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(configService);
        org.springframework.test.util.ReflectionTestUtils.setField(
            target, "legacyConnectionFallback", enabled);
    }

    @Test
    void putLayer_llmProfileRejectsPartialProfile() {
        // A missing field fails schema validation first (400 INVALID_REQUEST).
        IllegalArgumentException schemaError = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "llm-provider",
                Map.of("profile", "{\"providerId\":\"deepseek\"}"), "admin", null, null));
        assertTrue(schemaError.getMessage().contains("Schema validation failed"));

        // A blank field passes the schema but is rejected by the profile parser.
        CpApiException parseError = assertThrows(CpApiException.class, () ->
            configService.putLayer("instance", "llm-provider",
                Map.of("profile",
                    "{\"providerId\":\"\",\"connectionKey\":\"default\",\"model\":\"m\"}"),
                "admin", null, null));

        assertEquals("INVALID_REQUEST", parseError.getCode());
        assertTrue(parseError.getMessage().contains("complete providerId/connectionKey/model unit"));
    }

    @Test
    void putLayer_llmProfileRejectsExtraFields() {
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "llm-provider",
                Map.of("profile",
                    "{\"providerId\":\"deepseek\",\"connectionKey\":\"default\",\"model\":\"m\",\"extra\":\"x\"}"),
                "admin", null, null));
    }

    @Test
    void putLayer_llmProfileUserLayerRejectedWithoutReadyConnection() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
                "user", userA, null));

        assertTrue(error.getMessage().contains(
            "No ready provider connection for profile: deepseek/default"));
    }

    @Test
    void putLayer_llmProfileUserLayerRejectedWhenConnectionNotReady() {
        saveConnection("USER", userA.toString(), "deepseek", true, "VERIFYING");
        saveConnection("USER", userA.toString(), "openai", false, "READY");

        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
                "user", userA, null));
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("profile", profile("openai", "default", "gpt-4o")),
                "user", userA, null));
    }

    @Test
    void putLayer_llmProfileUserLayerRejectedWhenProviderMismatch() {
        // The ready connection exists for openai; a deepseek profile must not
        // borrow it (same connectionKey, different provider).
        saveConnection("USER", userA.toString(), "openai", "default", true, "READY");

        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
                "user", userA, null));

        assertTrue(error.getMessage().contains(
            "No ready provider connection for profile: deepseek/default"));
    }

    @Test
    void putLayer_llmProfileUserLayerAcceptedWithReadyUserConnection() {
        saveConnection("USER", userA.toString(), "deepseek", true, "READY");

        configService.putLayer("user", "llm-provider",
            Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
            "user", userA, null);

        assertEquals(profile("deepseek", "default", "deepseek-chat"),
            configService.layerEntries("user", "llm-provider", userA, null).get("profile"));
    }

    @Test
    void putLayer_llmProfileWorkspaceLayerAcceptedWithReadyWorkspaceConnection() {
        saveConnection("WORKSPACE", wsA.toString(), "xiaomi", "default", true, "READY");

        configService.putLayer("workspace", "llm-provider",
            Map.of("profile", profile("xiaomi", "default", "mimo-v2.5")),
            "user", userA, wsA);

        assertEquals(profile("xiaomi", "default", "mimo-v2.5"),
            configService.layerEntries("workspace", "llm-provider", null, wsA).get("profile"));
    }

    @Test
    void putLayer_llmProfileInstanceStaysContextFree() {
        // Decision #11: the instance layer allows a profile without a
        // connection check; the consumer scope resolves the connection.
        configService.putLayer("instance", "llm-provider",
            Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
            "admin", null, null);

        assertEquals(profile("deepseek", "default", "deepseek-chat"),
            configService.layerEntries("instance", "llm-provider", null, null).get("profile"));
    }

    @Test
    void putLayer_llmProfileEmptyValueClearsLayerToInherit() {
        saveConnection("USER", userA.toString(), "openai", true, "READY");
        configService.putLayer("instance", "llm-provider",
            Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
            "admin", null, null);
        configService.putLayer("user", "llm-provider",
            Map.of("profile", profile("openai", "default", "gpt-4o")),
            "user", userA, null);

        configService.putLayer("user", "llm-provider", Map.of("profile", ""), "user", userA, null);

        assertTrue(configService.layerEntries("user", "llm-provider", userA, null).isEmpty(),
            "an empty profile PUT must remove the layer row so the layer inherits again");
        ConfigService.EffectiveLlmProfile effective =
            configService.effectiveLlmProfile(userA, null);
        assertEquals("deepseek", effective.profile().providerId());
        assertEquals("instance", effective.profileScope());
    }

    @Test
    void putLayer_llmLegacyKeysRejectedBySchema() {
        for (String legacy : List.of("defaultProvider", "defaultModel", "openaiModel",
                "openaiApiBase", "baseUrl", "xiaomiModel", "xiaomiApiBase")) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
                configService.putLayer("instance", "llm-provider",
                    Map.of(legacy, "value"), "admin", null, null),
                "legacy key must be rejected: " + legacy);
            assertTrue(error.getMessage().contains("Schema validation failed"),
                "legacy key must fail schema validation: " + legacy);
        }
    }

    @Test
    void effectiveLlmProfile_workspaceWinsWholeThenUserThenInstance() {
        saveConnection("USER", userA.toString(), "openai", true, "READY");
        saveConnection("WORKSPACE", wsA.toString(), "xiaomi", true, "READY");
        configService.putLayer("instance", "llm-provider",
            Map.of("profile", profile("deepseek", "default", "instance-model")),
            "admin", null, null);
        configService.putLayer("user", "llm-provider",
            Map.of("profile", profile("openai", "default", "user-model")),
            "user", userA, null);
        configService.putLayer("workspace", "llm-provider",
            Map.of("profile", profile("xiaomi", "default", "workspace-model")),
            "user", null, wsA);

        ConfigService.EffectiveLlmProfile effective =
            configService.effectiveLlmProfile(userA, wsA);
        assertEquals("xiaomi", effective.profile().providerId());
        assertEquals("workspace", effective.profileScope());

        effective = configService.effectiveLlmProfile(userA, null);
        assertEquals("openai", effective.profile().providerId());
        assertEquals("user", effective.profileScope());

        effective = configService.effectiveLlmProfile(null, null);
        assertEquals("deepseek", effective.profile().providerId());
        assertEquals("instance", effective.profileScope());

        effective = configService.effectiveLlmProfile(userB, null);
        assertEquals("deepseek", effective.profile().providerId());
    }

    @Test
    void effectiveLlmProfile_noProfileAnywhereIsExplicitlyEmpty() {
        ConfigService.EffectiveLlmProfile effective =
            configService.effectiveLlmProfile(userA, wsA);

        assertNull(effective.profile());
        assertNull(effective.profileScope());
    }

    @Test
    void resolveLlmProfile_userProfileUsesOnlyUserConnection() {
        saveConnection("USER", userA.toString(), "deepseek", "default", true, "READY");
        saveConnection("WORKSPACE", wsA.toString(), "deepseek", "default", true, "READY");
        configService.putLayer("user", "llm-provider",
            Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
            "user", userA, null);

        ConfigService.ResolvedLlmProfile resolved =
            configService.resolveLlmProfile(userA, wsA);
        assertEquals("USER", resolved.connectionOwnerType());
        assertEquals(userA.toString(), resolved.connectionOwnerId());
    }

    @Test
    void resolveLlmProfile_workspaceProfileUsesWorkspaceConnection() {
        saveConnection("USER", userA.toString(), "deepseek", "default", true, "READY");
        saveConnection("WORKSPACE", wsA.toString(), "deepseek", "default", true, "READY");
        configService.putLayer("workspace", "llm-provider",
            Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
            "user", null, wsA);

        ConfigService.ResolvedLlmProfile resolved =
            configService.resolveLlmProfile(userA, wsA);
        assertEquals("WORKSPACE", resolved.connectionOwnerType());
        assertEquals(wsA.toString(), resolved.connectionOwnerId());
        assertEquals("workspace", resolved.profileScope());
    }

    @Test
    void resolveLlmProfile_userProfileDoesNotBorrowWorkspaceConnection() {
        saveConnection("WORKSPACE", wsA.toString(), "deepseek", "default", true, "READY");
        // Existing row from before strict validation: user profile + only a
        // workspace connection must fail instead of silently borrowing it.
        saveRawProfile("user", userA, null, profile("deepseek", "default", "deepseek-chat"));

        CpApiException error = assertThrows(CpApiException.class, () ->
            configService.resolveLlmProfile(userA, wsA));

        assertEquals("LLM_PROFILE_CONFLICT", error.getCode());
    }

    @Test
    void resolveLlmProfile_instanceProfileUsesConsumingUserConnection() {
        saveConnection("USER", userA.toString(), "deepseek", "default", true, "READY");
        saveConnection("WORKSPACE", wsA.toString(), "deepseek", "default", true, "READY");
        configService.putLayer("instance", "llm-provider",
            Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
            "admin", null, null);

        ConfigService.ResolvedLlmProfile resolved =
            configService.resolveLlmProfile(userA, wsA);
        assertEquals("USER", resolved.connectionOwnerType());
        assertEquals(userA.toString(), resolved.connectionOwnerId());
        assertEquals("instance", resolved.profileScope());

        // No consuming user -> no owner to resolve; never borrow workspace.
        CpApiException error = assertThrows(CpApiException.class, () ->
            configService.resolveLlmProfile(null, wsA));
        assertEquals("LLM_PROFILE_CONFLICT", error.getCode());
    }

    @Test
    void resolveLlmProfile_legacyFallbackRestoresWorkspaceThenUser() {
        saveConnection("WORKSPACE", wsA.toString(), "deepseek", "default", true, "READY");
        saveRawProfile("user", userA, null, profile("deepseek", "default", "deepseek-chat"));
        setLegacyFallback(true);
        try {
            ConfigService.ResolvedLlmProfile resolved =
                configService.resolveLlmProfile(userA, wsA);
            assertEquals("WORKSPACE", resolved.connectionOwnerType());
        } finally {
            setLegacyFallback(false);
        }
    }

    @Test
    void putLayer_llmProfileUserLayerRejectedWhenOnlyWorkspaceConnection() {
        saveConnection("WORKSPACE", wsA.toString(), "deepseek", "default", true, "READY");

        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
                "user", userA, null));

        assertTrue(error.getMessage().contains(
            "No ready provider connection for profile: deepseek/default"));
    }

    @Test
    void putLayer_llmProfileWorkspaceLayerRejectedWhenOnlyUserConnection() {
        saveConnection("USER", userA.toString(), "deepseek", "default", true, "READY");

        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("workspace", "llm-provider",
                Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
                "user", null, wsA));

        assertTrue(error.getMessage().contains(
            "No ready provider connection for profile: deepseek/default"));
    }

    @Test
    void putLayer_llmProfileLegacyFallbackAllowsWorkspaceToUseUserConnectionWhenEnabled() {
        // Legacy validation allowed a workspace profile to be accepted by a
        // ready user connection (workspaceId present, userId = actor). Strict
        // mode rejects it; the transition switch restores the old behavior.
        saveConnection("USER", userA.toString(), "deepseek", "default", true, "READY");
        setLegacyFallback(true);
        try {
            configService.putLayer("workspace", "llm-provider",
                Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
                "user", userA, wsA);
            assertEquals(profile("deepseek", "default", "deepseek-chat"),
                configService.layerEntries("workspace", "llm-provider", null, wsA).get("profile"));
        } finally {
            setLegacyFallback(false);
        }
    }

    @Test
    void resolveLlmProfile_conflictWhenConnectionMissing() {
        configService.putLayer("instance", "llm-provider",
            Map.of("profile", profile("deepseek", "default", "deepseek-chat")),
            "admin", null, null);

        CpApiException error = assertThrows(CpApiException.class, () ->
            configService.resolveLlmProfile(userA, wsA));

        assertEquals("LLM_PROFILE_CONFLICT", error.getCode());
    }

    // ------------------------------------------------------------------
    // PLAN-0503 T1.1: catalog-derived provider acceptance (now on profile.providerId)
    // ------------------------------------------------------------------

    @Test
    void putLayer_instanceAcceptsNonBuiltinCatalogProvider() {
        // The accept set is the CP provider catalog, so a non-builtin catalog
        // provider (openrouter) passes instance-layer validation.
        configService.putLayer("instance", "llm-provider",
            Map.of("profile", profile("openrouter", "default", "some-model")),
            "admin", null, null);

        assertEquals(profile("openrouter", "default", "some-model"),
            configService.layerEntries("instance", "llm-provider", null, null).get("profile"));
    }

    @Test
    void putLayer_rejectsProviderOutsideCatalog() {
        // Legacy inline "dashscope" is not a catalog id (the catalog id is
        // dashscope-qwen) and must be rejected after the single-source switch.
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "llm-provider",
                Map.of("profile", profile("dashscope", "default", "some-model")),
                "admin", null, null));

        assertTrue(error.getMessage().contains("profile.providerId is unsupported: dashscope"));
    }

    @Test
    void putLayer_userCatalogProviderStillRequiresReadyConnection() {
        // Catalog membership does not bypass the user-layer readiness gate.
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("profile", profile("openrouter", "default", "some-model")),
                "user", userA, null));
        assertTrue(error.getMessage().contains(
            "No ready provider connection for profile: openrouter/default"));

        saveConnection("USER", userA.toString(), "openrouter", true, "READY");
        configService.putLayer("user", "llm-provider",
            Map.of("profile", profile("openrouter", "default", "some-model")),
            "user", userA, null);

        assertEquals(profile("openrouter", "default", "some-model"),
            configService.layerEntries("user", "llm-provider", userA, null).get("profile"));
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
        Credential credential = new Credential();
        UUID credentialId = UUID.randomUUID();
        credential.setId(credentialId);
        credential.setOwnerType(Credential.OWNER_USER);
        credential.setOwnerId(ownerId);
        credential.setLabel("Personal");
        credential.setKind(Credential.KIND_TOKEN);
        credential.setDeliveryTier(Credential.TIER_LEASE);
        credential.setStatus(Credential.STATUS_ACTIVE);
        credential.setKeyVersion(credentialEncryption.currentVersion());
        credential.setFingerprint("fingerprint");
        credential.setSecretCiphertext(credentialEncryption.encrypt(
                "{\"token\":\"sk-export-secret\"}",
                com.cc01cc.p.xihe.cp.credentials.CredentialAad.format(credentialId.toString(),
                        Credential.OWNER_USER, ownerId)));
        credentials.save(credential);

        ProviderConnection connection = new ProviderConnection();
        connection.setId(id);
        connection.setOwnerType("USER");
        connection.setOwnerId(ownerId);
        connection.setProviderId("deepseek");
        connection.setConnectionKey("default");
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel("Personal");
        connection.setEnabled(true);
        connection.setStatus("READY");
        connection.setModelDiscovery("manual");
        connection.setManualModels("[\"deepseek-chat\"]");
        connection.setCredentialId(credentialId);
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

    // ------------------------------------------------------------------
    // PLAN-0373 (BL-22): job-policy domain — 写层 / schema / 代码默认 / env 锁定
    // ------------------------------------------------------------------

    @Test
    void putLayer_jobPolicy_isInstanceAndWorkspaceWritableButNeverUserWritable() {
        configService.putLayer("instance", "job-policy",
            Map.of("defaultTimeoutSecs", "7200", "maxTimeoutSecs", "3600"), "admin", null, null);
        assertEquals("7200",
            configService.resolve("job-policy", "defaultTimeoutSecs", null, wsA));

        // workspace 在解析链上覆盖 instance（上限内下调的生效路径；上限钳制在 CP 执行点）。
        configService.putLayer("workspace", "job-policy",
            Map.of("defaultTimeoutSecs", "1800"), "user", null, wsA);
        assertEquals("1800",
            configService.resolve("job-policy", "defaultTimeoutSecs", null, wsA));
        assertEquals("workspace",
            configService.effective("job-policy", null, wsA).source());

        assertThrows(ConfigService.ConfigAccessException.class, () ->
            configService.putLayer("user", "job-policy",
                Map.of("defaultTimeoutSecs", "60"), "user", userA, null));
    }

    @Test
    void effective_jobPolicy_includesCodeDefaultsWhenUnset() {
        ConfigService.EffectiveConfig effective = configService.effective("job-policy", null, null);

        assertEquals("default", effective.source());
        assertEquals("3600", effective.entries().get("defaultTimeoutSecs"));
        assertEquals("0", effective.entries().get("maxTimeoutSecs"));
    }

    @Test
    void putLayer_jobPolicySchemaRejectsInvalidValues() {
        // defaultTimeoutSecs ≥1；maxTimeoutSecs ≥0（0 = 上限未设）；未知键 additionalProperties 拒绝。
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "job-policy",
                Map.of("defaultTimeoutSecs", "0"), "admin", null, null));
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "job-policy",
                Map.of("maxTimeoutSecs", "-1"), "admin", null, null));
        Map<String, String> extra = new java.util.LinkedHashMap<>();
        extra.put("defaultTimeoutSecs", "3600");
        extra.put("unknownField", "1");
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "job-policy", extra, "admin", null, null));
    }

    @Test
    void resolve_jobPolicy_envOverlayBeatsDatabaseRows() {
        // env 命中即锁定（决策 #7/P3）：resolve/effective 取 env 值并署名 env，
        // UI 经 envOverriddenKeys 渲染锁定态（镜像 embedding.model 机制）。
        configService.putLayer("instance", "job-policy",
            Map.of("defaultTimeoutSecs", "3600"), "admin", null, null);
        Object originalOverlay = org.springframework.test.util.ReflectionTestUtils
            .getField(configService, "envOverlay");
        Map<String, String> env = Map.of("XIHE_JOB_TIMEOUT_DEFAULT_SECS", "7200");
        org.springframework.test.util.ReflectionTestUtils.setField(
            configService, "envOverlay", new EnvOverlayRegistry(env::get));
        try {
            assertEquals("7200",
                configService.resolve("job-policy", "defaultTimeoutSecs", null, null));
            assertTrue(configService.envOverriddenKeys("job-policy")
                .contains("defaultTimeoutSecs"));
            assertEquals("env", configService.effective("job-policy", null, null).source());
        } finally {
            org.springframework.test.util.ReflectionTestUtils.setField(
                configService, "envOverlay", originalOverlay);
        }
    }

    @Test
    void importJsonc_acceptsJobPolicySection() {
        String jsonc = "{\"job-policy\":{\"defaultTimeoutSecs\":1800,\"maxTimeoutSecs\":600}}";

        configService.importJsonc(jsonc, "instance", null, null);

        Map<String, String> entries =
            configService.layerEntries("instance", "job-policy", null, null);
        assertEquals("1800", entries.get("defaultTimeoutSecs"));
        assertEquals("600", entries.get("maxTimeoutSecs"));
    }

    // ------------------------------------------------------------------
    // PLAN-0492: agent-runtime run budget — 值键写层 / ceiling 键级 instance 锁 /
    // schema / 代码默认 / token 键不被凭据拦截
    // ------------------------------------------------------------------

    @Test
    void putLayer_runBudgetValuesAreUserAndWorkspaceWritable() {
        configService.putLayer("instance", "agent-runtime",
            Map.of("runMaxTurns", "25", "runMaxElapsedSeconds", "600", "runMaxTokens", "0"),
            "admin", null, null);
        configService.putLayer("user", "agent-runtime",
            Map.of("runMaxTurns", "10"), "user", userA, null);
        configService.putLayer("workspace", "agent-runtime",
            Map.of("runMaxTurns", "5"), "user", null, wsA);

        assertEquals("25", configService.resolve("agent-runtime", "runMaxTurns", null, null));
        assertEquals("10", configService.resolve("agent-runtime", "runMaxTurns", userA, null));
        assertEquals("5", configService.resolve("agent-runtime", "runMaxTurns", userA, wsA));
        assertEquals("workspace",
            configService.effective("agent-runtime", userA, wsA).source());
    }

    @Test
    void putLayer_runBudgetCeilingsAreInstanceOnly() {
        configService.putLayer("instance", "agent-runtime",
            Map.of("runMaxTurnsCeiling", "100",
                "runMaxElapsedSecondsCeiling", "3600",
                "runMaxTokensCeiling", "0"),
            "admin", null, null);
        assertEquals("100",
            configService.layerEntries("instance", "agent-runtime", null, null)
                .get("runMaxTurnsCeiling"));

        for (String key : List.of("runMaxTurnsCeiling", "runMaxElapsedSecondsCeiling",
                "runMaxTokensCeiling")) {
            assertThrows(ConfigService.ConfigAccessException.class, () ->
                configService.putLayer("user", "agent-runtime",
                    Map.of(key, "50"), "user", userA, null),
                "user layer must not write " + key);
            assertThrows(ConfigService.ConfigAccessException.class, () ->
                configService.putLayer("workspace", "agent-runtime",
                    Map.of(key, "50"), "user", null, wsA),
                "workspace layer must not write " + key);
        }
    }

    @Test
    void effective_runBudget_includesCodeDefaultsWhenUnset() {
        ConfigService.EffectiveConfig effective = configService.effective("agent-runtime", null, null);

        assertEquals("default", effective.source());
        assertEquals("25", effective.entries().get("runMaxTurns"));
        assertEquals("600", effective.entries().get("runMaxElapsedSeconds"));
        // PLAN-0492 T0.3 回填（2026-10-13 真实数据标定，见 evidence/m0-token-calibration.md）。
        assertEquals("38303", effective.entries().get("runMaxTokens"));
        assertEquals("100", effective.entries().get("runMaxTurnsCeiling"));
        assertEquals("3600", effective.entries().get("runMaxElapsedSecondsCeiling"));
        assertEquals("51070", effective.entries().get("runMaxTokensCeiling"));
    }

    // ------------------------------------------------------------------
    // PLAN-0493: agent-runtime loop guard — 值键写层 / ceiling 键级 instance 锁 /
    // schema（值键 0 拒绝 + 通配符拒绝）/ 代码默认
    // ------------------------------------------------------------------

    @Test
    void putLayer_loopGuardValuesAreUserAndWorkspaceWritable() {
        configService.putLayer("instance", "agent-runtime",
            Map.of("loopRepeatWarn", "2", "loopWindowSize", "20"),
            "admin", null, null);
        configService.putLayer("user", "agent-runtime",
            Map.of("loopRepeatWarn", "3"), "user", userA, null);
        configService.putLayer("workspace", "agent-runtime",
            Map.of("loopRepeatWarn", "4"), "user", null, wsA);

        assertEquals("2", configService.resolve("agent-runtime", "loopRepeatWarn", null, null));
        assertEquals("3", configService.resolve("agent-runtime", "loopRepeatWarn", userA, null));
        assertEquals("4", configService.resolve("agent-runtime", "loopRepeatWarn", userA, wsA));
    }

    @Test
    void putLayer_loopGuardCeilingsAreInstanceOnly() {
        configService.putLayer("instance", "agent-runtime",
            Map.of("loopRepeatEscalateCeiling", "10", "loopWindowSizeCeiling", "50"),
            "admin", null, null);
        assertEquals("10",
            configService.layerEntries("instance", "agent-runtime", null, null)
                .get("loopRepeatEscalateCeiling"));

        for (String key : List.of("loopRepeatEscalateCeiling", "loopErrorRunEscalateCeiling",
                "loopStaleResultEscalateCeiling", "loopWindowSizeCeiling")) {
            assertThrows(ConfigService.ConfigAccessException.class, () ->
                configService.putLayer("user", "agent-runtime",
                    Map.of(key, "5"), "user", userA, null),
                "user layer must not write " + key);
            assertThrows(ConfigService.ConfigAccessException.class, () ->
                configService.putLayer("workspace", "agent-runtime",
                    Map.of(key, "5"), "user", null, wsA),
                "workspace layer must not write " + key);
        }
    }

    @Test
    void effective_loopGuard_includesCodeDefaultsWhenUnset() {
        ConfigService.EffectiveConfig effective =
            configService.effective("agent-runtime", null, null);

        assertEquals("default", effective.source());
        assertEquals("2", effective.entries().get("loopRepeatWarn"));
        assertEquals("3", effective.entries().get("loopRepeatRefuse"));
        assertEquals("5", effective.entries().get("loopRepeatEscalate"));
        assertEquals("3", effective.entries().get("loopErrorRunWarn"));
        assertEquals("5", effective.entries().get("loopErrorRunEscalate"));
        assertEquals("2", effective.entries().get("loopStaleResultWarn"));
        assertEquals("5", effective.entries().get("loopStaleResultEscalate"));
        assertEquals("20", effective.entries().get("loopWindowSize"));
        assertEquals("10", effective.entries().get("loopRepeatEscalateCeiling"));
        assertEquals("10", effective.entries().get("loopErrorRunEscalateCeiling"));
        assertEquals("10", effective.entries().get("loopStaleResultEscalateCeiling"));
        assertEquals("50", effective.entries().get("loopWindowSizeCeiling"));
    }

    @Test
    void putLayer_loopGuardSchemaRejectsZeroAndWildcardEntries() {
        // 值键 0 无定义语义 → schema 拒绝（ceiling 键仍允许 0 = 不钳制）。
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "agent-runtime",
                Map.of("loopRepeatWarn", "0"), "admin", null, null));
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "agent-runtime",
                Map.of("loopWindowSize", "-3"), "admin", null, null));
        // 通配符条目被 pattern 拒绝。
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "agent-runtime",
                Map.of("loopExemptTools", "[\"*\"]"), "admin", null, null));
        // 合法追加项通过并原样往返。
        configService.putLayer("instance", "agent-runtime",
            Map.of("loopExemptTools", "[\"my_poll_tool\"]"), "admin", null, null);
        assertEquals("[\"my_poll_tool\"]",
            configService.layerEntries("instance", "agent-runtime", null, null)
                .get("loopExemptTools"));
    }

    @Test
    void putLayer_runBudgetSchemaRejectsInvalidValues() {
        // 六键均 >=0（0 = 该维度不启用 / ceiling 不钳制）；负数与未知键被拒。
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "agent-runtime",
                Map.of("runMaxTurns", "-1"), "admin", null, null));
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "agent-runtime",
                Map.of("runMaxElapsedSecondsCeiling", "-5"), "admin", null, null));
        Map<String, String> extra = new java.util.LinkedHashMap<>();
        extra.put("runMaxTurns", "25");
        extra.put("unknownBudgetKey", "1");
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "agent-runtime", extra, "admin", null, null));
    }

    @Test
    void putLayer_runMaxTokensIsNotTreatedAsProviderSecret() {
        // 凭据拦截规则只对含 token 的键生效；runMaxTokens 与 maxTokens 一样是生成参数。
        configService.putLayer("instance", "agent-runtime",
            Map.of("runMaxTokens", "65536"), "admin", null, null);

        assertEquals("65536", configService.layerEntries("instance", "agent-runtime", null, null)
            .get("runMaxTokens"));
    }

    // ------------------------------------------------------------------
    // PLAN-0523 T2.1: imageProfile / modelParams additive schema
    // ------------------------------------------------------------------

    @Test
    void putLayer_instanceAcceptsImageProfile() {
        // Instance-layer global image default: no ready-connection gate
        // (decision #11 run-time scope resolution, same as instance profile).
        configService.putLayer("instance", "llm-provider",
            Map.of("imageProfile", profile("deepseek", "default", "deepseek-image")),
            "admin", null, null);

        assertEquals(profile("deepseek", "default", "deepseek-image"),
            configService.layerEntries("instance", "llm-provider", null, null).get("imageProfile"));
    }

    @Test
    void putLayer_userLayerRejectsImageProfile() {
        saveConnection("USER", userA.toString(), "deepseek", "default", true, "READY");
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "llm-provider",
                Map.of("imageProfile", profile("deepseek", "default", "deepseek-image")),
                "user", userA, null));

        assertTrue(error.getMessage().contains("imageProfile is instance-layer only"));
    }

    @Test
    void putLayer_rejectsImageProfileOutsideCatalog() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "llm-provider",
                Map.of("imageProfile", profile("dashscope", "default", "some-image")),
                "admin", null, null));

        assertTrue(error.getMessage().contains("imageProfile.providerId is unsupported: dashscope"));
    }

    @Test
    void putLayer_imageProfileBlankClears() {
        configService.putLayer("instance", "llm-provider",
            Map.of("imageProfile", profile("deepseek", "default", "deepseek-image")),
            "admin", null, null);
        configService.putLayer("instance", "llm-provider",
            Map.of("imageProfile", ""), "admin", null, null);

        assertNull(configService.layerEntries("instance", "llm-provider", null, null)
            .get("imageProfile"));
    }

    @Test
    void putLayer_imageProfileRejectsPartialUnit() {
        // Schema required-keys fire before provider validation (400 INVALID_REQUEST).
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "llm-provider",
                Map.of("imageProfile", "{\"providerId\":\"deepseek\"}"), "admin", null, null));

        assertTrue(error.getMessage().contains("Schema validation failed"));
    }

    @Test
    void putLayer_modelParamsRoundTripAndClear() {
        String params = "{\"deepseek-chat\":{\"maxTokens\":8192,\"temperature\":\"0.6\",\"timeout\":60}}";
        configService.putLayer("instance", "llm-provider",
            Map.of("modelParams", params), "admin", null, null);

        assertEquals(params,
            configService.layerEntries("instance", "llm-provider", null, null).get("modelParams"));

        // Empty object clears the whole map (decision #14 whole-domain override).
        configService.putLayer("instance", "llm-provider",
            Map.of("modelParams", "{}"), "admin", null, null);

        assertNull(configService.layerEntries("instance", "llm-provider", null, null)
            .get("modelParams"));
    }

    @Test
    void putLayer_rejectsOutOfRangeModelParams() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "llm-provider",
                Map.of("modelParams", "{\"deepseek-chat\":{\"temperature\":5}}"), "admin", null, null));

        assertTrue(error.getMessage().contains("Schema validation failed"));
    }

    @Test
    void putLayer_rejectsUnknownModelParamsField() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("instance", "llm-provider",
                Map.of("modelParams", "{\"deepseek-chat\":{\"topP\":0.9}}"), "admin", null, null));

        assertTrue(error.getMessage().contains("Schema validation failed"));
    }
}
