package com.cc01cc.p.xihe.cp.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0773 M2-8b follow-up (task-33): the <b>two bounded reads</b> behind the real
 * {@link com.cc01cc.p.xihe.cp.policy.JdbcOrgUnitGrantSource}.
 *
 * <p>Shape of the answer is {@code OrgUnitGrantExpander.Rows}: the member's membership row, the
 * {@code org_units} chain it sits in, and the role bindings on that chain. The expander owns the
 * judgement (which units count, which roles are governance roles); this class only loads rows, so
 * it must not filter, cache or reorder them into meaning.</p>
 *
 * <p><b>Why two queries and not one per unit.</b> A member has exactly one membership row
 * ({@code V164} primary key {@code (member_kind, member_id)}), so the chain is resolved by
 * <b>one recursive walk</b> up {@code org_units.parent_id}: one query for the chain, one for the
 * bindings on it. Neither query loops over its own result in the client, and the server walks only
 * the handful of ancestors.</p>
 *
 * <p><b>Why not ltree ({@code chain.path @> own.path}).</b> task-911: this read now runs on the
 * workspace create path, and the crossmodule HTTP lane is H2 (no {@code ltree}, and the table
 * family has no JPA entity). A {@code WITH RECURSIVE} walk over {@code parent_id} is the same
 * relation in one statement on both PostgreSQL and H2, so the authorization read is exercised
 * instead of throwing {@code BadSqlGrammarException} (which surfaced as HTTP 500
 * {@code POLICY_EVALUATION_FAILED}, not a deny). ltree stays where it is used for ordering and
 * subtree writes; this port only needs self+ancestors.</p>
 *
 * <p><b>Direction is load-bearing.</b> In ltree {@code B <@ A} means "B is a descendant-or-self of
 * A", so the chain of {@code a.b.c} is {@code {a, a.b, a.b.c}} and {@code a.b} never inherits
 * {@code a.b.c}'s bindings. {@code chain.path @> own.path} is the same relation written from the
 * ancestor side; {@code OrgUnitGrantExpander.ancestorPaths} states the semantics at length, and
 * the integration test asserts the reverse direction is empty.</p>
 *
 * <p><b>No caching</b> ({@code M2-10a}): both methods run on every evaluation. A member moved
 * between units must change authority on the next read, so a memoized chain would be a stale
 * answer — the class holds no state beyond the {@link JdbcTemplate}.</p>
 *
 * <p>The permission array is <b>not</b> built here: {@code grant_preset_atoms} rows are returned as
 * atoms-in-rows and the policy side applies the same materialisation rules as
 * {@code PresetGrantMaterializer} (capability atoms skipped, wildcard resource omitted). Keeping that
 * rule out of the repository is what makes "one rule, two entry points" true rather than asserted.</p>
 */
@Repository
public class OrgUnitGrantRowsRepository {

    /** One {@code org_units} row of the member's chain; {@code depth} keeps the chain root-first. */
    public record UnitRow(UUID id, String path, int depth) {
    }

    /**
     * One {@code org_unit_preset_bindings} row joined with <b>one</b> of its role's
     * {@code grant_preset_atoms} rows, so a role with three atoms is three rows sharing
     * {@code (orgUnitId, roleId)}. {@code actionClass} is {@code null} only for a role with no
     * permission rows at all ({@code LEFT JOIN}), which the expander then drops as a non-governance
     * role rather than treating as "grants everything".
     */
    public record BindingRow(UUID orgUnitId, UUID roleId, String roleName, String actionClass,
                             String resourcePattern) {
    }

    private static final RowMapper<UnitRow> UNIT_MAPPER = (rs, rowNum) -> new UnitRow(
            rs.getObject("id", UUID.class), rs.getString("path"), rs.getInt("depth"));

    private static final RowMapper<BindingRow> BINDING_MAPPER = (rs, rowNum) -> new BindingRow(
            rs.getObject("org_unit_id", UUID.class), rs.getObject("role_id", UUID.class),
            rs.getString("role_name"), rs.getString("action_class"), rs.getString("resource_pattern"));

    /**
     * The ancestor walk shared by both reads: start at the member's own unit and climb
     * {@code org_units.parent_id}. {@code CAST(path AS VARCHAR)} keeps {@code path} a plain string
     * on PostgreSQL (ltree has a text output) and on H2 (the shim column is VARCHAR); the
     * recursive chain has the same rows as the ltree ancestor test, root last in the recursion and
     * root first in the final ordering.
     */
    private static final String MEMBER_CHAIN_CTE =
            "WITH RECURSIVE chain (id, parent_id, path, depth) AS ("
                    + " SELECT own.id, own.parent_id, CAST(own.path AS VARCHAR), own.depth"
                    + " FROM org_unit_members m"
                    + " JOIN org_units own ON own.id = m.org_unit_id"
                    + " WHERE m.member_kind = ? AND m.member_id = ?"
                    + " UNION ALL"
                    + " SELECT parent.id, parent.parent_id, CAST(parent.path AS VARCHAR), parent.depth"
                    + " FROM chain c"
                    + " JOIN org_units parent ON parent.id = c.parent_id)";

    /**
     * The member's unit plus every ancestor, root first. Empty when the member has no membership
     * row — a legal answer, not a failure (the port documents it).
     */
    private static final String MEMBER_UNIT_CHAIN =
            MEMBER_CHAIN_CTE + " SELECT id, path, depth FROM chain ORDER BY depth";

    /**
     * The bindings that sit on the member's chain, each joined with its role name and the role's
     * atoms. The IN-subquery is the same recursive chain as {@link #MEMBER_UNIT_CHAIN}; it is
     * written out instead of taking ids as a parameter so the read stays one statement (an id list
     * would make the statement's shape depend on tree depth).
     */
    private static final String BINDINGS_ON_MEMBER_CHAIN =
            MEMBER_CHAIN_CTE
                    + " SELECT b.org_unit_id AS org_unit_id, b.role_id AS role_id, r.name AS role_name,"
                    + " rp.action_class AS action_class, rp.resource_pattern AS resource_pattern"
                    + " FROM org_unit_preset_bindings b"
                    + " JOIN grant_presets r ON r.id = b.role_id"
                    + " LEFT JOIN grant_preset_atoms rp ON rp.role_id = b.role_id"
                    + " WHERE b.org_unit_id IN (SELECT id FROM chain)"
                    + " ORDER BY b.org_unit_id, r.name, rp.action_class";

    private final JdbcTemplate jdbc;

    public OrgUnitGrantRowsRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** @return the chain root-first; empty when the member belongs to no unit */
    public List<UnitRow> memberUnitChain(String memberKind, UUID memberId) {
        return jdbc.query(MEMBER_UNIT_CHAIN, UNIT_MAPPER, memberKind, memberId);
    }

    /** @return one row per (binding, role atom); empty when no binding sits on the chain */
    public List<BindingRow> bindingsOnMemberChain(String memberKind, UUID memberId) {
        return jdbc.query(BINDINGS_ON_MEMBER_CHAIN, BINDING_MAPPER, memberKind, memberId);
    }
}
