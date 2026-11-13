package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.controller.OrgUnitWireView;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGovernancePolicy;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitRoleBindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

/**
 * PLAN-0773 M2-11 (task-246): replace an org unit's role bindings as one set.
 *
 * <p><b>Order of refusals, again.</b> Scope/atom come from {@link OrgUnitAccess} (a non-member is a
 * 404, not a 403); then every requested role passes {@link OrgUnitGovernancePolicy} <b>before the
 * first write</b> — a refused replace must leave both the binding rows and the audit count
 * untouched. Only then are rows rebuilt and the audit written, in the same transaction.</p>
 *
 * <p>The audit (`org_role_bindings_changed`) names the group principal (the unit's subtree) and
 * the union of `WS_OWNER` workspaces held by the subtree's members — the same G1 question a move
 * answers, asked here because binding a role changes what every current (and future) member may
 * do, and nothing in the row itself records whose workspaces that touched.</p>
 */
@Service
public class OrgUnitRoleBindingService {

    public static final String AUDIT_EVENT = "org_role_bindings_changed";

    private final OrgUnitReadRepository units;
    private final OrgUnitRoleBindingRepository bindings;
    private final OrgUnitMemberRepository members;
    private final org.springframework.jdbc.core.JdbcTemplate jdbc;
    private final OrgUnitAccess access;
    private final AuditLogger audit;
    private final ObjectMapper objectMapper;

    public OrgUnitRoleBindingService(OrgUnitReadRepository units,
                                     OrgUnitRoleBindingRepository bindings,
                                     OrgUnitMemberRepository members,
                                     OrgUnitAccess access, AuditLogger audit,
                                     ObjectMapper objectMapper,
                                     org.springframework.jdbc.core.JdbcTemplate jdbc) {
        this.units = units;
        this.bindings = bindings;
        this.members = members;
        this.access = access;
        this.audit = audit;
        this.objectMapper = objectMapper;
        this.jdbc = jdbc;
    }

    @Transactional
    public OrgUnitWireView.RoleBindings replace(String unitIdValue, List<String> roleIdValues) {
        OrgUnitAccess.Scope scope = access.resolve(OrgUnitWriteService.MANAGE_ATOM);
        UUID unitId = OrgUnitAccess.parseUuid(unitIdValue, "INVALID_ORG_UNIT_ID");
        if (unitId == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ORG_UNIT_ID",
                    "unitId must be a UUID");
        }
        OrgUnitReadRepository.UnitRow unit = units.findUnit(unitId)
                .orElseThrow(OrgUnitAccess::notFound);
        scope.requireWithin(unit.path());

        if (roleIdValues == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE_IDS",
                    "roleIds is required (an empty array clears the set)");
        }
        // Refuse before the first write: rows and audit count must both be untouched on 409.
        Set<UUID> requested = new LinkedHashSet<>();
        for (String value : roleIdValues) {
            UUID roleId = OrgUnitAccess.parseUuid(value, "INVALID_ROLE_ID");
            if (roleId == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE_ID",
                        "roleIds entries must be UUIDs");
            }
            requested.add(roleId);
        }
        // The judgement itself is the pre-existing static policy (D-1118, landed by the M1-9
        // lane): whitelist over the role's atom names, single definition, evaluation side
        // re-applies it on every read. This service only resolves role -> atoms and refuses
        // unknown roles on the same 409 path (unknown is not empty).
        for (UUID roleId : requested) {
            List<String> roleNames = jdbc.queryForList("SELECT name FROM roles WHERE id = ?",
                    String.class, roleId);
            if (roleNames.isEmpty()) {
                throw new CpApiException(HttpStatus.CONFLICT,
                        OrgUnitGovernancePolicy.CODE_FORBIDDEN,
                        "unknown role " + roleId + ": not empty, so not clearable-by-emptiness");
            }
            OrgUnitGovernancePolicy.requireGovernanceRole(roleNames.get(0),
                    jdbc.queryForList("SELECT action_class FROM role_permissions WHERE role_id = ?",
                            String.class, roleId));
        }

        UUID caller = access.currentSubjectId();
        bindings.replace(unit.id(), List.copyOf(requested), caller);

        Set<UUID> affected = new TreeSet<>();
        for (OrgUnitReadRepository.MemberRow member : units.findMembers(unit.id(), unit.path(), true)) {
            affected.addAll(members.ownedWorkspaceIds(member.memberKind(), member.memberId()));
        }

        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("unitId", unit.id().toString());
        detail.put("principalId", unit.id().toString());
        var rolesNode = detail.putArray("roleIds");
        List.copyOf(requested).stream().map(UUID::toString).forEach(rolesNode::add);
        var affectedNode = detail.putArray("affectedWorkspaceIds");
        affected.stream().map(UUID::toString).forEach(affectedNode::add);
        audit.recordDurableChange(access.currentActorId(), null, AUDIT_EVENT, "org_unit_role_binding",
                unit.id().toString(), detail.toString());

        return new OrgUnitWireView.RoleBindings(bindings.findRoleIds(unit.id()));
    }
}
