package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;

import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * D-928 / PLAN-0766 M2: service-level semantics of the shared layer — the five-hop
 * priority, whole-unit (EXPLICIT_ONLY) semantics, the domain guard, and the
 * BL-581 same-fixture agreement between the llm and embedding profile chains.
 */
@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ConfigWorkspaceDefaultProfileTest {

    @Autowired
    private ConfigService configService;

    @Autowired
    private EmbeddingProfileService embeddingProfiles;

    @Autowired
    private ConfigJpaRepository repo;

    @Autowired
    private ConfigAuditRepository auditRepo;

    private final UUID userA = UUID.randomUUID();
    private final UUID wsA = UUID.randomUUID();

    @BeforeEach
    void cleanDb() {
        auditRepo.deleteAll();
        repo.deleteAll();
    }

    private ConfigEntity row(String layer, String domain, String key, String value, UUID userId) {
        ConfigEntity entity = new ConfigEntity();
        entity.setLayer(layer);
        entity.setDomain(domain);
        entity.setConfigKey(key);
        entity.setConfigValue(value);
        entity.setUserId(userId);
        entity.setUpdatedBy("test");
        return entity;
    }

    @Test
    void fiveHopPriority_defaultBeatsUserAndInstanceLosesToWorkspace() {
        // T2.4: the model 4 domains left both workspace-scoped layers, so the five-hop
        // chain is pinned on agent-runtime (writable at instance / user /
        // workspace-default / workspace alike).
        configService.putLayer("instance", "agent-runtime",
            Map.of("runMaxTurns", "10"), "admin", null, null);
        configService.putLayer("user", "agent-runtime",
            Map.of("runMaxTurns", "20"), "user", userA, null);
        configService.putLayer("workspace-default", "agent-runtime",
            Map.of("runMaxTurns", "30"), "admin", null, null);

        // default beats the user row ...
        assertEquals("30", configService.resolve("agent-runtime", "runMaxTurns", userA, null));
        // ... and the instance row.
        assertEquals("30", configService.resolve("agent-runtime", "runMaxTurns", null, null));

        // ... and loses whole to an explicit workspace row.
        configService.putLayer("workspace", "agent-runtime",
            Map.of("runMaxTurns", "40"), "user", null, wsA);
        assertEquals("40", configService.resolve("agent-runtime", "runMaxTurns", userA, wsA));

        // effective source follows the same hop.
        assertEquals("workspace",
            configService.effective("agent-runtime", userA, wsA).source());
        assertEquals("workspace-default",
            configService.effective("agent-runtime", userA, null).source());

        // clearing the default falls back to user, then instance.
        configService.deleteKey("workspace-default", "agent-runtime", "runMaxTurns",
            "admin", null, null);
        assertEquals("20", configService.resolve("agent-runtime", "runMaxTurns", userA, null));
        assertEquals("10", configService.resolve("agent-runtime", "runMaxTurns", null, null));
    }

    @Test
    void domainGuard_nonWritableDomainsAnswer400() {
        CpApiException logging = assertThrows(CpApiException.class, () ->
            configService.putLayer("workspace-default", "logging",
                Map.of("logLevel", "DEBUG"), "admin", null, null));
        assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", logging.getCode());

        CpApiException templates = assertThrows(CpApiException.class, () ->
            configService.putLayer("workspace-default", "api-request-templates",
                Map.of("connectionDefaultTemplates", "{}"), "admin", null, null));
        assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", templates.getCode());

        // one of the four behavior domains is writable and resolves for any consumer.
        configService.putLayer("workspace-default", "job-policy",
            Map.of("defaultTimeoutSecs", "60"), "admin", null, null);
        assertEquals("60", configService.resolve("job-policy", "defaultTimeoutSecs", userA, wsA));
    }

    @Test
    void workspaceDefaultWritableSet_isTheFourBehaviorDomains_andWorkspaceLayerHoldsFive() {
        // T2.4 (D-1122 49A): the model 4 domains left BOTH workspace-scoped layers.
        // workspace-default = the four behavior domains (WORKSPACE_WRITABLE ∩ UI_DOMAINS).
        for (String domain : java.util.List.of("agent-runtime", "approval-policy", "agent-templates", "job-policy")) {
            assertTrue(ConfigService.isLayerWritable("workspace-default", domain), domain);
        }
        for (String domain : java.util.List.of("llm-provider", "context-policy", "embedding", "rag")) {
            assertFalse(ConfigService.isLayerWritable("workspace-default", domain), domain);
        }
        assertFalse(ConfigService.isLayerWritable("workspace-default", "context-templates"));
        assertFalse(ConfigService.isLayerWritable("workspace-default", "api-request-templates"));
        assertFalse(ConfigService.isLayerWritable("workspace-default", "pricing"));

        // The per-workspace layer holds the four behavior domains plus the service-only
        // context-templates; the model 4 domains are gone here too.
        assertTrue(ConfigService.isLayerWritable("workspace", "context-templates"));
        assertTrue(ConfigService.isLayerWritable("workspace", "api-request-templates"));
        for (String domain : java.util.List.of("agent-runtime", "approval-policy", "agent-templates", "job-policy")) {
            assertTrue(ConfigService.isLayerWritable("workspace", domain), domain);
        }
        for (String domain : java.util.List.of("llm-provider", "context-policy", "embedding", "rag")) {
            assertFalse(ConfigService.isLayerWritable("workspace", domain), domain);
        }
    }

    @Test
    void explicitOnlyEmbedding_wholeUnitWriteAndClear() {
        // T2.4: embedding left the workspace layers; the whole-unit write/clear mechanic is
        // pinned on the user layer, where embedding stays writable.
        String profile = "{\"providerId\":\"dashscope\",\"connectionKey\":\"emb\","
            + "\"model\":\"" + EmbeddingProfileService.FIXED_MODEL + "\"}";
        configService.putLayer("user", "embedding",
            Map.of("profile", profile), "admin", userA, null);
        assertEquals(profile, configService.layerEntries("user", "embedding", userA, null)
            .get("profile"));

        // partial unit fails closed (schema/unit validation rejects it; the
        // controller maps this family to 400 INVALID_REQUEST).
        assertThrows(IllegalArgumentException.class, () ->
            configService.putLayer("user", "embedding",
                Map.of("profile", "{\"providerId\":\"dashscope\"}"), "admin", userA, null));

        // an empty body clears the whole layer row so the layer inherits again
        // (same whole-unit clear semantics as every other layer).
        configService.putLayer("user", "embedding",
            Map.of(), "admin", userA, null);
        assertNull(configService.layerEntries("user", "embedding", userA, null)
            .get("profile"));
    }

    @Test
    void llmAndEmbeddingChains_agreeOnTheSameFixture() {
        String embeddingProfile = "{\"providerId\":\"p\",\"connectionKey\":\"k\","
            + "\"model\":\"" + EmbeddingProfileService.FIXED_MODEL + "\"}";
        // Same fixture: only a workspace-default profile in each chain.
        repo.save(row("workspace-default", "llm-provider", "profile",
            "{\"providerId\":\"p\",\"connectionKey\":\"k\",\"model\":\"m\"}", null));
        repo.save(row("workspace-default", "embedding", "profile", embeddingProfile, null));

        String llmScope = configService.effectiveLlmProfile(userA, wsA).profileScope();
        String embeddingScope = embeddingProfiles.effectiveProfile(userA, wsA).profileScope();
        assertEquals("workspace-default", llmScope);
        assertEquals(llmScope, embeddingScope);

        // D-931: the shared default outranks the user layer in both chains.
        repo.save(row("user", "llm-provider", "profile",
            "{\"providerId\":\"p\",\"connectionKey\":\"k\",\"model\":\"m\"}", userA));
        repo.save(row("user", "embedding", "profile", embeddingProfile, userA));
        assertEquals("workspace-default", configService.effectiveLlmProfile(userA, wsA).profileScope());
        assertEquals("workspace-default", embeddingProfiles.effectiveProfile(userA, wsA).profileScope());

        // Clearing the shared default lets the user layer supply both chains.
        repo.findByLayerAndDomainAndConfigKey("workspace-default", "llm-provider", "profile")
            .ifPresent(repo::delete);
        repo.findByLayerAndDomainAndConfigKey("workspace-default", "embedding", "profile")
            .ifPresent(repo::delete);
        assertEquals("user", configService.effectiveLlmProfile(userA, wsA).profileScope());
        assertEquals("user", embeddingProfiles.effectiveProfile(userA, wsA).profileScope());
    }
}
