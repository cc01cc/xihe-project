package com.cc01cc.p.xihe.cp.crossmodule;

import com.cc01cc.p.xihe.cp.policy.SystemGrantPresetCatalog;
import com.cc01cc.p.xihe.cp.repository.OrgUnitGrantRowsRepository;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * task-911 parity fixture: one three-level unit tree (root → middle → own) with a human member in
 * the deepest unit and one preset binding on the middle unit. H2 and PostgreSQL seed the same rows
 * and assert the same answer, so "the two dialects return the same chain" is a shared judgement
 * rather than two test-local expectations that can drift apart.
 *
 * <p>The only dialect difference is the {@code path} parameter cast: PostgreSQL stores it as
 * {@code ltree} (needs {@code ?::ltree}), the H2 shim stores it as {@code VARCHAR} (plain
 * {@code ?}). The text values are identical — de-hyphenated UUID labels, the D-1116 spelling.</p>
 */
final class OrgUnitChainFixture {

    private OrgUnitChainFixture() {
    }

    /** The ids and paths the fixture inserted; assertions read them back rather than re-derive. */
    record Seeded(UUID rootId, UUID midId, UUID ownId,
                  String rootPath, String midPath, String ownPath,
                  UUID presetId, UUID memberId) {
    }

    /**
     * @param postgres {@code true} on the migrated PostgreSQL lane (ltree cast); {@code false} on
     *                 the H2 lane (VARCHAR shim)
     */
    static Seeded seed(JdbcTemplate jdbc, boolean postgres) {
        UUID rootId = UUID.randomUUID();
        UUID midId = UUID.randomUUID();
        UUID ownId = UUID.randomUUID();
        UUID memberId = UUID.randomUUID();
        String rootPath = label(rootId);
        String midPath = rootPath + "." + label(midId);
        String ownPath = midPath + "." + label(ownId);
        String pathPlaceholder = postgres ? "?::ltree" : "?";

        insertUnit(jdbc, rootId, null, rootPath, 0, pathPlaceholder);
        insertUnit(jdbc, midId, rootId, midPath, 1, pathPlaceholder);
        insertUnit(jdbc, ownId, midId, ownPath, 2, pathPlaceholder);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, ?, ?)", ownId, "human", memberId);
        UUID presetId = SystemGrantPresetCatalog.WS_VIEWER_ID;
        jdbc.update("INSERT INTO org_unit_preset_bindings (id, org_unit_id, role_id)"
                + " VALUES (?, ?, ?)", UUID.randomUUID(), midId, presetId);
        return new Seeded(rootId, midId, ownId, rootPath, midPath, ownPath, presetId, memberId);
    }

    /** Root first, self last — exactly what the ltree ancestor test returned before task-911. */
    static void assertChain(List<OrgUnitGrantRowsRepository.UnitRow> chain, Seeded fixture) {
        assertEquals(3, chain.size(), "member unit + two ancestors");
        assertEquals(List.of(fixture.rootId(), fixture.midId(), fixture.ownId()),
                chain.stream().map(OrgUnitGrantRowsRepository.UnitRow::id).toList());
        assertEquals(List.of(fixture.rootPath(), fixture.midPath(), fixture.ownPath()),
                chain.stream().map(OrgUnitGrantRowsRepository.UnitRow::path).toList());
        assertEquals(List.of(0, 1, 2),
                chain.stream().map(OrgUnitGrantRowsRepository.UnitRow::depth).toList());
    }

    /**
     * The binding sits on the middle unit, so this also proves the walk reaches ancestors (not just
     * the member's own unit). Whether a preset is a governance preset is
     * {@code OrgUnitGovernancePolicy}'s judgement; this repository only loads rows, so every
     * {@code WS_VIEWER} atom row must be here.
     */
    static void assertBindings(List<OrgUnitGrantRowsRepository.BindingRow> bindings, Seeded fixture) {
        assertFalse(bindings.isEmpty(), "WS_VIEWER has atoms, so the LEFT JOIN yields rows");
        for (OrgUnitGrantRowsRepository.BindingRow row : bindings) {
            assertEquals(fixture.midId(), row.orgUnitId());
            assertEquals(fixture.presetId(), row.roleId());
            assertNotNull(row.actionClass());
        }
    }

    private static void insertUnit(JdbcTemplate jdbc, UUID id, UUID parentId, String path, int depth,
                                   String pathPlaceholder) {
        jdbc.update("INSERT INTO org_units (id, parent_id, name, path, depth)"
                        + " VALUES (?, ?, ?, " + pathPlaceholder + ", ?)",
                id, parentId, "unit-" + id, path, depth);
    }

    /** D-1116: one ltree label per level, the UUID without hyphens. */
    private static String label(UUID id) {
        return id.toString().replace("-", "");
    }
}
