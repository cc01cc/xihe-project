package com.cc01cc.p.xihe.cp.migration;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * PLAN-0439 T0.2: freeze the template/session-pin reset scope by proving a
 * scoped export and an isolated restore round-trip before any T1.1 reset.
 *
 * Scope per evidence/t0.2-reset-scope-2026-10-11.md:
 * - in scope: config rows with domain='context-templates' + Session template pins;
 * - out of scope: chat_runs.context_template_snapshot and other config domains.
 */
@Testcontainers
class ContextTemplateResetScopeTest {

    @Container
    static final PostgreSQLContainer<?> POSTGRES =
            new PostgreSQLContainer<>("pgvector/pgvector:pg17");

    // Parent identities are shared; scoped values are seeded only in the source DB.
    private static final UUID USER_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID WS_ID = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID SESSION_ID = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final UUID BRANCH_ID = UUID.fromString("44444444-4444-4444-8444-444444444444");
    private static final UUID RUN_ID = UUID.fromString("55555555-5555-4555-8555-555555555555");
    private static final UUID PINNED_TEMPLATE_ID = UUID.fromString("66666666-6666-4666-8666-666666666666");
    private static final String INSTANCE_DEFAULT =
            "{\"templateId\":\"instance-default\",\"revision\":1}";
    private static final String USER_TEMPLATES =
            "{\"templates\":[{\"templateId\":\"user-tpl\",\"revision\":3}]}";
    private static final String WORKSPACE_TEMPLATES =
            "{\"templates\":[{\"templateId\":\"workspace-tpl\",\"revision\":4}]}";
    private static final List<String> LAYERS = List.of("instance", "user", "workspace");
    private static final String RUN_SNAPSHOT =
            "{\"templateId\":\"instance-default\",\"revision\":1,\"pinnedAt\":\"2026-10-11T00:00:00Z\"}";

    @Test
    void scopedTemplateConfigAndSessionPinsExportRestoreRoundTrip() throws SQLException {
        String adminUrl = POSTGRES.getJdbcUrl();
        migrate(adminUrl);

        String restoreDb = "xihe_cp_t02_restore";
        try (Connection admin = DriverManager.getConnection(
                adminUrl, POSTGRES.getUsername(), POSTGRES.getPassword());
             Statement statement = admin.createStatement()) {
            statement.executeUpdate("CREATE DATABASE " + restoreDb);
        }
        String restoreUrl = adminUrl.replace("/" + POSTGRES.getDatabaseName(), "/" + restoreDb);
        migrate(restoreUrl);

        try (Connection original = connect(adminUrl);
             Connection restored = connect(restoreUrl)) {
            seedParents(original, RUN_SNAPSHOT);
            seedSourceScope(original);
            // Restore parents have default pins and a distinct audit snapshot, not source values.
            seedParents(restored, "{\"restoreParent\":true}");
            ScopedBackup backup = readScopedBackup(original);
            assertEquals(5, backup.configs().size(), "legacy and partial new-format config rows");
            assertEquals(3, backup.pins().size(), "one Session pin per layer");
            for (String layer : LAYERS) {
                assertEquals(layer.equals("workspace") ? 1L : 2L, backup.configs().stream()
                        .filter(row -> row.layer().equals(layer)).count());
                assertEquals(1L, backup.pins().stream()
                        .filter(row -> row.layer().equals(layer)).count());
            }
            for (String key : List.of("connectionDefaultTemplates", "providerModelBindings")) {
                assertEquals(1L, backup.configs().stream().filter(row -> row.key().equals(key)).count(),
                        "domain export must include partial new-format rows without a key whitelist");
            }
            assertEquals(0, scopedConfigCount(restored), "restore must start without scoped config");
            ScopedBackup restoreParents = readScopedBackup(restored);
            assertEquals(3, restoreParents.pins().size());
            for (SessionPin pin : restoreParents.pins()) {
                assertEquals("instance", pin.layer());
                assertEquals(UUID.fromString("00000000-0000-4000-8000-000000000001"), pin.templateId());
                assertEquals(1, pin.version());
            }
            assertNotEquals(scopedExportHash(backup), scopedExportHash(restoreParents),
                    "parent seeding must not reproduce the scoped backup");
            assertEquals(1, runSnapshotCount(original));
            assertEquals(1, otherDomainConfigCount(original));
            assertEquals(0, otherDomainConfigCount(restored));
            String originalOutside = outOfScopeHash(original);
            String restoredOutside = outOfScopeHash(restored);

            try (Statement st = original.createStatement()) {
                assertEquals(5, st.executeUpdate(
                        "DELETE FROM config WHERE domain = 'context-templates'"));
                assertEquals(3, st.executeUpdate("UPDATE sessions SET context_template_layer = 'instance', "
                        + "context_template_id = '00000000-0000-4000-8000-000000000001'::uuid, "
                        + "context_template_version = 1"));
            }
            assertEquals(0, scopedConfigCount(original));
            assertNotEquals(scopedExportHash(backup), scopedExportHash(readScopedBackup(original)));
            assertEquals(originalOutside, outOfScopeHash(original),
                    "scoped reset must not write other domains or historical Run snapshots");

            restoreScope(original, backup);
            restoreScope(restored, backup);
            for (Connection c : List.of(original, restored)) {
                ScopedBackup actual = readScopedBackup(c);
                assertEquals(backup.configs().size(), actual.configs().size());
                assertEquals(backup.pins().size(), actual.pins().size());
                assertEquals(scopedExportHash(backup), scopedExportHash(actual),
                        "restored fields and identities must match the actual source backup");
            }
            assertEquals(originalOutside, outOfScopeHash(original));
            assertEquals(restoredOutside, outOfScopeHash(restored),
                    "restore must not import or modify out-of-scope records");
        }
    }

