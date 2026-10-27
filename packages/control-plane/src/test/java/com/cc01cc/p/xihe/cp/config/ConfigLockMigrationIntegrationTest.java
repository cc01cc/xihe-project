package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0556 PostgreSQL schema gate: V80 must create config_locks and the
 * runtime path (value write + lock row + advisory lock) must work on real PG,
 * which the H2 create-drop suite cannot prove.
 */
class ConfigLockMigrationIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ConfigLockAdminService adminService;

    @Autowired
    private ConfigService configService;

    @Test
    void migrationCreatesConfigLocksWithUniqueConstraint() {
        Integer tables = jdbc.queryForObject(
                "SELECT count(*) FROM information_schema.tables WHERE table_name = 'config_locks'",
                Integer.class);
        assertEquals(1, tables);

        Integer unique = jdbc.queryForObject("""
                SELECT count(*) FROM pg_indexes
                WHERE tablename = 'config_locks' AND indexdef LIKE '%UNIQUE%'
                """, Integer.class);
        assertTrue(unique != null && unique >= 1);
    }

    @Test
    void lockPinsValueAndUnlockKeepsIt() {
        adminService.lock("rag", "chunkSize", null, "集成测试锁定", "4096", 0L, "admin");

        assertEquals("4096", configService.resolve("rag", "chunkSize", null, null));
        Long locks = jdbc.queryForObject(
                "SELECT count(*) FROM config_locks WHERE domain = 'rag' AND config_key = 'chunkSize'",
                Long.class);
        assertEquals(1L, locks);

        long revision = adminService.catalog("rag").keys().stream()
                .filter(key -> "chunkSize".equals(key.key()))
                .findFirst().orElseThrow().revision();
        adminService.unlock("rag", "chunkSize", revision, false, "admin");

        assertEquals("4096", configService.resolve("rag", "chunkSize", null, null));
        Long after = jdbc.queryForObject(
                "SELECT count(*) FROM config_locks WHERE domain = 'rag' AND config_key = 'chunkSize'",
                Long.class);
        assertEquals(0L, after);
    }
}
