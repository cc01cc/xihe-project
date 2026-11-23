package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-895: the <b>real Flyway seeding path</b>, then the grant read boundary on top of it.
 *
 * <p>This is the case the card requires so the "stack-2 could not see it" blind spot cannot come
 * back: the database is empty, {@code classpath:db/migration} is replayed to head, and the
 * assertions are made against rows the migrations actually wrote.</p>
 *
 * <p>It pins three facts:</p>
 * <ol>
 *   <li>the seeds <b>do</b> write {@code cap:} rows into {@code grant_preset_atoms} (V87 / V111) —
 *       capability atoms are legitimate preset atoms;</li>
 *   <li>the product write path keeps them out of {@code grants} (V88's invariant: 0 rows);</li>
 *   <li>when a {@code cap:} row <b>does</b> reach {@code grants} (persisted data from any writer),
 *       the evaluation read treats it as inert instead of throwing
 *       {@code Unknown actionClass: cap:...}.</li>
 * </ol>
 */
class CapabilityAtomSeedReadBoundaryTest {

    /** Empty database; this class replays Flyway itself (same shape as DefaultSetMigrationParityTest). */
    static TestDatabaseProvider.DatabaseRef postgres =
            TestDatabaseProvider.emptyDatabase("capatomread");

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final GrantIntersectionEvaluator EVALUATOR = new GrantIntersectionEvaluator();

    private static Connection connection;

    @BeforeAll
    static void migrateToHead() throws SQLException {
        String url = postgres.jdbcUrl();
        Flyway.configure()
                .dataSource(url, postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(url, postgres.username(), postgres.password());
    }

    @Test
    void seedsPutCapabilityAtomsInPresetAtomsButNeverInGrants() throws SQLException {
        Map<String, Set<String>> capsByPreset = new LinkedHashMap<>();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT r.name, rp.action_class FROM grant_preset_atoms rp"
                        + " JOIN grant_presets r ON r.id = rp.role_id"
                        + " WHERE rp.action_class LIKE 'cap:%' ORDER BY r.name, rp.action_class")) {
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    capsByPreset.computeIfAbsent(result.getString(1), ignored -> new java.util.LinkedHashSet<>())
                            .add(result.getString(2));
                }
            }
        }
        assertEquals(Map.of(
                        SystemGrantPresetCatalog.SUPER_ADMIN, Set.of(
                                "cap:instance:admin", "cap:instance:super", "cap:workspace:admin"),
                        SystemGrantPresetCatalog.ADMIN, Set.of(
                                "cap:instance:admin", "cap:workspace:admin"),
                        SystemGrantPresetCatalog.WS_OWNER, Set.of("cap:workspace:admin")),
                capsByPreset,
                "V87:154-156/168/185 and V111:73 are the capability rows the presets legitimately carry");

        assertEquals(0, count("SELECT count(*) FROM grants WHERE permissions::text LIKE '%cap:%'"),
                "V88's invariant: capability atoms never materialize into grants");
    }

    @Test
    void aCapabilityRowThatReachesGrantsIsInertAtTheEvaluationRead() throws Exception {
        UUID subject = UUID.randomUUID();
        try {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id,"
                            + " permissions, source, scope_type, scope_id, read_state)"
                            + " VALUES (gen_random_uuid(), NULL, NULL, 'user', ?,"
                            + " CAST(? AS jsonb), 'assigned', 'instance', NULL, 'read')")) {
                insert.setObject(1, subject);
                insert.setString(2, "[{\"actionClass\":\"cap:workspace:admin\"}]");
                insert.executeUpdate();
            }
            assertEquals(1, countForSubject(subject),
                    "the raw-SQL materialization shape (JOIN grant_preset_atoms) really does persist a cap row");

            List<AuthorizationGrant> rows = grantsOf(subject);
            assertEquals(Set.of(), EVALUATOR.union(rows),
                    "reading the persisted cap row must not throw Unknown actionClass: cap:...");
            assertTrue(EVALUATOR.unionAttributed(rows).isEmpty(),
                    "an inert row cannot be cited as the grant that authorized anything");

            AuthorizationGrant actionRow = new AuthorizationGrant();
            actionRow.setId(UUID.randomUUID());
            actionRow.setSource(GrantSources.ASSIGNED);
            actionRow.setPermissions(MAPPER.readTree("[{\"actionClass\":\"action:read\"}]"));
            Set<GrantIntersectionEvaluator.PermissionAtom> withCap =
                    EVALUATOR.union(List.of(actionRow, rows.get(0)));
            assertEquals(Set.of(new GrantIntersectionEvaluator.PermissionAtom("action:read", "*")), withCap);
        } finally {
            // One database per class: the injected row must not leak into the seed assertions.
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM grants WHERE subject_id = ?")) {
                delete.setObject(1, subject);
                delete.executeUpdate();
            }
        }
    }

    private static int count(String sql) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(sql);
             ResultSet result = statement.executeQuery()) {
            result.next();
            return result.getInt(1);
        }
    }

    private static int countForSubject(UUID subject) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT count(*) FROM grants WHERE subject_id = ?"
                        + " AND permissions::text LIKE '%cap:%'")) {
            statement.setObject(1, subject);
            try (ResultSet result = statement.executeQuery()) {
                result.next();
                return result.getInt(1);
            }
        }
    }

    private static List<AuthorizationGrant> grantsOf(UUID subject) throws Exception {
        List<AuthorizationGrant> rows = new java.util.ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT id, permissions::text, source FROM grants WHERE subject_id = ?")) {
            statement.setObject(1, subject);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    AuthorizationGrant grant = new AuthorizationGrant();
                    grant.setId(UUID.fromString(result.getString(1)));
                    grant.setPermissions(MAPPER.readTree(result.getString(2)));
                    grant.setSource(result.getString(3));
                    rows.add(grant);
                }
            }
        }
        return rows;
    }
}
