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
     * The workspaces a subject owns: `WS_OWNER` role bindings at workspace scope. G1's whole point
     * is that these are the workspaces whose owner the subject is <b>right now</b> — the move does
     * not touch a single binding, so the caller has to be told what it is about to change the
     * meaning of.
     */
    public List<UUID> ownedWorkspaceIds(String memberKind, UUID memberId) {
        String subjectType = "agent_principal".equals(memberKind) ? "agent_principal" : "user";
        return jdbc.query(
                "SELECT b.scope_id FROM role_bindings b JOIN roles r ON r.id = b.role_id"
                        + " WHERE b.subject_type = ? AND b.subject_id = ?"
                        + " AND b.scope_type = 'workspace' AND r.name = ?"
                        + " ORDER BY b.scope_id",
                (rs, i) -> rs.getObject(1, UUID.class), subjectType, memberId, WS_OWNER);
    }
}
