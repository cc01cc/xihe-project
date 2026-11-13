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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M1-3 (task-176): V165 refuses a parent change that would close a cycle in org_units.
 *
 * <p>Two things make this test able to fail for the right reason:</p>
 * <ul>
 *   <li><b>The deep case is the case.</b> Self-parenting and the A&lt;-&gt;B pair are also caught by
 *       the one-line comparison {@code NEW.parent_id = OLD.id}, i.e. by an implementation that
 *       does not walk the ancestor chain at all. Only {@code A->B->C->D} with A re-parented onto
 *       D separates "walks the chain" from "looks one level up".</li>
 *   <li><b>The legal move must succeed.</b> An implementation that refuses every parent change
 *       passes all the rejection assertions; only a positive control can tell "guards the ring"
 *       from "guards everything".</li>
 * </ul>
 *
 * <p>The error is identified by SQLSTATE {@code XH001}, not by message text: the caller has to
 * branch on "this was a cycle" and offer a different sentence. The message is asserted to name
 * BOTH the moved unit and the intended parent, because a support engineer reading
 * "cycle detected" still has to guess which two units to look at.</p>
 */
class OrgUnitCycleGuardMigrationTest {

    private static final String CYCLE_CODE = "XH001";

    private static TestDatabaseProvider.DatabaseRef postgres;
    private static Connection connection;

    @BeforeAll
    static void migrateToHeadOnAnEmptyDatabase() throws SQLException {
        postgres = TestDatabaseProvider.emptyDatabase("plan0773_m1_3");
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
    void theTriggerIsBeforeUpdateOfParentId() throws SQLException {
        String definition = text("SELECT pg_get_triggerdef(oid) FROM pg_trigger"
                + " WHERE tgname = 'trg_org_units_reject_cycle'");
        assertTrue(definition.contains("BEFORE UPDATE OF parent_id ON public.org_units"), definition);
        assertTrue(definition.contains("EXECUTE FUNCTION org_units_reject_cycle()"), definition);
        assertEquals("O", text("SELECT tgenabled FROM pg_trigger"
                + " WHERE tgname = 'trg_org_units_reject_cycle'"),
                "the trigger must be enabled for origin/local (O), not disabled (D)");
    }

    @Test
    void aUnitCannotBecomeItsOwnParent() throws SQLException {
        UUID root = insertUnit("root", null, 0);
        SQLException refused = assertThrows(SQLException.class,
                () -> reparent(root, root));
        assertEquals(CYCLE_CODE, refused.getSQLState());
        assertTrue(refused.getMessage().contains(root.toString()), refused.getMessage());
    }

    @Test
    void twoUnitsCannotBecomeEachOthersParent() throws SQLException {
        UUID a = insertUnit("a", null, 0);
        UUID b = insertUnit("b", a, 1);
        // The ring is closed by moving the PARENT under the CHILD (A under B), not the reverse:
        // giving B the parent it already has would be a no-op, and a no-op proves nothing.
        SQLException refused = assertThrows(SQLException.class, () -> reparent(a, b));
        assertEquals(CYCLE_CODE, refused.getSQLState());
        assertTrue(refused.getMessage().contains(a.toString()),
                "the moved unit must be named: " + refused.getMessage());
        assertTrue(refused.getMessage().contains(b.toString()),
                "the intended parent must be named: " + refused.getMessage());
    }

    @Test
    void aDeepChainCannotBeClosedThroughFourRows() throws SQLException {
        // This is the case a one-level check passes: A != D, so comparing NEW.parent_id with
        // OLD.id sees nothing. The ring is closed four rows up the chain.
        UUID a = insertUnit("a", null, 0);
        UUID b = insertUnit("b", a, 1);
        UUID c = insertUnit("c", b, 2);
        UUID d = insertUnit("d", c, 3);

        SQLException refused = assertThrows(SQLException.class, () -> reparent(a, d));
        assertEquals(CYCLE_CODE, refused.getSQLState(),
                "the deep ring must be refused with the cycle code, not with a generic error");
        assertTrue(refused.getMessage().contains(a.toString()), refused.getMessage());
        assertTrue(refused.getMessage().contains(d.toString()), refused.getMessage());
        // A started as a root, so "not written" means parent_id is still NULL.
        assertNull(parentOf(a), "the refused update must not have been written");
    }

    @Test
    void aLegalMoveSucceeds() throws SQLException {
        // Positive control: without this, "refuse every parent change" passes every test above.
        UUID a = insertUnit("a", null, 0);
        UUID b = insertUnit("b", a, 1);
        UUID c = insertUnit("c", b, 2);
        UUID d = insertUnit("d", c, 3);

        assertEquals(1, update("UPDATE org_units SET parent_id = '" + b + "' WHERE id = '" + d + "'"));
        assertEquals(b, parentOf(d), "moving D under B is legal and must be stored");
    }

    @Test
    void movingToTheRootIsLegal() throws SQLException {
        UUID a = insertUnit("a", null, 0);
        UUID b = insertUnit("b", a, 1);
        assertEquals(1, update("UPDATE org_units SET parent_id = NULL, depth = 0 WHERE id = '"
                + b + "'"));
        assertEquals(null, parentOf(b));
    }

    private static UUID insertUnit(String name, UUID parentId, int depth) throws SQLException {
        UUID id = UUID.randomUUID();
        String label = id.toString().replace("-", "");
        String path = parentId == null
                ? label
                : text("SELECT path::text FROM org_units WHERE id = '" + parentId + "'") + "." + label;
        execute("INSERT INTO org_units (id, parent_id, name, path, depth) VALUES ('" + id + "', "
                + (parentId == null ? "NULL" : "'" + parentId + "'") + ", '" + name + "', '"
                + path + "', " + depth + ")");
        return id;
    }

    private static void reparent(UUID unitId, UUID newParent) throws SQLException {
        update("UPDATE org_units SET parent_id = '" + newParent + "' WHERE id = '" + unitId + "'");
    }

    private static UUID parentOf(UUID unitId) throws SQLException {
        String value = text("SELECT parent_id::text FROM org_units WHERE id = '" + unitId + "'");
        return value == null ? null : UUID.fromString(value);
    }

    private static int update(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            return statement.executeUpdate(sql);
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
