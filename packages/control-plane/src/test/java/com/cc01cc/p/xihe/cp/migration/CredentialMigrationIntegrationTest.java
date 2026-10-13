package com.cc01cc.p.xihe.cp.migration;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0495 T1.1（contract: PLAN-0494 design #4/#5/#6/#8 + PLAN-0495 §方案 1/5）：
 * V62 {@code credentials} / {@code credential_events} 在隔离 PG 全量迁移成功；
 * 关键 CHECK 正反例（owner_type / kind / delivery_tier / status / revision /
 * event_type）、三条索引与 events→credentials FK（ON DELETE CASCADE）断言。
 */
@Testcontainers
class CredentialMigrationIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_credentials")
            .withUsername("test")
            .withPassword("test");

    private static Connection connection;

    @BeforeAll
    static void applyMigrationsOnFreshDatabase() throws SQLException {
        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
    }

    @Test
    void v62_credentials_table_columns_constraints_and_indexes_applied() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '62' AND success = true"),
                "V62 must be recorded as applied");
        assertEquals("uuid", scalarString(
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'credentials' AND column_name = 'owner_id'"));
        assertEquals("NO", scalarString(
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'credentials' AND column_name = 'secret_ciphertext'"));
        assertEquals(5, scalarInt(
                "SELECT count(*) FROM pg_constraint WHERE conname IN ('ck_credentials_owner_type', "
                        + "'ck_credentials_kind', 'ck_credentials_delivery_tier', 'ck_credentials_status', "
                        + "'ck_credentials_revision') AND contype = 'c'"),
                "all credentials CHECK constraints must exist (5 names)");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname = 'idx_credentials_owner_active' "
                        + "AND indexdef LIKE '%deleted_at IS NULL%'"),
                "owner lookup index must be partial on deleted_at IS NULL");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname = 'idx_credentials_key_version'"),
                "key version index must exist");
    }

    @Test
    void v62_credential_events_table_and_cascade_fk_applied() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_constraint WHERE conname = 'ck_credential_events_type' "
                        + "AND contype = 'c'"));
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_constraint conf "
                        + "JOIN pg_attribute src ON src.attrelid = conf.conrelid "
                        + "AND src.attnum = ANY (conf.conkey) "
                        + "WHERE conf.contype = 'f' "
                        + "AND conf.conrelid = 'credential_events'::regclass "
                        + "AND conf.confrelid = 'credentials'::regclass "
                        + "AND src.attname = 'credential_id' "
                        + "AND conf.confdeltype = 'c'"),
                "credential_events.credential_id FK must be ON DELETE CASCADE (confdeltype 'c')");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname = 'idx_credential_events_credential_created'"));
    }

    @Test
    void v64_directGrantPartialUniqueIndexApplied() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname = 'uq_grants_direct_subject' "
                        + "AND indexdef LIKE '%(subject_type, subject_id)%' "
                        + "AND indexdef LIKE '%source%'"),
                "PLAN-0496 round-4: one direct grant row per subject (V64)");
    }

    @Test
    void valid_rows_insert_and_events_cascade_on_credential_delete() throws SQLException {
        UUID credentialId = UUID.randomUUID();
        UUID ownerId = UUID.randomUUID();
        execute("INSERT INTO credentials (id, owner_type, owner_id, label, kind, delivery_tier, "
                + "status, revision, secret_ciphertext, fingerprint, key_version) VALUES ('"
                + credentialId + "'::uuid, 'USER', '" + ownerId + "'::uuid, 'token-a', 'token', "
                + "'lease', 'active', 1, 'v1:aaaa:bbbb', 'fp123', 'v1')");
        assertEquals(1, scalarInt("SELECT count(*) FROM credentials WHERE id = '" + credentialId
                + "'::uuid AND owner_type = 'USER'"));

        UUID eventId = UUID.randomUUID();
        execute("INSERT INTO credential_events (id, credential_id, event_type, actor, owner_type, "
                + "owner_id) VALUES ('" + eventId + "'::uuid, '" + credentialId + "'::uuid, "
                + "'created', '" + ownerId + "', 'USER', '" + ownerId + "'::uuid)");
        execute("DELETE FROM credentials WHERE id = '" + credentialId + "'::uuid");
        assertEquals(0, scalarInt("SELECT count(*) FROM credential_events WHERE id = '" + eventId
                + "'::uuid"), "deleting the credential must cascade to its events");
    }

    @Test
    void broker_tier_value_is_rejected() {
        assertThrows(SQLException.class, () -> insertCredential("broker", "token", "active", 1),
                "ck_credentials_delivery_tier must reject the reserved broker tier (0495 #9)");
    }

    @Test
    void system_owner_type_is_rejected() {
        assertThrows(SQLException.class, () -> execute(
                "INSERT INTO credentials (id, owner_type, owner_id, label, kind, delivery_tier, "
                        + "status, secret_ciphertext, fingerprint, key_version) VALUES ('"
                        + UUID.randomUUID() + "'::uuid, 'SYSTEM', '" + UUID.randomUUID()
                        + "'::uuid, 'bad-owner', 'token', 'lease', 'active', 'v1:a:b', 'fp', 'v1')"),
                "ck_credentials_owner_type must reject SYSTEM (0494 #5 two-level model)");
    }

    @Test
    void unknown_kind_value_is_rejected() {
        assertThrows(SQLException.class, () -> insertCredential("lease", "oauth_bundle", "active", 1),
                "ck_credentials_kind must reject non-v1 forms (0494 #6)");
    }

    @Test
    void unknown_status_value_is_rejected() {
        assertThrows(SQLException.class, () -> insertCredential("lease", "token", "pending", 1),
                "ck_credentials_status must reject unknown status values (0495 #8)");
    }

    @Test
    void non_positive_revision_is_rejected() {
        assertThrows(SQLException.class, () -> insertCredential("lease", "token", "active", 0),
                "ck_credentials_revision must keep the revision monotonic (0495 #7)");
    }

    @Test
    void unknown_event_type_is_rejected() throws SQLException {
        UUID credentialId = UUID.randomUUID();
        UUID ownerId = UUID.randomUUID();
        execute("INSERT INTO credentials (id, owner_type, owner_id, label, kind, delivery_tier, "
                + "status, secret_ciphertext, fingerprint, key_version) VALUES ('" + credentialId
                + "'::uuid, 'USER', '" + ownerId + "'::uuid, 'event-owner', 'token', 'lease', "
                + "'active', 'v1:a:b', 'fp', 'v1')");
        assertThrows(SQLException.class, () -> execute(
                "INSERT INTO credential_events (id, credential_id, event_type, actor, owner_type, "
                        + "owner_id) VALUES ('" + UUID.randomUUID() + "'::uuid, '" + credentialId
                        + "'::uuid, 'teleported', 'system', 'USER', '" + ownerId + "'::uuid)"),
                "ck_credential_events_type must reject unknown event types");
    }

    private static void insertCredential(String tier, String kind, String status, int revision)
            throws SQLException {
        execute("INSERT INTO credentials (id, owner_type, owner_id, label, kind, delivery_tier, "
                + "status, revision, secret_ciphertext, fingerprint, key_version) VALUES ('"
                + UUID.randomUUID() + "'::uuid, 'USER', '" + UUID.randomUUID() + "'::uuid, 'label', '"
                + kind + "', '" + tier + "', '" + status + "', " + revision
                + ", 'v1:a:b', 'fp', 'v1')");
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }

    private static int scalarInt(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            assertTrue(rs.next());
            return rs.getInt(1);
        }
    }

    private static String scalarString(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            assertTrue(rs.next());
            return rs.getString(1);
        }
    }
}