    private static void migrate(String jdbcUrl) {
        Flyway.configure()
                .dataSource(jdbcUrl, POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("57"))
                .load()
                .migrate();
    }

    private static Connection connect(String jdbcUrl) throws SQLException {
        return DriverManager.getConnection(jdbcUrl, POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static void seedParents(Connection c, String runSnapshot) throws SQLException {
        try (Statement st = c.createStatement()) {
            st.executeUpdate("INSERT INTO users (id, email, password_hash) VALUES ('"
                    + USER_ID + "'::uuid, 't02@test.local', 'hash')");
            st.executeUpdate("INSERT INTO workspaces (id, name, owner_id) VALUES ('"
                    + WS_ID + "'::uuid, 't02-workspace', '" + USER_ID + "'::uuid)");
            for (String layer : LAYERS) {
                st.executeUpdate("INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('"
                        + sessionId(layer) + "'::uuid, '" + WS_ID + "'::uuid, '" + USER_ID
                        + "'::uuid, 't02-session-" + layer + "')");
            }
            st.executeUpdate("INSERT INTO session_branches (id, session_id, created_at) VALUES ('"
                    + BRANCH_ID + "'::uuid, '" + SESSION_ID + "'::uuid, NOW())");
            st.executeUpdate("INSERT INTO chat_runs (id, session_id, user_id, workspace_id, "
                    + "idempotency_key, request_hash, status, origin, branch_id, "
                    + "context_template_snapshot) VALUES ('" + RUN_ID + "'::uuid, '" + SESSION_ID
                    + "'::uuid, '" + USER_ID + "'::uuid, '" + WS_ID + "'::uuid, 't02-submit', "
                    + "'t02-hash', 'accepted', 'user_submission', '" + BRANCH_ID + "'::uuid, '"
                    + runSnapshot.replace("'", "''") + "'::jsonb)");
            st.executeUpdate("INSERT INTO messages (id, session_id, run_id, branch_id, role, content) VALUES ('"
                    + UUID.nameUUIDFromBytes("t02-message".getBytes(StandardCharsets.UTF_8))
                    + "'::uuid, '" + SESSION_ID + "'::uuid, '" + RUN_ID
                    + "'::uuid, '" + BRANCH_ID + "'::uuid, 'USER', 'preserved message "
                    + runSnapshot.replace("'", "''") + "')");
        }
    }

    private static UUID sessionId(String layer) {
        return layer.equals("instance") ? SESSION_ID
                : UUID.nameUUIDFromBytes(("t02-session-" + layer).getBytes(StandardCharsets.UTF_8));
    }

    private static void seedSourceScope(Connection c) throws SQLException {
        try (Statement st = c.createStatement()) {
            st.executeUpdate(configInsert("instance", "context-templates", "defaultTemplate", INSTANCE_DEFAULT));
            st.executeUpdate(configInsert("user", "context-templates", "templates", USER_TEMPLATES));
            st.executeUpdate(configInsert("workspace", "context-templates", "templates", WORKSPACE_TEMPLATES));
            st.executeUpdate(configInsert("instance", "context-templates", "connectionDefaultTemplates",
                    "{\"partial-connection\":{\"templateId\":\"partial-default\",\"revision\":2}}"));
            st.executeUpdate(configInsert("user", "context-templates", "providerModelBindings",
                    "{\"partial-connection+model\":{\"templateId\":\"partial-override\",\"revision\":3}}"));
            st.executeUpdate(configInsert("instance", "log-level", "level", "INFO"));
        }
        try (PreparedStatement st = c.prepareStatement("UPDATE sessions SET context_template_layer = ?, "
                + "context_template_id = ?, context_template_version = ? WHERE id = ?")) {
            for (String layer : LAYERS) {
                st.setString(1, layer);
                st.setObject(2, PINNED_TEMPLATE_ID);
                st.setInt(3, LAYERS.indexOf(layer) + 2);
                st.setObject(4, sessionId(layer));
                assertEquals(1, st.executeUpdate());
            }
        }
    }

    private static String configInsert(String layer, String domain, String key, String value) {
        String user = layer.equals("user") ? "'" + USER_ID + "'::uuid" : "NULL";
        String workspace = layer.equals("workspace") ? "'" + WS_ID + "'::uuid" : "NULL";
        return "INSERT INTO config (id, layer, domain, config_key, config_value, user_id, workspace_id, "
                + "updated_by) VALUES ('"
                + UUID.nameUUIDFromBytes((layer + domain + key).getBytes(StandardCharsets.UTF_8))
                + "'::uuid, '" + layer + "', '" + domain + "', '" + key + "', '"
                + value.replace("'", "''") + "', " + user + ", " + workspace + ", 't02-source')";
    }

    private static int scopedConfigCount(Connection c) throws SQLException {
        return scalarInt(c, "SELECT count(*) FROM config WHERE domain = 'context-templates'");
    }

    private static int runSnapshotCount(Connection c) throws SQLException {
        return scalarInt(c, "SELECT count(*) FROM chat_runs "
                + "WHERE context_template_snapshot <> '{}'::jsonb");
    }

    private static int otherDomainConfigCount(Connection c) throws SQLException {
        return scalarInt(c, "SELECT count(*) FROM config WHERE domain = 'log-level'");
    }

    private record ConfigRow(UUID id, String layer, String domain, String key, String value,
                             UUID userId, UUID workspaceId, String updatedBy,
                             OffsetDateTime createdAt, OffsetDateTime updatedAt) { }

    private record SessionPin(UUID sessionId, UUID workspaceId, UUID userId,
                              String layer, UUID templateId, int version) { }

    private record ScopedBackup(List<ConfigRow> configs, List<SessionPin> pins) { }

    private static ScopedBackup readScopedBackup(Connection c) throws SQLException {
        List<ConfigRow> configs = new ArrayList<>();
        List<SessionPin> pins = new ArrayList<>();
        try (Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT id, layer, domain, config_key, config_value, "
                     + "user_id, workspace_id, updated_by, created_at, updated_at FROM config "
                     + "WHERE domain = 'context-templates' ORDER BY id")) {
            while (rs.next()) {
                configs.add(new ConfigRow(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                        rs.getString(4), rs.getString(5), rs.getObject(6, UUID.class),
                        rs.getObject(7, UUID.class), rs.getString(8),
                        rs.getObject(9, OffsetDateTime.class), rs.getObject(10, OffsetDateTime.class)));
            }
        }
        try (Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT id, workspace_id, user_id, context_template_layer, "
                     + "context_template_id, context_template_version FROM sessions ORDER BY id")) {
            while (rs.next()) {
                pins.add(new SessionPin(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        rs.getObject(3, UUID.class), rs.getString(4), rs.getObject(5, UUID.class), rs.getInt(6)));
            }
        }
        return new ScopedBackup(List.copyOf(configs), List.copyOf(pins));
    }

