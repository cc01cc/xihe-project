package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.controller.OrgUnitWireView;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserStatus;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0773 M2-11 (batch C) + M2-10b (**G1**): add/move/remove one human or agent in a unit.
 *
 * <p><b>Why the response has to carry {@code affectedWorkspaceIds}.</b> A subject's org-unit
 * membership decides which <i>atoms</i> it holds (design §4.1.1), while its {@code WS_OWNER} bindings
 * are untouched by the move — "the permission follows the person" (§4.6). So a move can silently
 * change what a workspace owner may do, and nothing in {@code grant_preset_bindings} records that it
 * happened. G1's judgement is therefore: <b>say which workspaces are affected, and require
 * confirmation when the answer is non-empty</b>.</p>
 *
 * <p><b>Two deliberate details:</b></p>
 * <ul>
 *   <li>{@code affectedWorkspaceIds} is always present — an <b>empty array is an answer</b> ("no
 *       workspace is affected"), a missing field is a contract break. The DTO has the field
 *       unconditionally for that reason.</li>
 *   <li>The audit row is written <b>in the same transaction</b> as the membership write: a move
 *       that is not audited cannot happen. And when confirmation is missing, <b>nothing</b> runs —
 *       no membership write and no audit row — which is the third clause of {@code verify.md}
 *       V2-11 and the reason the check sits <i>before</i> the first write rather than after.</li>
 * </ul>
 *
 * <p>The atom is {@code MANAGE_ORG_UNIT_MEMBERS} (design §4.2), and the scope/atom order comes from
 * {@link OrgUnitAccess}: a non-member is a <b>404</b>, not a 403, on this face too.</p>
 */
@Service
public class OrgUnitMemberService {

    public static final String MANAGE_MEMBERS_ATOM = ToolFaceRegistry.ACTION_MANAGE_ORG_UNIT_MEMBERS;

    /** The audit action G1 names verbatim; also returned in the response so a client need not guess. */
    public static final String AUDIT_EVENT = "org_membership_moved";

    /**
     * R31 (task-956): removing a member now means <b>deactivating the subject</b>, so the durable
     * row is named for that action. "Removed from the unit" and "deactivated" are the same call on
     * purpose — the MVP has no free-floating member, so there is no honest way to remove a subject
     * from its only unit and leave the account active.
     */
    public static final String REMOVED_AUDIT_EVENT = "org_membership_deactivated";

    private final OrgUnitReadRepository units;
    private final OrgUnitMemberRepository members;
    private final OrgUnitAccess access;
    private final AuditLogger audit;
    private final ObjectMapper objectMapper;
    private final UserRepository users;
    private final AgentPrincipalRepository principals;

    public OrgUnitMemberService(OrgUnitReadRepository units, OrgUnitMemberRepository members,
                                OrgUnitAccess access, AuditLogger audit, ObjectMapper objectMapper,
                                UserRepository users, AgentPrincipalRepository principals) {
        this.units = units;
        this.members = members;
        this.access = access;
        this.audit = audit;
        this.objectMapper = objectMapper;
        this.users = users;
        this.principals = principals;
    }

    @Transactional
    public OrgUnitWireView.MemberMoved move(String unitIdValue, String memberIdValue,
                                            String memberKindValue, boolean confirmAffected) {
        OrgUnitAccess.Scope scope = access.resolve(MANAGE_MEMBERS_ATOM);
        OrgUnitReadRepository.UnitRow unit = requireUnit(unitIdValue, scope);
        String memberKind = requireKind(memberKindValue);
        UUID memberId = requireMemberId(memberIdValue);

        List<UUID> affected = members.ownedWorkspaceIds(memberKind, memberId);
        if (!affected.isEmpty() && !confirmAffected) {
            // Refuse BEFORE the first write: the clause is "409 and the rows did not change", not
            // "409 and the rows were rolled back". Both are equivalent in the end state, but only
            // the first also leaves the audit count untouched without relying on a rollback.
            throw new CpApiException(HttpStatus.CONFLICT, "ORG_UNIT_MOVE_CONFIRMATION_REQUIRED",
                    "this move affects " + affected.size() + " workspace(s) owned by the subject;"
                            + " resend with confirmAffected=true");
        }

        UUID fromUnitId = members.findUnitOf(memberKind, memberId).orElse(null);
        members.place(memberKind, memberId, unit.id());

        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("memberKind", memberKind);
        detail.put("memberId", memberId.toString());
        detail.put("fromOrgUnitId", fromUnitId == null ? null : fromUnitId.toString());
        detail.put("toOrgUnitId", unit.id().toString());
        var affectedNode = detail.putArray("affectedWorkspaceIds");
        affected.forEach(id -> affectedNode.add(id.toString()));
        audit.recordDurableChange(access.currentActorId(), null, AUDIT_EVENT, "org_unit_member",
                memberId.toString(), detail.toString());

        return new OrgUnitWireView.MemberMoved(memberId, fromUnitId, unit.id(), affected, AUDIT_EVENT);
    }

    /**
     * R31: "remove" is <b>deactivation</b>, not a bare membership delete (task-956; MVP ruling:
     * every member is inside the org, so the only exits are "move to another unit" — which is
     * {@link #move} — and "delete the subject").
     *
     * <p><b>Why plan A and not "drop the endpoint".</b> Dropping the endpoint would leave no way to
     * delete an account from the org surface, and the very next caller would either re-add a bare
     * delete or deactivate subjects through some unrelated admin face. Deactivation uses the
     * lifecycle columns the platform already owns ({@code users.status}/{@code users.deleted_at},
     * {@code agent_principals.disabled_at}) and revokes both credential channels for a human
     * ({@code token_version}/{@code session_version}), so a removed member stops authenticating on
     * the next request rather than after the access-token TTL. No new column is needed: this is
     * why the card's V188 is <b>not</b> consumed.</p>
     *
     * <p>The pair-specific 404 runs <b>before</b> deactivation: a caller targeting the wrong unit
     * must not be able to disable a subject that merely lives somewhere else in its subtree.</p>
     */
    @Transactional
    public void remove(String unitIdValue, String memberIdValue, String memberKindValue) {
        OrgUnitAccess.Scope scope = access.resolve(MANAGE_MEMBERS_ATOM);
        OrgUnitReadRepository.UnitRow unit = requireUnit(unitIdValue, scope);
        String memberKind = requireKind(memberKindValue);
        UUID memberId = requireMemberId(memberIdValue);
        UUID currentUnit = members.findUnitOf(memberKind, memberId).orElse(null);
        if (currentUnit == null || !currentUnit.equals(unit.id())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "ORG_UNIT_MEMBER_NOT_FOUND",
                    "that subject is not a member of this org unit");
        }

        boolean alreadyDeactivated = deactivateSubject(memberKind, memberId);
        members.removeAll(memberKind, memberId);

        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("memberKind", memberKind);
        detail.put("memberId", memberId.toString());
        detail.put("orgUnitId", unit.id().toString());
        detail.put("subjectAction", "deactivated");
        detail.put("alreadyDeactivated", alreadyDeactivated);
        audit.recordDurableChange(access.currentActorId(), null, REMOVED_AUDIT_EVENT,
                "org_unit_member", memberId.toString(), detail.toString());
    }

    /**
     * Deactivate the subject row itself. Humans use the existing soft-delete contract
     * (`deleted_at` implies `status = DISABLED`, V86) and both epochs are bumped so access and
     * refresh tokens die in the same transaction (PLAN-0581 §4). Agent principals use
     * `disabled_at`, the same column the principal admin face writes.
     *
     * @return true when the subject was already deactivated (a legacy row whose membership outlived
     *     the account), false when this call performed the transition.
     */
    private boolean deactivateSubject(String memberKind, UUID memberId) {
        if ("human".equals(memberKind)) {
            User user = users.findById(memberId).orElseThrow(() -> new CpApiException(
                    HttpStatus.NOT_FOUND, "ORG_UNIT_MEMBER_NOT_FOUND",
                    "that subject is not a member of this org unit"));
            if (user.getDeletedAt() != null) {
                return true;
            }
            user.setDeletedAt(Instant.now());
            user.setStatus(UserStatus.DISABLED);
            user.bumpTokenVersion();
            user.bumpSessionVersion();
            users.save(user);
            return false;
        }
        AgentPrincipal principal = principals.findById(memberId).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, "ORG_UNIT_MEMBER_NOT_FOUND",
                "that subject is not a member of this org unit"));
        if (principal.getDisabledAt() != null) {
            return true;
        }
        principal.setDisabledAt(Instant.now());
        principals.save(principal);
        return false;
    }

    private OrgUnitReadRepository.UnitRow requireUnit(String unitIdValue, OrgUnitAccess.Scope scope) {
        UUID unitId = OrgUnitAccess.parseUuid(unitIdValue, "INVALID_ORG_UNIT_ID");
        if (unitId == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ORG_UNIT_ID",
                    "unitId must be a UUID");
        }
        OrgUnitReadRepository.UnitRow unit = units.findUnit(unitId)
                .orElseThrow(OrgUnitAccess::notFound);
        scope.requireWithin(unit.path());
        return unit;
    }

    private static String requireKind(String value) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_MEMBER_KIND",
                    "memberKind is required (human | agent_principal)");
        }
        if (!"human".equals(value) && !"agent_principal".equals(value)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_MEMBER_KIND",
                    "memberKind must be human or agent_principal");
        }
        return value;
    }

    private static UUID requireMemberId(String value) {
        UUID memberId = OrgUnitAccess.parseUuid(value, "INVALID_MEMBER_ID");
        if (memberId == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_MEMBER_ID",
                    "memberId must be a UUID");
        }
        return memberId;
    }
}
