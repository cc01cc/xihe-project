package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-309 (user ruling b, 2026-11-12): a write that passed a capability gate must leave the gate's id
 * on its audit row, and a write that passed none must leave {@code NULL}.
 *
 * <p>Every gated door gets its own positive control ({@code i1} instance, {@code w1}
 * workspace-default, {@code h1} workspace), and the negative control runs through the one genuinely
 * gate-less path — the user-layer save, where {@code isAuthenticated()} is not a capability gate. That
 * pairing is the point: a single positive assertion would stay green if every write carried the same
 * tag, and a negative control borrowed from a now-tagged door would quietly stop testing anything.</p>
 *
 * <p>Two more cases pin the enumeration itself: the DB CHECK must refuse a value outside the door set,
 * and the row width is measured rather than estimated so "how expensive is this column" has a reading
 * instead of an upper bound.</p>
 */
class ConfigAuditAllowSideIntegrationTest extends AbstractReusableIntegrationTest {

    private static final String DOMAIN = "logging";

    /** A domain writable at the workspace-default and user layers (logging is instance-only). */
    // T2.4: agent-runtime replaces rag as the layered-domain fixture — rag left both
    // workspace-scoped layers; agent-runtime is writable at workspace-default AND user.
    private static final String LAYERED_DOMAIN = "agent-runtime";
    private static final Map<String, String> LAYERED_ENTRY = Map.of("runMaxTurns", "70");
    private static final String I1_ACTOR = "task309-i1-writer";
    private static final String W1_ACTOR = "task309-w1-writer";
    private static final String H1_ACTOR = "task309-h1-writer";
    private static final String USER_ACTOR = "task309-user-writer";

    @Autowired private ConfigService configService;
    @Autowired private JdbcTemplate jdbc;

    private String sourceOfLatestRowWrittenBy(String changedBy) {
        List<String> rows = jdbc.queryForList(
                "select atom_source from config_audit where changed_by = ? "
                        + "order by changed_at desc, id desc limit 1", String.class, changedBy);
        assertEquals(1, rows.size(), "expected exactly one audit row for " + changedBy);
        return rows.get(0);
    }

    @Test
    void theInstanceDoorLeavesItsIdOnTheAuditRow() {
        configService.putLayer("instance", DOMAIN, Map.of("logLevel", "WARN"), I1_ACTOR, null, null, "i1");
        assertEquals("i1", sourceOfLatestRowWrittenBy(I1_ACTOR));
    }

    @Test
    void theWorkspaceDefaultDoorLeavesItsIdOnTheAuditRow() {
        configService.putLayer("workspace-default", LAYERED_DOMAIN, LAYERED_ENTRY, W1_ACTOR, null, null, "w1");
        assertEquals("w1", sourceOfLatestRowWrittenBy(W1_ACTOR));
    }

    @Test
    void theWorkspaceDoorLeavesItsIdOnTheAuditRow() {
        configService.putLayer("instance", DOMAIN, Map.of("logLevel", "DEBUG"), H1_ACTOR, null, null, "h1");
        assertEquals("h1", sourceOfLatestRowWrittenBy(H1_ACTOR));
    }

    @Test
    void theUserLayerWritePassesNoCapabilityGateAndStaysNull() {
        UUID owner = someUserId();
        assertNotNull(owner, "the migrated schema must contain at least one user to own a personal row");
        configService.putLayer("user", LAYERED_DOMAIN, LAYERED_ENTRY, USER_ACTOR, owner, null);
        assertNull(sourceOfLatestRowWrittenBy(USER_ACTOR));
    }

    @Test
    void theColumnRefusesAnyValueOutsideTheDoorSet() {
        assertThrows(DataIntegrityViolationException.class, () -> jdbc.update(
                "insert into config_audit (id, domain, config_key, atom_source, changed_by) values (?,?,?,?,?)",
                UUID.randomUUID(), DOMAIN, "check-probe", "x1", "check-probe"));
    }

    @Test
    void theAuditRowWidthIsMeasuredRatherThanEstimated() {
        configService.putLayer("instance", DOMAIN, Map.of("logLevel", "DEBUG"), H1_ACTOR, null, null, "h1");
        Map<String, Object> measured = jdbc.queryForMap(
                "select pg_column_size(t) as row_bytes, pg_column_size(t.atom_source) as source_bytes "
                        + "from config_audit t where t.changed_by = ? "
                        + "order by t.changed_at desc limit 1", H1_ACTOR);
        int rowBytes = ((Number) measured.get("row_bytes")).intValue();
        int sourceBytes = ((Number) measured.get("source_bytes")).intValue();
        System.out.println("[task-309] config_audit row_bytes=" + rowBytes + " atom_source_bytes=" + sourceBytes);
        assertTrue(sourceBytes > 0, "atom_source must occupy bytes on a tagged row");
        assertTrue(rowBytes > sourceBytes, "the row must be wider than the column under test");
    }

    private UUID someUserId() {
        List<UUID> ids = jdbc.queryForList("select id from users limit 1", UUID.class);
        return ids.isEmpty() ? null : ids.get(0);
    }
}
