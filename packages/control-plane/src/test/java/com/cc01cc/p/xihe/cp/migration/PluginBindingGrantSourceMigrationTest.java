package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.support.TestContainerLabels;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.3 (V139): {@code plugin_binding} becomes a grant source the product may actually write.
 *
 * <p>Why this class has to exist: the H2 profile runs with {@code spring.flyway.enabled=false} and
 * {@code ddl-auto=create-drop}, so no H2 test ever sees {@code ck_grants_source} — a green
 * {@code PluginBindingGrantLifecycleTest} says nothing about whether PostgreSQL accepts the row. The
 * schema gate is PostgreSQL-only, so the evidence lives here, on a real PostgreSQL 17 running the
 * real migration files.</p>
 *
 * <p>Evidence produced, in the order the ruling asked for it:</p>
 * <ol>
 *   <li>{@code pg_get_constraintdef} <b>before</b> the upgrade — five sources, no
 *       {@code plugin_binding};</li>
 *   <li>{@code pg_get_constraintdef} <b>after</b> — six sources, equal to
 *       {@link GrantSources#WRITABLE_SOURCES} (the Java contract, compared element-wise so a future
 *       one-sided edit fails here);</li>
 *   <li>an insert with {@code source='plugin_binding'} is accepted, including the
 *       {@code granter_type='plugin_binding'} / {@code granter_id=<bindingId>} provenance pair
 *       ({@code ck_grants_granter_ref} still holds);</li>
 *   <li><b>negative</b> — the same insert with {@code source='bogus'} still fails with SQLSTATE
 *       {@code 23514} and names {@code ck_grants_source}, i.e. V139 widened one value instead of
 *       dropping the fence. This is the only assertion here that can tell "added a value" from
 *       "removed the constraint".</li>
 * </ol>
 */
@Testcontainers
class PluginBindingGrantSourceMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_v139")
            .withUsername("test")
            .withPassword("test")
            .withLabels(TestContainerLabels.runId());

    /** Stop right before V139 (V138 belongs to another lane and may not exist yet). */
    private static final String VERSION_BEFORE = "137";

    private static final Pattern QUOTED_VALUE = Pattern.compile("'([a-z_]+)'");

    private static final UUID WORKSPACE_ID = UUID.randomUUID();
    private static final UUID SUBJECT_ID = UUID.randomUUID();
    private static final UUID BINDING_ID = UUID.randomUUID();

    private static Connection connection;
    private static String constraintBefore;

    @BeforeAll
    static void captureTheFenceThenUpgrade() throws SQLException {
        String url = postgres.getJdbcUrl();
        Flyway.configure()
                .dataSource(url, postgres.getUsername(), postgres.getPassword())
                .target(MigrationVersion.fromVersion(VERSION_BEFORE))
                .load()
                .migrate();
        connection = DriverManager.getConnection(url, postgres.getUsername(),
                postgres.getPassword());
        constraintBefore = constraintDefinition();
        execute("INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_ID + "', 'v139 ws')");
        // The upgrade itself: whatever exists above V137, here V139.
        Flyway.configure().dataSource(url, postgres.getUsername(), postgres.getPassword())
                .load()
                .migrate();
    }

    @Test
    void theSourceFenceGainsExactlyOneValue() throws SQLException {
        assertEquals(List.of("role", "spawn", "template", "credential_binding", "agent_default"),
                values(constraintBefore),
                "before V139 the allow-list is the V88 five: " + constraintBefore);
        String after = constraintDefinition();
        assertEquals(GrantSources.WRITABLE_SOURCES, values(after),
                "after V139 the allow-list is exactly GrantSources.WRITABLE_SOURCES: " + after);
        assertTrue(after.contains("plugin_binding"), after);
    }

    @Test
    void aPluginBindingRowIsAcceptedWithItsProvenance() throws SQLException {
        insertGrant("plugin_binding");
        assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE subject_id = '"
                + SUBJECT_ID + "' AND source = 'plugin_binding' AND granter_type = 'plugin_binding' "
                + "AND granter_id = '" + BINDING_ID + "'"),
                "the row shape PluginBindingGrantWriter writes must be storable");
        assertEquals(SUBJECT_ID + "", scalarString("SELECT subject_id::text FROM grants "
                + "WHERE subject_id = '" + SUBJECT_ID + "'"));
    }

    @Test
    void anyOtherNewSourceIsStillRejected() {
        SQLException rejected = assertThrows(SQLException.class, () -> insertGrant("bogus"),
                "V139 must widen the allow-list, not drop it");
        assertEquals("23514", rejected.getSQLState(),
                "check-constraint violation, not a missing column: " + rejected.getMessage());
        assertTrue(String.valueOf(rejected.getMessage()).contains("ck_grants_source"),
                "the violation must name the fence: " + rejected.getMessage());
    }

    // ------------------------------------------------------------------ helpers

    private static void insertGrant(String source) throws SQLException {
        execute("INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, "
                + "permissions, source, scope_type, scope_id, read_state) VALUES ("
                + "'" + UUID.randomUUID() + "', 'plugin_binding', '" + BINDING_ID + "', 'user', "
                + "'" + SUBJECT_ID + "', '[{\"actionClass\":\"PLUGIN_BIND\"}]'::jsonb, "
                + "'" + source + "', 'workspace', '" + WORKSPACE_ID + "', 'read')");
    }

    private static String constraintDefinition() throws SQLException {
        return scalarString("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'ck_grants_source'");
    }

    private static List<String> values(String constraintDefinition) {
        List<String> values = new ArrayList<>();
        Matcher matcher = QUOTED_VALUE.matcher(constraintDefinition);
        while (matcher.find()) {
            values.add(matcher.group(1));
        }
        return values;
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static int scalarInt(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             var resultSet = statement.executeQuery(sql)) {
            resultSet.next();
            return resultSet.getInt(1);
        }
    }

    private static String scalarString(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             var resultSet = statement.executeQuery(sql)) {
            resultSet.next();
            return resultSet.getString(1);
        }
    }
}
