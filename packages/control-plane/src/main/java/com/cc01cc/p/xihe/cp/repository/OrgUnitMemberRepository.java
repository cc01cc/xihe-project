package com.cc01cc.p.xihe.cp.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0773 M2-11 (batch C) + M2-10b (G1): the `org_unit_members` row, and the one question G1
 * asks about a member — which workspaces it owns.
 *
 * <p>`org_unit_members` is unique on `(member_kind, member_id)` (V164), so a subject sits in at most
 * one unit: adding a member to a second unit is a <b>move</b>, expressed here as an upsert on that
 * key rather than a second insert. The write is one statement so the row can never be briefly
 * absent (a delete+insert pair would leave a window in which the subject holds nothing).</p>
 */
@Repository
public class OrgUnitMemberRepository {

    private static final String WS_OWNER = "WS_OWNER";

    /** The two legal {@code org_unit_members.member_kind} values (V164 CHECK). */
    public static final String KIND_HUMAN = "human";
    public static final String KIND_AGENT_PRINCIPAL = "agent_principal";

    /**
     * R25/R29 (task-960): one row of the "add a member" candidate read face. {@code memberKind} is
     * carried so a caller can merge the two subject tables into one picker without having to know
     * which table a row came from.
     */
    public record CandidateRow(String memberKind, UUID memberId, String displayName) {}

    private final JdbcTemplate jdbc;

    public OrgUnitMemberRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The unit a subject currently sits in, if any — the `fromOrgUnitId` of a move. */
    public Optional<UUID> findUnitOf(String memberKind, UUID memberId) {
        return jdbc.query(
                "SELECT org_unit_id FROM org_unit_members WHERE member_kind = ? AND member_id = ?",
                (rs, i) -> rs.getObject(1, UUID.class), memberKind, memberId)
                .stream().findFirst();
    }

    /**
     * Place a subject in a unit: insert on first placement, update the unit id on a move. The
     * `org_unit_members` primary key is the single-membership judgement, so an upsert is the honest
     * form of "add or move" — a second insert would fail on the key, which is the behaviour the
     * design calls out as "挂到第二个单元 ⇒ 409".
     */
    public void place(String memberKind, UUID memberId, UUID unitId) {
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id) VALUES (?, ?, ?)"
                + " ON CONFLICT (member_kind, member_id) DO UPDATE SET org_unit_id = EXCLUDED.org_unit_id",
                unitId, memberKind, memberId);
    }

    /** @return true when a row was removed (false means the subject was not in that unit) */
    public boolean remove(String memberKind, UUID memberId, UUID unitId) {
        return jdbc.update("DELETE FROM org_unit_members"
                + " WHERE member_kind = ? AND member_id = ? AND org_unit_id = ?",
                memberKind, memberId, unitId) > 0;
    }

    /**
     * R25/R29 (task-960): the only subjects that may be offered for the "add a member" action --
     * <b>those that belong to no unit at all</b>.
     *
     * <p>The invariant is {@code candidates ∩ members(whole tree) == ∅}: the query filters with
     * {@code NOT EXISTS} against {@code org_unit_members}, not against the unit being edited. A
     * subject sitting in a descendant (or any other) unit is "already in the org", and moving it to
     * this unit is the {@code move} face -- offering it here as if it were new would let a caller
     * add the same person twice. This is the server-side judgement; a client that filters a broader
     * user/principal list itself would reproduce the same bug the moment a new list face forgets
     * the rule.</p>
     *
     * <p>Disabled subjects are excluded because the write face refuses them
     * ({@code status = DISABLED}/{@code deleted_at} for humans, {@code disabled_at} for principals);
     * a candidate row is meant to be a row {@code move} will accept. {@code query} is a
     * case-insensitive display-name search, nullable; it only narrows the set, never widens it.</p>
     *
     * <p>The MVP has no free-floating member (R27, task-956), so a subject that is deactivated is
     * also not a candidate: it has no unit to return to and cannot be re-added while disabled.</p>
     */
    public List<CandidateRow> findUnassignedCandidates(String memberKind, String query) {
        String like = query == null || query.isBlank()
                ? null
                : "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
        if (KIND_HUMAN.equals(memberKind)) {
            return jdbc.query(
                    "SELECT 'human' AS member_kind, u.id AS member_id,"
                            + " COALESCE(NULLIF(TRIM(u.username), ''), u.email, u.name) AS display_name"
                            + " FROM users u"
                            + " WHERE u.status = 'ACTIVE' AND u.deleted_at IS NULL"
                            + " AND NOT EXISTS (SELECT 1 FROM org_unit_members m"
                            + " WHERE m.member_kind = 'human' AND m.member_id = u.id)"
                            + " AND (?::text IS NULL OR COALESCE(NULLIF(TRIM(u.username), ''), u.email, u.name)"
                            + " ILIKE ?::text ESCAPE '\\')"
                            + " ORDER BY display_name, u.id",
                    (rs, i) -> new CandidateRow(rs.getString("member_kind"),
                            rs.getObject("member_id", UUID.class), rs.getString("display_name")),
                    like, like);
        }
        if (KIND_AGENT_PRINCIPAL.equals(memberKind)) {
            return jdbc.query(
                    "SELECT 'agent_principal' AS member_kind, p.id AS member_id, p.name AS display_name"
                            + " FROM agent_principals p"
                            + " WHERE p.disabled_at IS NULL"
                            + " AND NOT EXISTS (SELECT 1 FROM org_unit_members m"
                            + " WHERE m.member_kind = 'agent_principal' AND m.member_id = p.id)"
                            + " AND (?::text IS NULL OR p.name ILIKE ?::text ESCAPE '\\')"
                            + " ORDER BY p.name, p.id",
                    (rs, i) -> new CandidateRow(rs.getString("member_kind"),
                            rs.getObject("member_id", UUID.class), rs.getString("display_name")),
                    like, like);
        }
        throw new IllegalArgumentException("unknown org_unit_members.member_kind: '" + memberKind + "'");
    }

    /**
     * Remove every membership row of one subject. The primary key is
     * {@code (member_kind, member_id)} (V164), so this is at most one row today; the statement is
     * written as a set delete so a future schema change cannot leave a second row behind and
     * reintroduce a free-floating member.
     *
     * @return the number of rows removed
     */
    public int removeAll(String memberKind, UUID memberId) {
        return jdbc.update("DELETE FROM org_unit_members WHERE member_kind = ? AND member_id = ?",
                memberKind, memberId);
    }

    /**
     * The workspaces a subject owns: `WS_OWNER` role bindings at workspace scope. G1's whole point
     * is that these are the workspaces whose owner the subject is <b>right now</b> — the move does
     * not touch a single binding, so the caller has to be told what it is about to change the
     * meaning of.
     */
    public List<UUID> ownedWorkspaceIds(String memberKind, UUID memberId) {
        String subjectType = "agent_principal".equals(memberKind) ? "agent_principal" : "user";
        return jdbc.query(
                "SELECT b.scope_id FROM grant_preset_bindings b JOIN grant_presets r ON r.id = b.role_id"
                        + " WHERE b.subject_type = ? AND b.subject_id = ?"
                        + " AND b.scope_type = 'workspace' AND r.name = ?"
                        + " ORDER BY b.scope_id",
                (rs, i) -> rs.getObject(1, UUID.class), subjectType, memberId, WS_OWNER);
    }
}
