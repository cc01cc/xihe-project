package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;

import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0679 M2a: the B-1 provider-request-fingerprint switch lands in the existing
 * {@code agent-runtime} domain as {@code providerRequestFingerprintEnabled}. This test
 * pins the four contract surfaces: code default true, schema acceptance, schema
 * rejection of non-boolean values, and the user-layer writable / workspace-writable path.
 */
@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ProviderRequestFingerprintConfigTest {

    @Autowired
    private ConfigService configService;

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

    @Test
    void codeDefault_isTrueAndListedInEffectiveView() {
        assertEquals("true", configService.resolve("agent-runtime",
            "providerRequestFingerprintEnabled", null, null));
        Map<String, String> effective = configService.resolveDomain("agent-runtime", null, null);
        assertEquals("true", effective.get("providerRequestFingerprintEnabled"));
    }

    @Test
    void schema_acceptsBooleanStrings() {
        configService.putLayer("user", "agent-runtime",
            Map.of("providerRequestFingerprintEnabled", "false"), "user", userA, null);
        assertEquals("false", configService.resolve("agent-runtime",
            "providerRequestFingerprintEnabled", userA, null));
    }

    @Test
    void schema_rejectsNonBooleanValues() {
        IllegalArgumentException thrown = assertThrows(IllegalArgumentException.class,
            () -> configService.putLayer("user", "agent-runtime",
                Map.of("providerRequestFingerprintEnabled", "yes"), "user", userA, null));
        assertTrue(thrown.getMessage().contains("Schema validation failed"));
    }

    @Test
    void meta_userLayerListsKeyWithCodeSource() {
        var meta = configService.meta("user", "agent-runtime", userA, null);
        var key = meta.stream()
            .filter(item -> "providerRequestFingerprintEnabled".equals(item.key()))
            .findFirst().orElseThrow();
        assertTrue(key.writable());
        assertTrue(key.defaultPresent());
        assertEquals("code", key.source());
    }

    @Test
    void workspaceLayerIsWritable() {
        configService.putLayer("workspace", "agent-runtime",
            Map.of("providerRequestFingerprintEnabled", "false"), "user", null, wsA);
        assertEquals("false", configService.resolve("agent-runtime",
            "providerRequestFingerprintEnabled", userA, wsA));
    }
}
