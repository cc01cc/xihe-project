package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigLockRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0556: lock resolution (env &gt; lock &gt; workspace &gt; user &gt; instance &gt; code),
 * write guard, catalog derivation, unlock semantics and audit.
 */
@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ConfigLockServiceTest {

    @Autowired
    private ConfigService configService;

    @Autowired
    private ConfigLockService lockService;

    @Autowired
    private ConfigLockAdminService adminService;

    @Autowired
    private ConfigLockRepository lockRepo;

    @Autowired
    private ConfigJpaRepository configRepo;

    @Autowired
    private AuditLogRepository auditRepo;

    private final UUID userA = UUID.randomUUID();
    private final UUID wsA = UUID.randomUUID();

    @BeforeEach
    void clean() {
        lockRepo.deleteAll();
        auditRepo.deleteAll(auditRepo.findAll().stream()
                .filter(row -> "config_lock".equals(row.getResourceType()))
                .toList());
        for (String domain : List.of("rag", "agent-runtime", "job-policy")) {
            List<ConfigEntity> rows = configRepo.findByLayerAndDomain("instance", domain);
            configRepo.deleteAll(rows);
        }
        for (UUID ws : List.of(wsA)) {
            configRepo.deleteAll(configRepo.findByWorkspaceIdAndDomain(ws, "rag"));
        }
        configRepo.deleteAll(configRepo.findByUserIdAndDomain(userA, "rag"));
    }

    @Test
    void lockPinsInstanceValueAboveWorkspaceAndUser() {
        configService.putLayer("workspace", "rag", Map.of("chunkSize", "8000"), "test", null, wsA);
        configService.putLayer("user", "rag", Map.of("chunkSize", "7000"), "test", userA, null);

        adminService.lock("rag", "chunkSize", null, "统一分块，避免检索质量漂移", "4096", 0L, "admin");

        assertEquals("4096", configService.resolve("rag", "chunkSize", userA, wsA));
        assertEquals("4096", configService.effective("rag", userA, wsA).entries().get("chunkSize"));
        assertFalse(configService.overrides("workspace", List.of("rag"), userA, wsA)
                .getOrDefault("rag", Map.of()).containsKey("chunkSize"));
        assertFalse(configService.overrides("user", List.of("rag"), userA, wsA)
                .getOrDefault("rag", Map.of()).containsKey("chunkSize"));
    }

    @Test
    void metaMarksAdminLockedAndNotWritable() {
        adminService.lock("rag", "topK", null, "固定召回数", "6", 0L, "admin");

        ConfigService.ConfigKeyMeta meta = configService.meta("workspace", "rag", userA, wsA).stream()
                .filter(m -> "topK".equals(m.key())).findFirst().orElseThrow();
        assertTrue(meta.adminLocked());
        assertEquals("固定召回数", meta.lockReason());
        assertEquals("ADMIN_LOCKED", meta.reason());
        assertFalse(meta.writable());
        assertEquals("instance", meta.source());

        ConfigService.ConfigKeyMeta unlocked = configService.meta("workspace", "rag", userA, wsA).stream()
                .filter(m -> "minScore".equals(m.key())).findFirst().orElseThrow();
        assertFalse(unlocked.adminLocked());
        assertNull(unlocked.lockReason());
    }

    @Test
    void everyLayerWriteIsRejectedForLockedKey() {
        adminService.lock("rag", "chunkSize", null, "锁定", "4096", 0L, "admin");

        CpApiException userWrite = assertThrows(CpApiException.class,
                () -> configService.putLayer("user", "rag", Map.of("chunkSize", "1"), "test", userA, null));
        assertEquals("CONFIG_KEY_LOCKED", userWrite.getCode());
        assertEquals(org.springframework.http.HttpStatus.CONFLICT, userWrite.getStatus());

        CpApiException instanceWrite = assertThrows(CpApiException.class,
                () -> configService.putLayer("instance", "rag", Map.of("chunkSize", "2"), "test", null, null));
        assertEquals("CONFIG_KEY_LOCKED", instanceWrite.getCode());

        CpApiException delete = assertThrows(CpApiException.class,
                () -> configService.deleteKey("instance", "rag", "chunkSize", "test", null, null));
        assertEquals("CONFIG_KEY_LOCKED", delete.getCode());
    }

    @Test
    void catalogReportsLockableAndReasons() {
        Map<String, ConfigLockAdminService.KeyView> rag = byKey(adminService.catalog("rag"));
        assertTrue(rag.get("chunkSize").lockable());
        assertNull(rag.get("chunkSize").notLockableReason());

        Map<String, ConfigLockAdminService.KeyView> runtime = byKey(adminService.catalog("agent-runtime"));
        assertEquals("INSTANCE_ONLY", runtime.get("instructions").notLockableReason());

        Map<String, ConfigLockAdminService.KeyView> logging = byKey(adminService.catalog("logging"));
        assertEquals("NOT_OVERRIDABLE", logging.get("logLevel").notLockableReason());

        Map<String, ConfigLockAdminService.KeyView> llm = byKey(adminService.catalog("llm-provider"));
        assertEquals("WHOLE_UNIT", llm.get("profile").notLockableReason());

        Map<String, ConfigLockAdminService.KeyView> job = byKey(adminService.catalog("job-policy"));
        assertEquals("ENV_LOCKED", job.get("defaultTimeoutSecs").notLockableReason());
    }

    @Test
    void nonLockableAndInvalidRequestsAreRejected() {
        CpApiException envKey = assertThrows(CpApiException.class,
                () -> adminService.lock("job-policy", "defaultTimeoutSecs", null, "x", "10", 0L, "admin"));
        assertEquals("NOT_LOCKABLE", envKey.getCode());

        CpApiException noValue = assertThrows(CpApiException.class,
                () -> adminService.lock("rag", "chunkOverlap", null, "x", "", 0L, "admin"));
        assertEquals("VALUE_REQUIRED", noValue.getCode());

        CpApiException noReason = assertThrows(CpApiException.class,
                () -> adminService.lock("rag", "chunkOverlap", null, "   ", "10", 0L, "admin"));
        assertEquals("INVALID_REQUEST", noReason.getCode());

        CpApiException unsupported = assertThrows(CpApiException.class,
                () -> adminService.lock("rag", "chunkOverlap", "write_guard", "x", "10", 0L, "admin"));
        assertEquals("UNSUPPORTED_MODE", unsupported.getCode());

        CpApiException badDomain = assertThrows(CpApiException.class,
                () -> adminService.catalog("pricing"));
        assertEquals("INVALID_DOMAIN", badDomain.getCode());
    }

    @Test
    void staleRevisionConflicts() {
        ConfigLockAdminService.KeyView first =
                adminService.lock("rag", "chunkSize", null, "第一次", "4096", 0L, "admin");
        assertTrue(first.revision() > 0);

        CpApiException conflict = assertThrows(CpApiException.class,
                () -> adminService.lock("rag", "chunkSize", null, "第二次", "2048", 0L, "admin"));
        assertEquals("CONFIG_LOCK_CONFLICT", conflict.getCode());

        ConfigLockAdminService.KeyView updated =
                adminService.lock("rag", "chunkSize", null, "第二次", "2048", first.revision(), "admin");
        assertEquals("第二次", updated.reason());
        assertEquals("2048", configService.resolve("rag", "chunkSize", null, null));
    }

    @Test
    void unlockKeepsValueByDefaultAndCanClear() {
        configService.putLayer("workspace", "rag", Map.of("chunkSize", "8000"), "test", null, wsA);
        ConfigLockAdminService.KeyView lock =
                adminService.lock("rag", "chunkSize", null, "临时", "4096", 0L, "admin");

        adminService.unlock("rag", "chunkSize", lock.revision(), false, "admin");
        assertNotNull(configService.instanceValue("rag", "chunkSize"));
        assertEquals("8000", configService.resolve("rag", "chunkSize", userA, wsA));

        ConfigLockAdminService.KeyView relock =
                adminService.lock("rag", "chunkSize", null, "临时", "4096", 0L, "admin");
        adminService.unlock("rag", "chunkSize", relock.revision(), true, "admin");
        assertNull(configService.instanceValue("rag", "chunkSize"));
        assertEquals("8000", configService.resolve("rag", "chunkSize", userA, wsA));

        // idempotent unlock
        adminService.unlock("rag", "chunkSize", 0L, false, "admin");
        assertFalse(lockService.find("rag", "chunkSize").isPresent());
    }

    @Test
    void importSkipsLockedKeys() {
        adminService.lock("rag", "chunkSize", null, "锁定", "4096", 0L, "admin");

        ConfigService.ImportReport report = configService.importJsonc(
                "{\"rag\":{\"chunkSize\":\"2048\",\"topK\":\"9\"}}", "instance", null, null, "test");

        assertEquals(1, report.imported());
        assertEquals(1, report.skipped());
        assertTrue(report.warnings().stream().anyMatch(w -> w.contains("admin-locked")));
        assertEquals("4096", configService.instanceValue("rag", "chunkSize"));
        assertEquals("9", configService.instanceValue("rag", "topK"));
    }

    @Test
    void lockLifecycleIsAuditedWithoutValues() {
        ConfigLockAdminService.KeyView lock =
                adminService.lock("rag", "chunkSize", null, "统一分块", "4096", 0L, "admin-1");
        adminService.unlock("rag", "chunkSize", lock.revision(), false, "admin-1");

        List<AuditLog> rows = auditRepo.findAll().stream()
                .filter(row -> "config_lock".equals(row.getResourceType()))
                .toList();
        assertEquals(2, rows.size());
        assertTrue(rows.stream().anyMatch(row -> "config_lock_set".equals(row.getAction())));
        assertTrue(rows.stream().anyMatch(row -> "config_lock_cleared".equals(row.getAction())));
        for (AuditLog row : rows) {
            assertTrue(row.getDetails().contains("domain=rag"));
            assertTrue(row.getDetails().contains("key=chunkSize"));
            assertTrue(row.getDetails().contains("actor=admin-1"));
            assertFalse(row.getDetails().contains("4096"));
            // audit_logs.user_id is a UUID column; a synthetic actor stays in detail only.
            assertNull(row.getUserId());
        }
    }

    private static Map<String, ConfigLockAdminService.KeyView> byKey(
            ConfigLockAdminService.CatalogView catalog) {
        return catalog.keys().stream()
                .collect(java.util.stream.Collectors.toMap(
                        ConfigLockAdminService.KeyView::key, view -> view));
    }
}
