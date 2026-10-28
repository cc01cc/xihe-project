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
 * PLAN-0489 T1.1（contract: PLAN-0486 spec v3.4 §1）：V58 {@code scheduled_tasks}
 * 在隔离 PG 全量迁移成功；关键 CHECK 正反例（expires_at / session_target /
 * prompt / status）与两条（+quota 共三条）索引断言；V60 创建者归属列
 * {@code agent_principal_id}（FK SET NULL + 部分索引 + 删除降级）同批断言。
 */
@Testcontainers
class ScheduledTaskMigrationIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_scheduled")
            .withUsername("test")
            .withPassword("test");

    private static Connection connection;
    private static UUID userId;
    private static UUID workspaceId;
    private static UUID sessionId;

    @BeforeAll
    static void applyMigrationsOnFreshDatabase() throws SQLException {
        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
        userId = UUID.randomUUID();
        workspaceId = UUID.randomUUID();
        sessionId = UUID.randomUUID();
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + userId
                + "'::uuid, 'sched-" + userId + "@test.local', 'hash', 'x' || left(md5(random()::text), 31))");
        execute("INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                + "'::uuid, 'sched-workspace', '" + userId + "'::uuid)");
        execute("INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('" + sessionId
                + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, 'sched-session')");
    }

    @Test
    void v58_scheduled_tasks_table_constraints_and_indexes_applied() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '58' AND success = true"),
                "V58 must be recorded as applied");
        assertEquals("jsonb", scalarString(
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'scheduled_tasks' AND column_name = 'payload'"));
        assertEquals("NO", scalarString(
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'scheduled_tasks' AND column_name = 'next_fire_at'"));
        assertEquals(7, scalarInt(
                "SELECT count(*) FROM pg_constraint WHERE conname IN ('ck_scheduled_tasks_trigger_kind', "
                        + "'ck_scheduled_tasks_target_kind', 'ck_scheduled_tasks_status', "
                        + "'ck_scheduled_tasks_cron_expr', 'ck_scheduled_tasks_expires_at', "
                        + "'ck_scheduled_tasks_session_target', 'ck_scheduled_tasks_prompt') "
                        + "AND contype = 'c'"),
                "all scheduled_tasks CHECK constraints must exist (7 names)");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname = 'idx_scheduled_tasks_due' AND indexdef LIKE '%status%scheduled%'"),
                "due scan index must be partial on status='scheduled'");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname = 'idx_scheduled_tasks_workspace_created_at'"),
                "workspace listing index must exist");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname = 'idx_scheduled_tasks_user_status'"),
                "principal quota index must exist");
    }

    @Test
    void valid_delay_once_and_cron_rows_insert() throws SQLException {
        UUID delayId = UUID.randomUUID();
        execute("INSERT INTO scheduled_tasks (id, workspace_id, user_id, trigger_kind, timezone, "
                + "target_kind, payload, status, next_fire_at, expires_at) VALUES ('" + delayId
                + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, 'delay_once', 'UTC', "
                + "'job_dispatch', '{\"command\":\"echo\",\"args\":[\"hi\"]}'::jsonb, 'scheduled', "
                + "NOW() + interval '1 minute', NOW() + interval '7 days')");
        assertEquals(1, scalarInt("SELECT count(*) FROM scheduled_tasks WHERE id = '" + delayId
                + "'::uuid AND trigger_kind = 'delay_once' AND status = 'scheduled'"));

        UUID cronId = UUID.randomUUID();
        execute("INSERT INTO scheduled_tasks (id, workspace_id, user_id, trigger_kind, cron_expr, "
                + "timezone, target_kind, target_session_id, prompt, status, next_fire_at) VALUES ('"
                + cronId + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, 'cron', "
                + "'*/5 * * * *', 'UTC', 'session_wakeup', '" + sessionId + "'::uuid, 'daily nudge', "
                + "'scheduled', NOW() + interval '5 minutes')");
        assertEquals(1, scalarInt("SELECT count(*) FROM scheduled_tasks WHERE id = '" + cronId
                + "'::uuid AND trigger_kind = 'cron' AND expires_at IS NULL"));
    }

    @Test
    void delay_once_without_expires_at_is_rejected() {
        UUID id = UUID.randomUUID();
        assertThrows(SQLException.class, () -> execute(
                "INSERT INTO scheduled_tasks (id, workspace_id, user_id, trigger_kind, timezone, "
                        + "target_kind, payload, status, next_fire_at) VALUES ('" + id + "'::uuid, '"
                        + workspaceId + "'::uuid, '" + userId + "'::uuid, 'delay_once', 'UTC', "
                        + "'job_dispatch', '{\"command\":\"echo\"}'::jsonb, 'scheduled', NOW())"),
                "ck_scheduled_tasks_expires_at must reject delay_once without expires_at");
    }

    @Test
    void cron_with_expires_at_is_rejected() {
        UUID id = UUID.randomUUID();
        assertThrows(SQLException.class, () -> execute(
                "INSERT INTO scheduled_tasks (id, workspace_id, user_id, trigger_kind, cron_expr, "
                        + "timezone, target_kind, payload, status, next_fire_at, expires_at) VALUES ('"
                        + id + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, 'cron', "
                        + "'*/5 * * * *', 'UTC', 'job_dispatch', '{\"command\":\"echo\"}'::jsonb, "
                        + "'scheduled', NOW(), NOW() + interval '1 hour')"),
                "ck_scheduled_tasks_expires_at must reject cron with expires_at");
    }

    @Test
    void job_dispatch_with_session_target_is_rejected() {
        UUID id = UUID.randomUUID();
        assertThrows(SQLException.class, () -> execute(
                "INSERT INTO scheduled_tasks (id, workspace_id, user_id, trigger_kind, timezone, "
                        + "target_kind, target_session_id, payload, status, next_fire_at) VALUES ('"
                        + id + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, "
                        + "'delay_once', 'UTC', 'job_dispatch', '" + sessionId + "'::uuid, "
                        + "'{\"command\":\"echo\"}'::jsonb, 'scheduled', NOW(), NOW() + interval '1 hour')"),
                "ck_scheduled_tasks_session_target must reject job_dispatch referencing a session");
    }

    @Test
    void job_dispatch_with_prompt_is_rejected() {
        UUID id = UUID.randomUUID();
        assertThrows(SQLException.class, () -> execute(
                "INSERT INTO scheduled_tasks (id, workspace_id, user_id, trigger_kind, timezone, "
                        + "target_kind, prompt, payload, status, next_fire_at) VALUES ('" + id
                        + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, 'delay_once', "
                        + "'UTC', 'job_dispatch', 'prompt', '{\"command\":\"echo\"}'::jsonb, "
                        + "'scheduled', NOW(), NOW() + interval '1 hour')"),
                "ck_scheduled_tasks_session_target must reject job_dispatch carrying a prompt");
    }

    @Test
    void session_wakeup_without_prompt_is_rejected() {
        UUID id = UUID.randomUUID();
        assertThrows(SQLException.class, () -> execute(
                "INSERT INTO scheduled_tasks (id, workspace_id, user_id, trigger_kind, cron_expr, "
                        + "timezone, target_kind, target_session_id, payload, status, next_fire_at) "
                        + "VALUES ('" + id + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                        + "'::uuid, 'cron', '*/5 * * * *', 'UTC', 'session_wakeup', '" + sessionId
                        + "'::uuid', '{}'::jsonb, 'scheduled', NOW())"),
                "ck_scheduled_tasks_prompt must reject session_wakeup without prompt");
    }

    @Test
    void unknown_status_value_is_rejected() {
        UUID id = UUID.randomUUID();
        assertThrows(SQLException.class, () -> execute(
                "INSERT INTO scheduled_tasks (id, workspace_id, user_id, trigger_kind, timezone, "
                        + "target_kind, payload, status, next_fire_at) VALUES ('" + id + "'::uuid, '"
                        + workspaceId + "'::uuid, '" + userId + "'::uuid, 'delay_once', 'UTC', "
                        + "'job_dispatch', '{\"command\":\"echo\"}'::jsonb, 'queued', NOW(), "
                        + "NOW() + interval '1 hour')"),
                "ck_scheduled_tasks_status must reject unknown status values");
    }

    @Test
    void v60_creator_principal_column_fk_and_partial_index_applied() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '60' AND success = true"),
                "V60 must be recorded as applied");
        assertEquals("uuid", scalarString(
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'scheduled_tasks' AND column_name = 'agent_principal_id'"));
        assertEquals("YES", scalarString(
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'scheduled_tasks' AND column_name = 'agent_principal_id'"),
                "creator principal is optional (human creation keeps the column NULL)");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_constraint conf "
                        + "JOIN pg_attribute src ON src.attrelid = conf.conrelid "
                        + "AND src.attnum = ANY (conf.conkey) "
                        + "WHERE conf.contype = 'f' "
                        + "AND conf.conrelid = 'scheduled_tasks'::regclass "
                        + "AND conf.confrelid = 'agent_principals'::regclass "
                        + "AND src.attname = 'agent_principal_id' "
                        + "AND conf.confdeltype = 'n'"),
                "creator principal FK must be ON DELETE SET NULL (confdeltype 'n')");
        String indexDef = scalarString(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname = 'idx_scheduled_tasks_creator_principal'");
        assertTrue(indexDef.contains("(agent_principal_id, created_at DESC)"),
                "creator principal index must lead with (agent_principal_id, created_at DESC): " + indexDef);
        assertTrue(indexDef.contains("WHERE (agent_principal_id IS NOT NULL)"),
                "creator principal index must be partial on agent_principal_id IS NOT NULL: " + indexDef);
    }

    @Test
    void v60_deleting_agent_principal_sets_creator_column_null_and_keeps_task() throws SQLException {
        UUID principalId = UUID.randomUUID();
        execute("INSERT INTO agent_principals (id, name, created_by_user_id) VALUES ('" + principalId
                + "'::uuid, 'v60-agent', '" + userId + "'::uuid)");
        UUID taskId = UUID.randomUUID();
        execute("INSERT INTO scheduled_tasks (id, workspace_id, user_id, agent_principal_id, "
                + "trigger_kind, cron_expr, timezone, target_kind, target_session_id, prompt, status, "
                + "next_fire_at) VALUES ('" + taskId + "'::uuid, '" + workspaceId + "'::uuid, '"
                + userId + "'::uuid, '" + principalId + "'::uuid, 'cron', '*/5 * * * *', 'UTC', "
                + "'session_wakeup', '" + sessionId + "'::uuid, 'agent task', 'scheduled', "
                + "NOW() + interval '5 minutes')");
        assertEquals(1, scalarInt("SELECT count(*) FROM scheduled_tasks WHERE id = '" + taskId
                + "'::uuid AND agent_principal_id = '" + principalId + "'::uuid"));

        execute("DELETE FROM agent_principals WHERE id = '" + principalId + "'::uuid");

        assertEquals(1, scalarInt("SELECT count(*) FROM scheduled_tasks WHERE id = '" + taskId
                + "'::uuid AND agent_principal_id IS NULL"),
                "principal deletion must SET NULL on the creator column and keep the task row");
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
