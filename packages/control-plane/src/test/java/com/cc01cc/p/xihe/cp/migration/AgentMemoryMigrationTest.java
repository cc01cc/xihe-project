package com.cc01cc.p.xihe.cp.migration;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0629 M1 (V99) + M1-5 (V106): the {@code agent_memories} table — the DDL is the contract, so the
 * constraints are asserted here against a real PostgreSQL rather than trusted from review.
 *
 * <p>Covered: isolation columns, the dedupe uniqueness over {@code (principal, workspace,
 * content_sha256)} (live rows only), the two passive CHECKs ({@code active ⇔ non-passive},
 * {@code candidate ⇔ passive}), the pin invariants ({@code ui|cli} only, {@code pinned ⇒ active},
 * {@code pinned ⇔ pinned_by}), the content/hash bounds, and the two indexes that back dedupe +
 * injection order.</p>
 *
 * <p>V106 (user ruling 2026-11-03) removed the {@code profile}/{@code fact} classification and cleared
 * the table destructively, so this class also pins the <b>absence</b> of the column and the new key
 * shape: the same content written through two different channels is one assertion now.</p>
 */
@Testcontainers
class AgentMemoryMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_v99")
            .withUsername("test")
            .withPassword("test");

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_ID = UUID.randomUUID();
    private static final UUID PRINCIPAL_ID = UUID.randomUUID();
    private static final String HASH_A = "a".repeat(64);
    private static final String HASH_B = "b".repeat(64);

    private static Connection connection;

    /** Every test starts from an empty table: they all reuse the same fixture scope and hashes. */
    @org.junit.jupiter.api.BeforeEach
    void clearMemories() throws SQLException {
        execute("DELETE FROM agent_memories");
    }

    @BeforeAll
    static void migrateAndSeedFixtures() throws SQLException {
        String url = postgres.getJdbcUrl();
        Flyway.configure().dataSource(url, postgres.getUsername(), postgres.getPassword()).load().migrate();
        connection = DriverManager.getConnection(url, postgres.getUsername(), postgres.getPassword());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + USER_ID
                + "', 'plan0629-memory@test.local', 'x', 'plan0629memory')");
        execute("INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_ID + "', 'v99-memory-ws')");
        execute("INSERT INTO agent_principals (id, name, created_by_user_id) VALUES ('" + PRINCIPAL_ID
                + "', 'v99 memory principal', '" + USER_ID + "')");
    }

    @Test
    void tableHasTheFrozenColumnsAndIndexes() throws SQLException {
        List<String> columns = queryStrings("SELECT column_name FROM information_schema.columns "
                + "WHERE table_name = 'agent_memories' ORDER BY column_name");
        assertTrue(columns.containsAll(List.of("id", "principal_id", "workspace_id", "content",
                "content_sha256", "origin", "source_ref", "status", "pinned", "pinned_by",
                "created_at", "updated_at", "deleted_at")), columns.toString());
        // PLAN-0629 M1-5 / V106: the classification column must be genuinely gone, not just unused.
        assertFalse(columns.contains("type"), "V106 drops agent_memories.type: " + columns);

        assertEquals(1, scalarInt("SELECT count(*) FROM pg_indexes WHERE tablename = 'agent_memories' "
                + "AND indexname = 'uq_agent_memories_dedupe'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM pg_indexes WHERE tablename = 'agent_memories' "
                + "AND indexname = 'ix_agent_memories_active_injection'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM pg_indexes WHERE tablename = 'agent_memories' "
                + "AND indexname = 'uq_agent_memories_dedupe' "
                + "AND indexdef LIKE '%(principal_id, workspace_id, content_sha256)%' "
                + "AND indexdef NOT LIKE '%type%'"),
                "the dedupe key must not mention the removed column");
    }

    @Test
    void theMigrationClearedHistoryInsteadOfBackFilling() throws SQLException {
        // The ruling was "clear it": V106 runs DELETE FROM agent_memories, so a freshly migrated
        // database has no rows at all — the honest statement, not "we migrated the classification".
        assertEquals(0, scalarInt("SELECT count(*) FROM agent_memories"));
        // And the table is writable again immediately.
        insertMemory(HASH_A, "ui", "user-1", "active", false, null);
        assertEquals(1, scalarInt("SELECT count(*) FROM agent_memories"));
    }

    @Test
    void dedupeKeyIgnoresTheChannelAndRejectsASecondLiveRowWithTheSameContentHash() throws SQLException {
        // PLAN-0629 M1-5: with the type column gone, the same sentence from two different channels is
        // the same assertion — origin is provenance, not part of the identity.
        insertMemory(HASH_A, "tool", "run-1", "active", false, null);
        assertThrows(SQLException.class,
                () -> insertMemory(HASH_A, "ui", "user-2", "active", false, null),
                "the same (principal, workspace, content_sha256) must collide whatever the origin");

        // Soft delete removes the row from the partial unique key: the same assertion can be written again.
        execute("UPDATE agent_memories SET deleted_at = now() WHERE content_sha256 = '" + HASH_A + "'");
        insertMemory(HASH_A, "cli", "cmd-3", "active", false, null);
        assertEquals(2, scalarInt("SELECT count(*) FROM agent_memories WHERE content_sha256 = '" + HASH_A + "'"));
    }

    @Test
    void passiveOriginsCanOnlyBeCandidatesAndViceVersa() throws SQLException {
        // active + passive origin
        assertThrows(SQLException.class,
                () -> insertMemory(HASH_B, "passive.summary", "run-x", "active", false, null));
        // candidate + active-channel origin
        assertThrows(SQLException.class,
                () -> insertMemory(HASH_B, "tool", "run-x", "candidate", false, null));
        // candidate + passive origin is the reserved M2 shape and must be accepted
        insertMemory(HASH_B, "passive.judge", "run-x", "candidate", false, null);
        assertEquals(1, scalarInt("SELECT count(*) FROM agent_memories WHERE status = 'candidate' "
                + "AND origin = 'passive.judge'"));
    }

    @Test
    void pinInvariantsAreMechanical() throws SQLException {
        UUID id = insertMemory(HASH_A, "ui", "user-1", "active", false, null);
        // pinned without pinned_by
        assertThrows(SQLException.class, () -> execute("UPDATE agent_memories SET pinned = true WHERE id = '"
                + id + "'"));
        // pinned_by from the agent tool channel
        assertThrows(SQLException.class, () -> execute("UPDATE agent_memories SET pinned = true, "
                + "pinned_by = 'tool' WHERE id = '" + id + "'"));
        // the ui channel may pin an active row
        execute("UPDATE agent_memories SET pinned = true, pinned_by = 'ui' WHERE id = '" + id + "'");
        assertEquals(1, scalarInt("SELECT count(*) FROM agent_memories WHERE pinned AND pinned_by = 'ui'"));
        // and a candidate (passive) row may never be pinned
        UUID candidate = insertMemory(HASH_B, "passive.summary", "run-y", "candidate", false, null);
        assertThrows(SQLException.class, () -> execute("UPDATE agent_memories SET pinned = true, "
                + "pinned_by = 'ui' WHERE id = '" + candidate + "'"));
    }

    @Test
    void contentAndHashBoundsAreEnforced() throws SQLException {
        UUID id = insertMemory(HASH_A, "cli", "cmd-digest", "active", false, null);
        String tooLong = "x".repeat(8001);
        assertThrows(SQLException.class, () -> execute("UPDATE agent_memories SET content = '"
                + tooLong + "' WHERE id = '" + id + "'"), "8001 characters must be rejected");
        execute("UPDATE agent_memories SET content = '" + "x".repeat(8000) + "' WHERE id = '" + id + "'");
        assertEquals(8000, scalarInt("SELECT length(content) FROM agent_memories WHERE id = '" + id + "'"));

        assertThrows(SQLException.class, () -> execute("UPDATE agent_memories SET content_sha256 = 'not-a-hash' "
                + "WHERE id = '" + id + "'"), "the hash column only accepts 64 lowercase hex characters");
        assertThrows(SQLException.class, () -> execute("UPDATE agent_memories SET content = '   ' "
                + "WHERE id = '" + id + "'"), "blank content must be rejected");
    }

    // ---------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------

    private static UUID insertMemory(String hash, String origin, String sourceRef,
                                     String status, boolean pinned, String pinnedBy) throws SQLException {
        UUID id = UUID.randomUUID();
        execute("INSERT INTO agent_memories (id, principal_id, workspace_id, content, content_sha256,"
                + " origin, source_ref, status, pinned, pinned_by) VALUES ('" + id + "', '" + PRINCIPAL_ID
                + "', '" + WORKSPACE_ID + "', 'assertion " + id + "', '" + hash + "', '"
                + origin + "', '" + sourceRef + "', '" + status + "', " + pinned + ", "
                + (pinnedBy == null ? "NULL" : "'" + pinnedBy + "'") + ")");
        return id;
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static int scalarInt(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             var result = statement.executeQuery(sql)) {
            result.next();
            return result.getInt(1);
        }
    }

    private static List<String> queryStrings(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             var result = statement.executeQuery(sql)) {
            List<String> values = new java.util.ArrayList<>();
            while (result.next()) {
                values.add(result.getString(1));
            }
            return values;
        }
    }
}