    private static void restoreScope(Connection c, ScopedBackup backup) throws SQLException {
        try (PreparedStatement st = c.prepareStatement("INSERT INTO config (id, layer, domain, config_key, "
                + "config_value, user_id, workspace_id, updated_by, created_at, updated_at) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
            for (ConfigRow row : backup.configs()) {
                st.setObject(1, row.id());
                st.setString(2, row.layer());
                st.setString(3, row.domain());
                st.setString(4, row.key());
                st.setString(5, row.value());
                st.setObject(6, row.userId());
                st.setObject(7, row.workspaceId());
                st.setString(8, row.updatedBy());
                st.setObject(9, row.createdAt());
                st.setObject(10, row.updatedAt());
                assertEquals(1, st.executeUpdate());
            }
        }
        try (PreparedStatement st = c.prepareStatement("UPDATE sessions SET context_template_layer = ?, "
                + "context_template_id = ?, context_template_version = ? "
                + "WHERE id = ? AND workspace_id = ? AND user_id = ?")) {
            for (SessionPin pin : backup.pins()) {
                st.setString(1, pin.layer());
                st.setObject(2, pin.templateId());
                st.setInt(3, pin.version());
                st.setObject(4, pin.sessionId());
                st.setObject(5, pin.workspaceId());
                st.setObject(6, pin.userId());
                assertEquals(1, st.executeUpdate(), "restore must match the backed-up Session identity");
            }
        }
    }

    private static String scopedExportHash(ScopedBackup backup) {
        StringBuilder export = new StringBuilder();
        for (ConfigRow row : backup.configs()) {
            appendFields(export, "config", row.id(), row.layer(), row.domain(), row.key(), row.value(),
                    row.userId(), row.workspaceId(), row.updatedBy(),
                    row.createdAt().toInstant(), row.updatedAt().toInstant());
        }
        for (SessionPin pin : backup.pins()) {
            appendFields(export, "pin", pin.sessionId(), pin.workspaceId(), pin.userId(),
                    pin.layer(), pin.templateId(), pin.version());
        }
        return hash(export.toString());
    }

    private static String outOfScopeHash(Connection c) throws SQLException {
        StringBuilder export = new StringBuilder();
        // JSONB is normalized by PostgreSQL on both reads, never compared with raw fixture JSON.
        for (String sql : List.of("SELECT to_jsonb(c)::text FROM config c "
                + "WHERE domain <> 'context-templates' ORDER BY id",
                "SELECT to_jsonb(r)::text FROM chat_runs r ORDER BY id",
                "SELECT to_jsonb(m)::text FROM messages m ORDER BY id",
                "SELECT (to_jsonb(s) - 'context_template_layer' - 'context_template_id' "
                        + "- 'context_template_version')::text FROM sessions s ORDER BY id")) {
            try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
                while (rs.next()) {
                    appendFields(export, sql);
                    for (int column = 1; column <= rs.getMetaData().getColumnCount(); column++) {
                        appendFields(export, rs.getString(column));
                    }
                }
            }
        }
        return hash(export.toString());
    }

    // Length prefixes distinguish nulls and embedded separators without losing TEXT values.
    private static void appendFields(StringBuilder export, Object... fields) {
        for (Object field : fields) {
            if (field == null) {
                export.append("-1:");
            } else {
                String value = field.toString();
                export.append(value.length()).append(':').append(value);
            }
        }
    }

    private static int scalarInt(Connection c, String sql) throws SQLException {
        try (Statement st = c.createStatement();
             ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private static String hash(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required for the backup manifest", e);
        }
    }
}
