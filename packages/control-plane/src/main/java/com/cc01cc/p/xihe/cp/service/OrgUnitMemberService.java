package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.controller.OrgUnitWireView;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0773 M2-11 (batch C) + M2-10b (**G1**): add/move/remove one human or agent in a unit.
 *
 * <p><b>Why the response has to carry {@code affectedWorkspaceIds}.</b> A subject's org-unit
 * membership decides which <i>atoms</i> it holds (design §4.1.1), while its {@code WS_OWNER} bindings
 * are untouched by the move — "the permission follows the person" (§4.6). So a move can silently
 * change what a workspace owner may do, and nothing in {@code role_bindings} records that it
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

    private final OrgUnitReadRepository units;
    private final OrgUnitMemberRepository members;
    private final OrgUnitAccess access;
    private final AuditLogger audit;
    private final ObjectMapper objectMapper;

    public OrgUnitMemberService(OrgUnitReadRepository units, OrgUnitMemberRepository members,
                                OrgUnitAccess access, AuditLogger audit, ObjectMapper objectMapper) {
        this.units = units;
        this.members = members;
        this.access = access;
        this.audit = audit;
        this.objectMapper = objectMapper;
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

    @Transactional
    public void remove(String unitIdValue, String memberIdValue, String memberKindValue) {
        OrgUnitAccess.Scope scope = access.resolve(MANAGE_MEMBERS_ATOM);
        OrgUnitReadRepository.UnitRow unit = requireUnit(unitIdValue, scope);
        String memberKind = requireKind(memberKindValue);
        UUID memberId = requireMemberId(memberIdValue);
        if (!members.remove(memberKind, memberId, unit.id())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "ORG_UNIT_MEMBER_NOT_FOUND",
                    "that subject is not a member of this org unit");
        }
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
