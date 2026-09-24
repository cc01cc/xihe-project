package com.cc01cc.p.xihe.cp.auth;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
import org.flywaydb.core.api.MigrationVersion;
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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Testcontainers
class AgentPrincipalMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_agent_principal")
            .withUsername("test")
            .withPassword("test");

    @Test
    void v42BackfillsMultipleChatRunsPerRootAndRemovesRunlessDefault() throws SQLException {
        Fixture fixture = createV41Fixture();
        String rootSessionId = insertSession(fixture, "legacy-agent", false);
        String untitledSessionId = insertSession(fixture, null, false);
        String runlessSessionId = insertSession(fixture, "legacy-empty", false);
        String runId = insertRun(fixture, rootSessionId, "user_submission");
        insertRun(fixture, rootSessionId, "user_submission");
        insertRun(fixture, untitledSessionId, "user_submission");

        migrateToVersion(fixture.jdbcUrl(), "41");
        String rootGrantIdBefore = scalarString(fixture.jdbcUrl(),
                "SELECT id::text FROM grants WHERE subject_type = 'agent' AND subject_id = '"
                        + rootSessionId + "'::uuid AND source = 'default'");
        String rootGrantPermissionsBefore = scalarString(fixture.jdbcUrl(),
                "SELECT permissions::text FROM grants WHERE id = '" + rootGrantIdBefore + "'::uuid");
        String rootGrantCreatedAtBefore = scalarString(fixture.jdbcUrl(),
                "SELECT created_at::text FROM grants WHERE id = '" + rootGrantIdBefore + "'::uuid");
        String userGrantIdBefore = scalarString(fixture.jdbcUrl(),
                "SELECT id::text FROM grants WHERE subject_type = 'user' AND subject_id = '"
                        + fixture.userId() + "'::uuid AND source = 'default'");
        String userGrantPermissionsBefore = scalarString(fixture.jdbcUrl(),
                "SELECT permissions::text FROM grants WHERE id = '" + userGrantIdBefore + "'::uuid");
        int grantAuditCountBefore = scalarInt(fixture.jdbcUrl(),
                "SELECT count(*) FROM audit_logs WHERE action = 'authorization_default_grant_backfilled'");

        migrateToCurrent(fixture.jdbcUrl());
        migrateToCurrent(fixture.jdbcUrl());

        try (Connection connection = connect(fixture.jdbcUrl())) {
            String principalId = scalarString(connection,
                    "SELECT agent_principal_id::text FROM sessions WHERE id = '" + rootSessionId + "'::uuid");
            assertTrue(principalId != null && !principalId.isBlank());
            assertEquals("legacy-agent", scalarString(connection,
                    "SELECT name FROM agent_principals WHERE id = '" + principalId + "'::uuid"));
            assertEquals(fixture.userId(), scalarString(connection,
                    "SELECT created_by_user_id::text FROM agent_principals WHERE id = '" + principalId + "'::uuid"));
            assertNull(scalarString(connection,
                    "SELECT template_id FROM agent_principals WHERE id = '" + principalId + "'::uuid"));
            assertNull(scalarString(connection,
                    "SELECT template_snapshot::text FROM agent_principals WHERE id = '" + principalId + "'::uuid"));
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM workspace_agents WHERE principal_id = '" + principalId + "'::uuid "
                            + "AND workspace_id = '" + fixture.workspaceId() + "'::uuid"));

            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM chat_runs WHERE id = '" + runId + "'::uuid"));
            assertEquals(2, scalarInt(connection,
                    "SELECT count(*) FROM chat_runs WHERE session_id = '" + rootSessionId + "'::uuid"),
                    "multiple ChatRuns still share one Session grant and principal");
            String grantId = scalarString(connection,
                    "SELECT id::text FROM grants WHERE subject_type = 'agent_principal' "
                            + "AND subject_id = '" + principalId + "'::uuid AND source = 'default'");
            assertEquals(rootGrantIdBefore, grantId, "the old root default grant row must be re-subjected in place");
            String grantPermissions = scalarString(connection,
                    "SELECT permissions::text FROM grants WHERE id = '" + grantId + "'::uuid");
            assertEquals(rootGrantPermissionsBefore, grantPermissions);
            assertEquals(rootGrantCreatedAtBefore, scalarString(connection,
                    "SELECT created_at::text FROM grants WHERE id = '" + grantId + "'::uuid"));
            assertEquals("read", scalarString(connection,
                    "SELECT read_state FROM grants WHERE id = '" + grantId + "'::uuid"));
            assertEquals(grantPermissions, scalarString(connection,
                    "SELECT agent_permissions_snapshot::text FROM sessions WHERE id = '" + rootSessionId + "'::uuid"));
            assertEquals(grantPermissions, scalarString(connection,
                    "SELECT permissions_snapshot::text FROM workspace_agents WHERE principal_id = '"
                            + principalId + "'::uuid AND workspace_id = '" + fixture.workspaceId() + "'::uuid"),
                    "legacy Workspace cap must preserve the root Agent effective grants");
            assertEquals(fixture.userId(), scalarString(connection,
                    "SELECT user_id::text FROM sessions WHERE id = '" + rootSessionId + "'::uuid"));
            assertEquals(fixture.workspaceId(), scalarString(connection,
                    "SELECT workspace_id::text FROM sessions WHERE id = '" + rootSessionId + "'::uuid"));
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM grants WHERE subject_type = 'agent' AND subject_id = '"
                            + rootSessionId + "'::uuid"));

            String untitledPrincipalId = scalarString(connection,
                    "SELECT agent_principal_id::text FROM sessions WHERE id = '" + untitledSessionId + "'::uuid");
            assertTrue(untitledPrincipalId != null && !untitledPrincipalId.isBlank());
            assertEquals("Agent " + untitledSessionId.substring(0, 8), scalarString(connection,
                    "SELECT name FROM agent_principals WHERE id = '" + untitledPrincipalId + "'::uuid"));
            assertNull(scalarString(connection,
                    "SELECT agent_principal_id::text FROM sessions WHERE id = '" + runlessSessionId + "'::uuid"));
            assertNull(scalarString(connection,
                    "SELECT agent_permissions_snapshot::text FROM sessions WHERE id = '" + runlessSessionId + "'::uuid"));
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM grants WHERE subject_type = 'agent' AND subject_id = '"
                            + runlessSessionId + "'::uuid"));
            assertEquals(userGrantIdBefore, scalarString(connection,
                    "SELECT id::text FROM grants WHERE subject_type = 'user' AND subject_id = '"
                            + fixture.userId() + "'::uuid AND source = 'default'"));
            assertEquals(userGrantPermissionsBefore, scalarString(connection,
                    "SELECT permissions::text FROM grants WHERE id = '" + userGrantIdBefore + "'::uuid"));
            assertEquals(grantAuditCountBefore, scalarInt(connection,
                    "SELECT count(*) FROM audit_logs WHERE action = 'authorization_default_grant_backfilled'"),
                    "pre-existing V41 audit rows must remain unchanged");
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM grants WHERE subject_type = 'user' AND subject_id = '"
                            + fixture.userId() + "'::uuid AND source = 'default'"));
            assertEquals(4, scalarInt(connection,
                    "SELECT count(*) FROM audit_logs WHERE action = 'authorization_default_grant_backfilled'"));
            assertEquals(2, scalarInt(connection,
                    "SELECT count(*) FROM audit_logs a JOIN agent_principals p "
                            + "ON a.resource_id = p.id::text WHERE a.action = 'agent_principal_backfilled' "
                            + "AND a.user_id IS NULL AND a.workspace_id = '" + fixture.workspaceId() + "'::uuid "
                            + "AND a.details::jsonb->>'source' = 'V42'"),
                    "each system-backfilled principal must have one traceable, non-human audit row");
        }
    }

    @Test
    void v42RejectsPreExistingDerivedSessionAndRollsBackDdl() throws SQLException {
        Fixture fixture = createV41Fixture();
        String rootSessionId = insertSession(fixture, "legacy-agent", false);
        String rootRunId = insertRun(fixture, rootSessionId, "user_submission");
        migrateToVersion(fixture.jdbcUrl(), "41");
        String childSessionId = insertSession(fixture, "old-child", true, rootSessionId, rootRunId);

        assertThrows(FlywayException.class, () -> migrateToCurrent(fixture.jdbcUrl()));

        try (Connection connection = connect(fixture.jdbcUrl())) {
            assertNull(scalarString(connection, "SELECT to_regclass('public.agent_principals')::text"),
                    "failed V42 transaction must roll back its DDL");
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM flyway_schema_history WHERE version = '41' AND success"));
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM flyway_schema_history WHERE version = '42' AND success"));
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM sessions WHERE id = '" + childSessionId + "'::uuid"));
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM grants WHERE subject_type = 'agent' AND subject_id = '"
                            + rootSessionId + "'::uuid AND source = 'default'"));
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_backfilled'"));
        }
    }

    @Test
    void v42RejectsUnmappedNonDefaultAgentGrantAndRollsBack() throws SQLException {
        Fixture fixture = createV41Fixture();
        String rootSessionId = insertSession(fixture, "legacy-agent", false);
        insertRun(fixture, rootSessionId, "user_submission");
        migrateToVersion(fixture.jdbcUrl(), "41");
        String grantId = UUID.randomUUID().toString();
        execute(fixture.jdbcUrl(), "INSERT INTO grants (id, subject_type, subject_id, permissions, source, read_state) "
                + "VALUES ('" + grantId + "'::uuid, 'agent', '" + rootSessionId + "'::uuid, "
                + "'[ {\"actionClass\":\"credential\"} ]'::jsonb, 'direct', 'read')");

        assertThrows(FlywayException.class, () -> migrateToCurrent(fixture.jdbcUrl()));

        try (Connection connection = connect(fixture.jdbcUrl())) {
            assertNull(scalarString(connection, "SELECT to_regclass('public.agent_principals')::text"));
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM grants WHERE id = '" + grantId + "'::uuid "
                            + "AND subject_type = 'agent' AND source = 'direct'"),
                    "an unclassified legacy grant must not be deleted or promoted");
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_backfilled'"));
        }
    }

    @Test
    void v42RejectsOrphanAgentGrantAndRollsBack() throws SQLException {
        RootFixture root = createRootV41Fixture();
        String orphanGrantId = UUID.randomUUID().toString();
        execute(root.fixture().jdbcUrl(), "INSERT INTO grants (id, subject_type, subject_id, permissions, source, read_state) "
                + "VALUES ('" + orphanGrantId + "'::uuid, 'agent', '" + UUID.randomUUID()
                + "'::uuid, '[{\"actionClass\":\"read\"}]'::jsonb, 'default', 'read')");

        assertV42FailsAndRollsBack(root.fixture());
    }

    @Test
    void v42RejectsMissingRootDefaultGrantAndRollsBack() throws SQLException {
        RootFixture root = createRootV41Fixture();
        execute(root.fixture().jdbcUrl(), "DELETE FROM grants WHERE subject_type = 'agent' AND subject_id = '"
                + root.sessionId() + "'::uuid AND source = 'default'");

        assertV42FailsAndRollsBack(root.fixture());
    }

    @Test
    void v42RejectsInvalidRootDefaultPermissionAtomAndRollsBack() throws SQLException {
        RootFixture root = createRootV41Fixture();
        execute(root.fixture().jdbcUrl(), "UPDATE grants SET permissions = '[{\"actionClass\":\"unknown\"}]'::jsonb "
                + "WHERE subject_type = 'agent' AND subject_id = '" + root.sessionId() + "'::uuid");

        assertV42FailsAndRollsBack(root.fixture());
    }

    @Test
    void v42RejectsAgentDefaultWiderThanOwnerUserDefaultAndRollsBack() throws SQLException {
        RootFixture root = createRootV41Fixture();
        execute(root.fixture().jdbcUrl(), "UPDATE grants SET permissions = '[{\"actionClass\":\"read\"}]'::jsonb "
                + "WHERE subject_type = 'user' AND subject_id = '" + root.fixture().userId() + "'::uuid "
                + "AND source = 'default'");

        assertV42FailsAndRollsBack(root.fixture());
    }

    @Test
    void v42RejectsMissingOwnerUserDefaultGrantAndRollsBack() throws SQLException {
        RootFixture root = createRootV41Fixture();
        execute(root.fixture().jdbcUrl(), "DELETE FROM grants WHERE subject_type = 'user' AND subject_id = '"
                + root.fixture().userId() + "'::uuid AND source = 'default'");

        assertV42FailsAndRollsBack(root.fixture());
    }

    @Test
    void v42RejectsPermissionAtomWithoutActionClassAndRollsBack() throws SQLException {
        RootFixture root = createRootV41Fixture();
        execute(root.fixture().jdbcUrl(), "UPDATE grants SET permissions = '[{\"resource\":\"workspace/*\"}]'::jsonb "
                + "WHERE subject_type = 'agent' AND subject_id = '" + root.sessionId() + "'::uuid");

        assertV42FailsAndRollsBack(root.fixture());
    }

    @Test
    void v42RejectsWorkspaceOwnerWithoutMembershipAndRollsBack() throws SQLException {
        RootFixture root = createRootV41Fixture();
        execute(root.fixture().jdbcUrl(), "DELETE FROM workspace_users WHERE workspace_id = '"
                + root.fixture().workspaceId() + "'::uuid AND user_id = '" + root.fixture().userId() + "'::uuid");

        assertV42FailsAndRollsBack(root.fixture());
    }

    @Test
    void v42RejectsNonUserSubmissionChatRunOriginAndRollsBack() throws SQLException {
        RootFixture root = createRootV41Fixture();
        execute(root.fixture().jdbcUrl(), "UPDATE chat_runs SET origin = 'spawn' WHERE id = '"
                + root.runId() + "'::uuid");

        assertV42FailsAndRollsBack(root.fixture());
    }

    @Test
    void v42RejectsChatRunTenantMismatchAndRollsBack() throws SQLException {
        RootFixture root = createRootV41Fixture();
        String otherUserId = UUID.randomUUID().toString();
        String otherWorkspaceId = UUID.randomUUID().toString();
        execute(root.fixture().jdbcUrl(), "INSERT INTO users (id, email, password_hash, role) VALUES ('"
                + otherUserId + "'::uuid, 'mismatch-" + otherUserId + "@test.local', 'hash', 'USER')");
        execute(root.fixture().jdbcUrl(), "INSERT INTO workspaces (id, name, owner_id) VALUES ('"
                + otherWorkspaceId + "'::uuid, 'mismatch-workspace', '" + otherUserId + "'::uuid)");
        execute(root.fixture().jdbcUrl(), "UPDATE chat_runs SET user_id = '" + otherUserId
                + "'::uuid, workspace_id = '" + otherWorkspaceId + "'::uuid WHERE id = '"
                + root.runId() + "'::uuid");

        assertV42FailsAndRollsBack(root.fixture());
    }

    @Test
    void v42RejectsUnmatchedContextEventCorrelationAndRollsBack() throws SQLException {
        RootFixture root = createRootV41Fixture();
        String eventId = UUID.randomUUID().toString();
        execute(root.fixture().jdbcUrl(), "INSERT INTO context_events (id, session_id, workspace_id, user_id, "
                + "event_type, sequence, correlation_id) VALUES ('" + eventId + "'::uuid, '"
                + root.sessionId() + "'::uuid, '" + root.fixture().workspaceId() + "'::uuid, '"
                + root.fixture().userId() + "'::uuid, 'legacy.test', 1, '" + UUID.randomUUID() + "')");

        assertV42FailsAndRollsBack(root.fixture());
        try (Connection connection = connect(root.fixture().jdbcUrl())) {
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM context_events WHERE id = '" + eventId + "'::uuid"));
        }
    }

    @Test
    void v42RollsBackPrincipalAndWorkspaceWritesWhenAuditInsertFails() throws SQLException {
        RootFixture root = createRootV41Fixture();
        execute(root.fixture().jdbcUrl(), "CREATE FUNCTION fail_agent_principal_backfill_audit() RETURNS trigger "
                + "LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'agent_principal_backfilled' THEN "
                + "RAISE EXCEPTION 'injected V42 audit failure'; END IF; RETURN NEW; END $$");
        execute(root.fixture().jdbcUrl(), "CREATE TRIGGER fail_agent_principal_backfill_audit "
                + "BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_agent_principal_backfill_audit()");

        assertV42FailsAndRollsBack(root.fixture());
        try (Connection connection = connect(root.fixture().jdbcUrl())) {
            assertNull(scalarString(connection, "SELECT to_regclass('public.workspace_agents')::text"));
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM information_schema.columns WHERE table_name = 'sessions' "
                            + "AND column_name = 'agent_principal_id'"));
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM grants WHERE subject_type = 'agent' AND subject_id = '"
                            + root.sessionId() + "'::uuid AND source = 'default'"));
        }
    }

    private static RootFixture createRootV41Fixture() throws SQLException {
        Fixture fixture = createV41Fixture();
        String sessionId = insertSession(fixture, "legacy-agent", false);
        String runId = insertRun(fixture, sessionId, "user_submission");
        migrateToVersion(fixture.jdbcUrl(), "41");
        return new RootFixture(fixture, sessionId, runId);
    }

    private static void assertV42FailsAndRollsBack(Fixture fixture) throws SQLException {
        assertThrows(FlywayException.class, () -> migrateToCurrent(fixture.jdbcUrl()));
        try (Connection connection = connect(fixture.jdbcUrl())) {
            assertNull(scalarString(connection, "SELECT to_regclass('public.agent_principals')::text"),
                    "failed V42 transaction must roll back its DDL");
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM flyway_schema_history WHERE version = '41' AND success"));
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM flyway_schema_history WHERE version = '42' AND success"));
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_backfilled'"));
        }
    }

    private static Fixture createV41Fixture() throws SQLException {
        String databaseName = "xihe_cp_agent_" + UUID.randomUUID().toString().replace("-", "");
        try (Connection admin = connect(postgres.getJdbcUrl());
             Statement statement = admin.createStatement()) {
            statement.executeUpdate("CREATE DATABASE " + databaseName);
        }
        String jdbcUrl = postgres.getJdbcUrl().replace("/" + postgres.getDatabaseName(), "/" + databaseName);
        migrateToVersion(jdbcUrl, "40");

        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        execute(jdbcUrl, "INSERT INTO users (id, email, password_hash, role) VALUES ('" + userId
                + "'::uuid, 'agent-migration-" + userId + "@test.local', 'hash', 'USER')");
        execute(jdbcUrl, "INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                + "'::uuid, 'agent-migration-workspace', '" + userId + "'::uuid)");
        execute(jdbcUrl, "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('" + workspaceId
                + "'::uuid, '" + userId + "'::uuid, 'OWNER')");
        return new Fixture(jdbcUrl, userId.toString(), workspaceId.toString());
    }

    private static String insertSession(Fixture fixture, String title, boolean derived,
                                        String parentSessionId, String parentRunId) throws SQLException {
        String sessionId = UUID.randomUUID().toString();
        String titleSql = title == null ? "NULL" : "'" + title + "'";
        if (derived) {
            execute(fixture.jdbcUrl(), "INSERT INTO sessions (id, workspace_id, user_id, title, "
                    + "spawned_from_session_id, spawned_from_run_id, spawned_at, kind) VALUES ('" + sessionId
                    + "'::uuid, '" + fixture.workspaceId() + "'::uuid, '" + fixture.userId() + "'::uuid, "
                    + titleSql + ", '" + parentSessionId + "'::uuid, '" + parentRunId + "'::uuid, NOW(), 'spawn')");
        } else {
            execute(fixture.jdbcUrl(), "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('"
                    + sessionId + "'::uuid, '" + fixture.workspaceId() + "'::uuid, '" + fixture.userId()
                    + "'::uuid, " + titleSql + ")");
        }
        return sessionId;
    }

    private static String insertSession(Fixture fixture, String title, boolean derived) throws SQLException {
        return insertSession(fixture, title, derived, null, null);
    }

    private static String insertRun(Fixture fixture, String sessionId, String origin) throws SQLException {
        String runId = UUID.randomUUID().toString();
        execute(fixture.jdbcUrl(), "INSERT INTO chat_runs (id, session_id, user_id, workspace_id, "
                + "idempotency_key, request_hash, origin, status) VALUES ('" + runId + "'::uuid, '"
                + sessionId + "'::uuid, '" + fixture.userId() + "'::uuid, '" + fixture.workspaceId()
                + "'::uuid, 'migration-" + runId + "', '" + "a".repeat(64) + "', '" + origin + "', 'accepted')");
        return runId;
    }

    private static void migrateToVersion(String jdbcUrl, String version) {
        Flyway.configure()
                .dataSource(jdbcUrl, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion(version))
                .load()
                .migrate();
    }

    private static void migrateToCurrent(String jdbcUrl) {
        Flyway.configure()
                .dataSource(jdbcUrl, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    private static void execute(String jdbcUrl, String sql) throws SQLException {
        try (Connection connection = connect(jdbcUrl);
             Statement statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }

    private static Connection connect(String jdbcUrl) throws SQLException {
        return DriverManager.getConnection(jdbcUrl, postgres.getUsername(), postgres.getPassword());
    }

    private static String scalarString(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement(); ResultSet result = statement.executeQuery(sql)) {
            result.next();
            return result.getString(1);
        }
    }

    private static int scalarInt(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement(); ResultSet result = statement.executeQuery(sql)) {
            result.next();
            return result.getInt(1);
        }
    }

    private static String scalarString(String jdbcUrl, String sql) throws SQLException {
        try (Connection connection = connect(jdbcUrl)) {
            return scalarString(connection, sql);
        }
    }

    private static int scalarInt(String jdbcUrl, String sql) throws SQLException {
        try (Connection connection = connect(jdbcUrl)) {
            return scalarInt(connection, sql);
        }
    }

    private record Fixture(String jdbcUrl, String userId, String workspaceId) {}
    private record RootFixture(Fixture fixture, String sessionId, String runId) {}
}
