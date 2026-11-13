package com.cc01cc.p.xihe.cp.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0773 M2-11 (task-246): the stored set behind `PUT …/role-bindings`.
 *
 * <p>Replace is `DELETE + INSERT` in the caller's transaction: the contract is a whole-set write
 * precisely because a delta cannot express "remove everything", so the stored rows are rebuilt
 * from the request body rather than diffed against it. `granted_by`/`granted_at` are re-stamped
 * on every replace — a binding row records its last writer, not a fictional first grant.</p>
 */
@Repository
public class OrgUnitRoleBindingRepository {

    private final JdbcTemplate jdbc;

    public OrgUnitRoleBindingRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The stored set, ordered by role id so two reads of unchanged data are byte-identical. */
    public List<UUID> findRoleIds(UUID unitId) {
        return jdbc.query("SELECT role_id FROM org_unit_role_bindings WHERE org_unit_id = ?"
                        + " ORDER BY role_id",
                (rs, i) -> rs.getObject(1, UUID.class), unitId);
    }

    /** Rebuild the unit's binding set from `roleIds` (empty list clears it). */
    public void replace(UUID unitId, List<UUID> roleIds, UUID grantedBy) {
        jdbc.update("DELETE FROM org_unit_role_bindings WHERE org_unit_id = ?", unitId);
        for (UUID roleId : roleIds) {
            jdbc.update("INSERT INTO org_unit_role_bindings (id, org_unit_id, role_id, granted_by)"
                            + " VALUES (?, ?, ?, ?)",
                    UUID.randomUUID(), unitId, roleId, grantedBy);
        }
    }
}
