package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * The gates that decide whether a <b>set of role atoms</b> may be written, evaluated from the
 * catalog rather than from a hand-maintained list.
 *
 * <p>PLAN-0673 M1 (privilege escalation): two write paths must agree on the same rules —</p>
 *
 * <ol>
 *   <li><b>role definition update</b> ({@code RoleAdminService}) — a shared role bound in several
 *       scopes must not gain an atom in a scope its author cannot reach;</li>
 *   <li><b>agent role binding</b> ({@code AgentPrincipalRoleBindingService}) — forbidden atoms and
 *       the principal's workspace cap are independent hard gates.</li>
 * </ol>
 *
 * <p>Both gates stay <b>409</b> and never depend on which subset the caller happens to hold: a
 * definition that an agent may never carry is rejected even for a caller holding
 * {@code GRANT_ANY_ATOM} (that bypass only skips the subset judgement, see
 * {@link GrantabilityGuard#assertGrantable}).</p>
 *
 * @author PLAN-0673 M1
 */
@Component
public class AgentBindingAtomPolicy {

    private static final Logger logger = LoggerFactory.getLogger(AgentBindingAtomPolicy.class);

    private final AccessRolePermissionRepository permissions;
    private final GrantabilityGuard grantability;
    private final CapResolver caps;

    public AgentBindingAtomPolicy(AccessRolePermissionRepository permissions,
                                  GrantabilityGuard grantability,
                                  CapResolver caps) {
        this.permissions = permissions;
        this.grantability = grantability;
        this.caps = caps;
    }

    /**
     * The atoms of one role, in catalog order (empty when the role carries none).
     *
     * @param roleId role
     * @return atom names
     */
    public List<String> atomsOf(UUID roleId) {
        List<String> atoms = new ArrayList<>();
        for (AccessRolePermission permission : permissions.findByIdRoleId(roleId)) {
            if (permission.actionClass() != null) {
                atoms.add(permission.actionClass());
            }
        }
        return atoms;
    }

    /** Validate the prospective permission rows (before they have replaced the persisted role). */
    public void assertAgentBindable(Collection<AccessRolePermission> prospective) {
        List<String> forbidden = prospective.stream().map(AccessRolePermission::actionClass)
                .filter(PermissionAtomCatalog.agentPrincipalForbiddenAtoms()::contains)
                .distinct().sorted().toList();
        if (!forbidden.isEmpty()) {
            throw new CpApiException(HttpStatus.CONFLICT, "AGENT_PRINCIPAL_FORBIDDEN_ATOMS",
                    "role carries atoms an agent principal may never hold: "
                            + String.join(",", forbidden));
        }
    }

    /** Validate a prospective permission set against a workspace cap. */
    public void assertWithinCap(UUID principalId, Collection<AccessRolePermission> prospective,
                                UUID workspaceId) {
        if (workspaceId == null) {
            return;
        }
        Set<String> capAtoms = new LinkedHashSet<>();
        JsonNode cap = caps.resolveCapFor(principalId, workspaceId);
        if (cap != null && cap.isArray()) {
            for (JsonNode atom : cap) {
                JsonNode action = atom.get("actionClass");
                if (action != null && action.isTextual()) {
                    capAtoms.add(action.asText());
                }
            }
        }
        Set<String> exceeding = new LinkedHashSet<>();
        prospective.stream().map(AccessRolePermission::actionClass).filter(java.util.Objects::nonNull)
                .filter(atom -> !capAtoms.contains(atom)).forEach(exceeding::add);
        if (!exceeding.isEmpty()) {
            throw new CpApiException(HttpStatus.CONFLICT, "ROLE_BINDING_EXCEEDS_CAP",
                    "role atoms exceed the agent's workspace cap: " + String.join(",", exceeding));
        }
    }

    /**
     * The forbidden atoms of one role, derived from {@link PermissionAtomCatalog} (never a literal
     * list — a catalog change must move this gate by itself).
     *
     * @param roleId role
     * @return forbidden atom names the role currently carries, in catalog order
     */
    public List<String> forbiddenAtomsOf(UUID roleId) {
        Set<String> catalog = PermissionAtomCatalog.agentPrincipalForbiddenAtoms();
        List<String> forbidden = new ArrayList<>();
        for (String atom : atomsOf(roleId)) {
            if (catalog.contains(atom)) {
                forbidden.add(atom);
            }
        }
        return forbidden;
    }

    /**
     * Hard gate: an agent principal may never be handed a forbidden atom. 409, atom names only.
     *
     * @param roleId role being written or bound
     */
    public void assertAgentBindable(UUID roleId) {
        List<String> forbidden = forbiddenAtomsOf(roleId);
        if (!forbidden.isEmpty()) {
            throw new CpApiException(HttpStatus.CONFLICT, "AGENT_PRINCIPAL_FORBIDDEN_ATOMS",
                    "role carries atoms an agent principal may never hold: "
                            + String.join(",", forbidden));
        }
    }

    /**
     * Hard gate: every atom of {@code roleId} must fit the principal's cap in {@code workspaceId}.
     * 409, atom names only. Instance-scope bindings have no workspace cap and pass by construction
     * (same rule as the binding path).
     *
     * @param principalId agent principal
     * @param roleId      role
     * @param workspaceId workspace the cap is resolved for; {@code null} = instance binding
     */
    public void assertWithinCap(UUID principalId, UUID roleId, UUID workspaceId) {
        if (workspaceId == null) {
            return;
        }
        Set<String> capAtoms = new LinkedHashSet<>();
        JsonNode cap = caps.resolveCapFor(principalId, workspaceId);
        if (cap != null && cap.isArray()) {
            for (JsonNode atom : cap) {
                JsonNode actionClass = atom.get("actionClass");
                if (actionClass != null && actionClass.isTextual()) {
                    capAtoms.add(actionClass.asText());
                }
            }
        }
        Set<String> exceeding = new LinkedHashSet<>();
        for (String atom : atomsOf(roleId)) {
            if (!capAtoms.contains(atom)) {
                exceeding.add(atom);
            }
        }
        if (!exceeding.isEmpty()) {
            logger.warn("[POLICY] event=workspace_role_atom_cap_rejected principal={} role={} atoms={}",
                    principalId, roleId, exceeding);
            throw new CpApiException(HttpStatus.CONFLICT, "ROLE_BINDING_EXCEEDS_CAP",
                    "role atoms exceed the agent's workspace cap: " + String.join(",", exceeding));
        }
    }

    /**
     * Subset gate for a role definition change: {@code added} atoms must be held by the caller
     * <b>in every scope the role is already bound in</b>, otherwise the update would materialise
     * them into a workspace (or the instance) the author cannot reach.
     *
     * <p>Only {@code added} is checked, so a reduce-right or a display-only edit never trips this
     * gate. Capability atoms are covered by {@link GrantabilityGuard}'s own capability branch, which
     * resolves them against the caller's capability projection for that exact scope.</p>
     *
     * @param added  atoms the update would newly grant (empty = nothing to check)
     * @param scopes every distinct binding scope of the role; empty = the role is unbound, so the
     *               definition-level (any-scope) judgement already applied by the caller
     */
    public void assertAddedAtomsGrantableInEveryBindingScope(Set<String> added,
                                                             Collection<AccessScope> scopes) {
        if (added == null || added.isEmpty() || scopes == null || scopes.isEmpty()) {
            return;
        }
        for (AccessScope scope : scopes) {
            grantability.assertGrantable(added, scope);
        }
    }

    /**
     * Subset gate over the exact rows an update would write.
     *
     * <p>Capability atoms must be split out before rows are built: {@link
     * GrantIntersectionEvaluator.PermissionAtom} rejects them ({@code Unknown actionClass:
     * workspace:admin}) and they carry no resource to compare anyway. They go to the guard's
     * capability branch, which answers from the caller's capability projection <b>at the same
     * scope</b> — that is the branch the counter-example needs (an author holding
     * {@code workspace:admin} in one workspace must not add it to an instance-bound role).</p>
     */
    public void assertAddedRowsGrantableInEveryBindingScope(
            Collection<AccessRolePermission> added, Collection<AccessScope> scopes) {
        if (added == null || added.isEmpty()) {
            return;
        }
        Set<String> capabilityNames = new LinkedHashSet<>();
        Set<GrantIntersectionEvaluator.PermissionAtom> rows = new LinkedHashSet<>();
        for (AccessRolePermission row : added) {
            if (PermissionAtomCatalog.isCapabilityAtom(row.actionClass())) {
                capabilityNames.add(row.actionClass());
            } else {
                rows.add(new GrantIntersectionEvaluator.PermissionAtom(
                        row.actionClass(), row.resourcePattern()));
            }
        }
        if (scopes == null || scopes.isEmpty()) {
            // Definition level (role currently unbound): judged "held anywhere", resource-aware.
            if (!rows.isEmpty()) {
                grantability.assertGrantableRows(rows, null);
            }
            if (!capabilityNames.isEmpty()) {
                grantability.assertGrantable(capabilityNames, null);
            }
            return;
        }
        for (AccessScope scope : scopes) {
            if (!rows.isEmpty()) {
                grantability.assertGrantableRows(rows, scope);
            }
            if (!capabilityNames.isEmpty()) {
                grantability.assertGrantable(capabilityNames, scope);
            }
        }
    }
}
