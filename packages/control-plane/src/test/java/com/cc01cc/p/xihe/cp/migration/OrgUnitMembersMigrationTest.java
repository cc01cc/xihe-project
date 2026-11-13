package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M1-2 (task-175): V164 creates org_unit_members on an empty database.
 *
 * <p>The property under test is not "a table exists" but "a member belongs to exactly one
 * unit". design.md:90 puts that judgement in {@code PRIMARY KEY (member_kind, member_id)}, which
 * is why the first test asserts the primary key is <b>exactly those two columns in that order</b>
 * rather than merely "a pk exists": a surrogate id plus a unique index would pass a looser
 * assertion while quietly demoting a database-level judgement to an application-level habit.</p>
 *
 * <p>The negative controls are the point. A constraint that nobody tries to violate is
 * indistinguishable from an absent constraint, so:</p>
 * <ul>
 *   <li>the same member into a second unit must be refused (23505), and the same inserts into a
 *       copy of the table <b>without</b> the key must succeed — that pair is what proves the
 *       23505 comes from the key;</li>
 *   <li>near-miss spellings of member_kind (users / Human / AGENT_PRINCIPAL) must be refused
 *       (23514), because a silently accepted spelling creates a member nothing queries for.</li>
 * </ul>
 */
class OrgUnitMembersMigrationTest {

    private static final String HUMAN = "human";
    private static final String AGENT = "agent_principal";

    private static TestDatabaseProvider.DatabaseRef postgres;
    private static Connection connection;

