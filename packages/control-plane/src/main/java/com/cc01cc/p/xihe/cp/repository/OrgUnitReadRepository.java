package com.cc01cc.p.xihe.cp.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0773 M2-11 (batch A): the read side of the org-unit tables, as plain JDBC.
 *
 * <p>Why JDBC and not JPA: {@code org_units.path} is an <b>ltree</b> ({@code V163}) and the only
 * queries this card needs are {@code path <@ ?::ltree} subtree tests plus a parent/child hop. A
 * Hibernate entity would add a user type for one column and would still be hand-written for the
 * ltree operator, so the ORM would buy nothing and hide the one thing that matters (which direction
 * {@code <@} points). The direction is the load-bearing part: in ltree {@code B <@ A} means
 * "B is a descendant-or-self of A", so the subtree of a unit is every row whose path is
 * {@code <@} that unit's path — not the reverse.</p>
 *
 * <p>The class returns only the columns the decision needs. It does not know about visibility or
 * atoms: that judgement lives in the service, because a repository that decides who may look at a
 * unit would be a second authorization surface beside {@code RequesterAuthority}.</p>
 */
@Repository
public class OrgUnitReadRepository {

    /** One unit row; {@code path} is the de-hyphenated ltree text (D-1116). */
    public record UnitRow(UUID id, UUID parentId, String name, String path, int depth) {}

    /** One membership row plus the unit's path, so callers can compare subtree membership. */
    public record MembershipRow(UUID orgUnitId, String path) {}

    /**
     * One member row with the display label resolved from the subject table. The unit id is the row's
     * own {@code org_unit_id} and not the unit being listed: with {@code includeDescendants} the rows
     * come from several units, and reporting the listed unit for all of them would make the payload
     * say every member sits where the caller asked — a wrong answer that looks plausible.
     */
    public record MemberRow(UUID orgUnitId, String memberKind, UUID memberId, String displayName) {}

    private static final String UNIT_COLUMNS = "id, parent_id, name, path::text AS path, depth";

    private final JdbcTemplate jdbc;

    public OrgUnitReadRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * The caller's own unit, if it has one. {@code org_unit_members} is unique on
     * {@code (member_kind, member_id)}, so this is at most one row — the tree allows one unit per
     * subject, and reading "which units am I in" as a list would be a lie the schema does not tell.
     */
    public Optional<MembershipRow> findHumanMembership(UUID userId) {
        List<MembershipRow> rows = jdbc.query(
                "SELECT m.org_unit_id, u.path::text AS path FROM org_unit_members m"
                        + " JOIN org_units u ON u.id = m.org_unit_id"
                        + " WHERE m.member_kind = 'human' AND m.member_id = ?",
                (rs, i) -> new MembershipRow(rs.getObject(1, UUID.class), rs.getString(2)),
                userId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public Optional<UnitRow> findUnit(UUID unitId) {
        List<UnitRow> rows = jdbc.query(
                "SELECT " + UNIT_COLUMNS + " FROM org_units WHERE id = ?",
                (rs, i) -> unit(rs), unitId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /** The direct children of one unit; {@code parentId} null means the roots. */
    public List<UnitRow> findChildren(UUID parentId) {
        if (parentId == null) {
            return jdbc.query(
                    "SELECT " + UNIT_COLUMNS + " FROM org_units WHERE parent_id IS NULL ORDER BY name, id",
                    (rs, i) -> unit(rs));
        }
        return jdbc.query(
                "SELECT " + UNIT_COLUMNS + " FROM org_units WHERE parent_id = ? ORDER BY name, id",
                (rs, i) -> unit(rs), parentId);
    }

    /** Every unit in the subtree rooted at {@code path}, this unit included (ltree {@code <@}). */
    public List<UnitRow> findSubtree(String path) {
        return jdbc.query(
                "SELECT " + UNIT_COLUMNS + " FROM org_units WHERE path <@ ?::ltree ORDER BY path, id",
                (rs, i) -> unit(rs), path);
    }

    /**
     * Name search inside one subtree ({@code scopePath} null = the whole tree, the instance-level
     * reader case). The subtree filter matters: without it a leaf-unit member could enumerate every
     * unit name in the instance by guessing search terms, which is a read the governance scope never
     * granted.
     */
    public List<UnitRow> searchByName(String q, String scopePath) {
        String like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
        if (scopePath == null) {
            return jdbc.query(
                    "SELECT " + UNIT_COLUMNS + " FROM org_units WHERE name ILIKE ? ESCAPE '\\'"
                            + " ORDER BY path, id", (rs, i) -> unit(rs), like);
        }
        return jdbc.query(
                "SELECT " + UNIT_COLUMNS + " FROM org_units"
                        + " WHERE name ILIKE ? ESCAPE '\\' AND path <@ ?::ltree"
                        + " ORDER BY path, id", (rs, i) -> unit(rs), like, scopePath);
    }

    /**
     * Which of the given units have at least one child. One query for the whole page: the tree UI
     * asks {@code hasChildren} per node, and a per-node {@code EXISTS} would turn one lazy-load
     * request into N round trips.
     */
    public java.util.Set<UUID> parentsOf(Collection<UUID> unitIds) {
        if (unitIds.isEmpty()) {
            return java.util.Set.of();
        }
        String placeholders = String.join(",", java.util.Collections.nCopies(unitIds.size(), "?"));
        return new java.util.HashSet<>(jdbc.queryForList(
                "SELECT DISTINCT parent_id FROM org_units WHERE parent_id IN (" + placeholders + ")",
                UUID.class, unitIds.toArray()));
    }

    /**
     * Members of one unit, or of its whole subtree. Humans and agent principals share the table and
     * are told apart by {@code member_kind}; the label comes from each subject table in the same
     * query (a per-member second read would be N+1 on a list the UI renders in full).
     */
    public List<MemberRow> findMembers(UUID unitId, String unitPath, boolean includeDescendants) {
        String filter = includeDescendants
                ? "m.org_unit_id IN (SELECT id FROM org_units WHERE path <@ ?::ltree)"
                : "m.org_unit_id = ?";
        Object argument = includeDescendants ? unitPath : unitId;
        return jdbc.query(
                "SELECT m.org_unit_id, m.member_kind, m.member_id,"
                        + " CASE WHEN m.member_kind = 'human'"
                        + " THEN COALESCE(NULLIF(TRIM(u.username), ''), u.email, u.name)"
                        + " ELSE p.name END AS display_name"
                        + " FROM org_unit_members m"
                        + " LEFT JOIN users u ON m.member_kind = 'human' AND u.id = m.member_id"
                        + " LEFT JOIN agent_principals p"
                        + " ON m.member_kind = 'agent_principal' AND p.id = m.member_id"
                        + " WHERE " + filter
                        + " ORDER BY m.member_kind, m.member_id",
                (rs, i) -> new MemberRow(
                        rs.getObject(1, UUID.class),
                        rs.getString(2),
                        rs.getObject(3, UUID.class),
                        rs.getString(4)),
                argument);
    }

    private static UnitRow unit(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new UnitRow(
                rs.getObject("id", UUID.class),
                rs.getObject("parent_id", UUID.class),
                rs.getString("name"),
                rs.getString("path"),
                rs.getInt("depth"));
    }
}