    @BeforeAll
    static void migrateToHeadOnAnEmptyDatabase() throws SQLException {
        postgres = TestDatabaseProvider.emptyDatabase("plan0773_m1_2");
        Flyway.configure()
                .dataSource(postgres.jdbcUrl(), postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(
                postgres.jdbcUrl(), postgres.username(), postgres.password());
    }

    @AfterAll
    static void close() throws SQLException {
        if (connection != null) {
            connection.close();
        }
    }

    @BeforeEach
    void startFromEmptyTables() throws SQLException {
        execute("DELETE FROM org_unit_members");
        execute("DELETE FROM org_units");
    }

    @Test
    void thePrimaryKeyIsTheSingleMembershipJudgement() throws SQLException {
        assertEquals("PRIMARY KEY (member_kind, member_id)",
                text("SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                        + " WHERE conrelid = 'org_unit_members'::regclass AND contype = 'p'"),
                "design.md:90 -- a surrogate id + unique index is not the same guarantee");
    }

    @Test
    void theTableHasTheShapeTheDesignFroze() throws SQLException {
        assertEquals("uuid", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'org_unit_members' AND column_name = 'org_unit_id'"));
        assertEquals("character varying", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'org_unit_members' AND column_name = 'member_kind'"));
        assertEquals("16", text("SELECT character_maximum_length FROM information_schema.columns"
                + " WHERE table_name = 'org_unit_members' AND column_name = 'member_kind'"));
        assertEquals("uuid", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'org_unit_members' AND column_name = 'member_id'"));
        assertEquals(1, scalar("SELECT count(*) FROM information_schema.columns"
                + " WHERE table_name = 'org_unit_members' AND column_name = 'created_at'"
                + " AND is_nullable = 'NO'"));

        assertEquals(1, scalar("SELECT count(*) FROM pg_indexes WHERE tablename ="
                + " 'org_unit_members' AND indexname = 'idx_org_unit_members_unit'"),
                "design.md:87 -- listing the members of one unit must not scan");

        String foreignKey = text("SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                + " WHERE conrelid = 'org_unit_members'::regclass AND contype = 'f'");
        assertTrue(foreignKey.contains("REFERENCES org_units(id)"), foreignKey);
        assertTrue(foreignKey.contains("ON DELETE RESTRICT"),
                "design.md:81 -- a unit with members is not deletable: " + foreignKey);
    }

    @Test
    void aMemberCannotBelongToTwoUnits() throws SQLException {
        UUID firstUnit = insertUnit("first");
        UUID secondUnit = insertUnit("second");
        UUID member = UUID.randomUUID();
        insertMember(firstUnit, HUMAN, member);

        SQLException refused = assertThrows(SQLException.class,
                () -> insertMember(secondUnit, HUMAN, member));
        assertEquals("23505", refused.getSQLState(),
                "the same human in a second unit must be a primary-key conflict");

        // Counter-control: the same two inserts on a copy of the table WITHOUT the key succeed.
        // Without this, the 23505 above could be coming from any other constraint on the table.
        // LIKE copies NOT NULL but neither DEFAULTs nor keys -- which is exactly what this control
        // needs (no primary key) plus one thing it must restore by hand (created_at default).
        execute("CREATE TEMP TABLE IF NOT EXISTS org_unit_members_no_pk (LIKE org_unit_members)");
        execute("ALTER TABLE org_unit_members_no_pk ALTER created_at SET DEFAULT now()");
        execute("DELETE FROM org_unit_members_no_pk");
        UUID secondMember = UUID.randomUUID();
        execute("INSERT INTO org_unit_members_no_pk (org_unit_id, member_kind, member_id) VALUES ("
                + "'" + firstUnit + "', '" + HUMAN + "', '" + secondMember + "')");
        execute("INSERT INTO org_unit_members_no_pk (org_unit_id, member_kind, member_id) VALUES ("
                + "'" + secondUnit + "', '" + HUMAN + "', '" + secondMember + "')");
        assertEquals(2, scalar("SELECT count(*) FROM org_unit_members_no_pk"),
                "without the key both rows are accepted: the refusal is the key, not luck");
    }

    @Test
    void theClosedVocabularyRejectsNearMisses() throws SQLException {
        UUID unit = insertUnit("unit");
        for (String nearMiss : new String[] {"users", "Human", "AGENT_PRINCIPAL", "agent"}) {
            SQLException refused = assertThrows(SQLException.class,
                    () -> insertMember(unit, nearMiss, UUID.randomUUID()),
                    "member_kind=" + nearMiss + " must be refused");
            assertEquals("23514", refused.getSQLState(),
                    "a stray spelling would create a member nothing looks for: " + nearMiss);
        }
        insertMember(unit, AGENT, UUID.randomUUID());
        assertEquals(1, scalar("SELECT count(*) FROM org_unit_members"),
                "the two legal spellings still work");
    }

    @Test
    void membershipIsBoundToAnExistingUnitAndBlocksItsDeletion() throws SQLException {
        SQLException missingUnit = assertThrows(SQLException.class,
                () -> insertMember(UUID.randomUUID(), HUMAN, UUID.randomUUID()));
        assertEquals("23503", missingUnit.getSQLState(),
                "a membership cannot point at a unit that does not exist");

        UUID unit = insertUnit("unit");
        insertMember(unit, HUMAN, UUID.randomUUID());
        SQLException refusedDelete = assertThrows(SQLException.class,
                () -> execute("DELETE FROM org_units WHERE id = '" + unit + "'"));
        assertEquals("23503", refusedDelete.getSQLState(),
                "ON DELETE RESTRICT keeps a unit that still has members");
        assertEquals(1, scalar("SELECT count(*) FROM org_unit_members"),
                "the membership survives the refused delete");

        String createdAt = text("SELECT created_at::text FROM org_unit_members");
        assertNotNull(createdAt, "created_at defaults to now()");
    }

    private static UUID insertUnit(String name) throws SQLException {
        UUID id = UUID.randomUUID();
        execute("INSERT INTO org_units (id, parent_id, name, path, depth) VALUES ('" + id + "', "
                + "NULL, '" + name + "', '" + id.toString().replace("-", "") + "', 0)");
        return id;
    }

    private static void insertMember(UUID unitId, String kind, UUID memberId) throws SQLException {
        execute("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id) VALUES ("
                + "'" + unitId + "', '" + kind + "', '" + memberId + "')");
    }

    private static int scalar(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getInt(1);
        }
    }

    private static String text(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getString(1);
        }
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}
