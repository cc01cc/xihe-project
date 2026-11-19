package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.repository.OrgUnitGrantRowsRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0773 M2-8b follow-up (task-33): the <b>real</b> {@link OrgUnitGrantSource} — reads
 * {@code org_units} + {@code org_unit_members} + {@code org_unit_role_bindings} instead of
 * answering "nothing" on the placeholder's behalf.
 *
 * <p>The port and every caller stay unchanged: {@code OrgUnitGrants.forPrincipal} asks for one
 * member's rows on every evaluation and still does not know whether they come from a database or a
 * fixture. This class only turns rows into the shape {@link OrgUnitGrantExpander} consumes, and
 * deliberately does <b>not</b> decide which roles count — that judgement lives in
 * {@link OrgUnitGovernancePolicy} and is applied by the expander, so a second copy cannot drift.</p>
 *
 * <p><b>Why the permission array is built here and not in the repository.</b> The array must be
 * byte-identical to what {@code RoleGrantMaterializer} would have written into {@code grants}:
 * capability atoms skipped, unknown atoms refused, resource omitted for the wildcard. Keeping that
 * rule at the policy edge (next to the expander that consumes it) means the rule has one
 * implementation in code and one in the materializer, both visible; putting it in the repository
 * would hide it behind a SQL projection that no test reads directly.</p>
 *
 * <p><b>No caching, ever</b> ({@code M2-10a}, restated by the port): rows are re-read on every call,
 * so moving a member between units changes authority on the next evaluation. There is no field on
 * this class except the two collaborators.</p>
 *
 * <p><b>What replaced the placeholder's WARN.</b> The construct-time
 * {@code event=org_unit_grant_source_pending} line existed to make "wired but fed nothing" loud.
 * Feeding it now makes the warning false, so it is gone; the wiring is observable the honest way —
 * a debug line at construction plus the integration tests that read real rows. Nothing logs on the
 * hot path: an authorization read must not write a log line per evaluation.</p>
 */
@Component
public class JdbcOrgUnitGrantSource implements OrgUnitGrantSource {

    private static final Logger logger = LoggerFactory.getLogger(JdbcOrgUnitGrantSource.class);

    /** No membership, no units, no bindings — the port's legal "holds nothing" answer. */
    private static final OrgUnitGrantExpander.Rows EMPTY =
            new OrgUnitGrantExpander.Rows(List.of(), List.of(), List.of());

    private final OrgUnitGrantRowsRepository rows;
    private final ObjectMapper objectMapper;

    public JdbcOrgUnitGrantSource(OrgUnitGrantRowsRepository rows, ObjectMapper objectMapper) {
        this.rows = rows;
        this.objectMapper = objectMapper;
        logger.debug("[POLICY] event=org_unit_grant_source_wired table=org_unit_role_bindings");
    }

    @Override
    public OrgUnitGrantExpander.Rows rowsFor(OrgUnitGrantExpander.MemberRef member) {
        if (member == null || member.memberKind() == null || member.memberId() == null) {
            return EMPTY;
        }
        List<OrgUnitGrantRowsRepository.UnitRow> chain =
                rows.memberUnitChain(member.memberKind(), member.memberId());
        if (chain.isEmpty()) {
            return EMPTY;
        }
        List<OrgUnitGrantExpander.UnitRow> units = new ArrayList<>(chain.size());
        for (OrgUnitGrantRowsRepository.UnitRow unit : chain) {
            units.add(new OrgUnitGrantExpander.UnitRow(unit.id(), unit.path()));
        }
        List<OrgUnitGrantExpander.MembershipRow> memberships = List.of(
                new OrgUnitGrantExpander.MembershipRow(member.memberKind(), member.memberId(),
                        ownUnitId(chain)));
        return new OrgUnitGrantExpander.Rows(units, memberships, bindings(member));
    }

    /**
     * The member's own unit: the <b>deepest</b> row of the chain.
     *
     * <p>{@code org_unit_members} keys members by {@code (member_kind, member_id)} (V164), so
     * there is exactly one own unit and the chain is exactly its ancestors — "deepest" is that
     * unit, not a tie-break between candidates. The repository orders the chain by
     * {@code depth}, which is what makes the last element the answer.</p>
     */
    private static UUID ownUnitId(List<OrgUnitGrantRowsRepository.UnitRow> chain) {
        return chain.get(chain.size() - 1).id();
    }

    /**
     * Groups the joined {@code (binding, role atom)} rows back into one row per binding, building
     * the permission array with the materialiser's rules.
     */
    private List<OrgUnitGrantExpander.RoleBindingRow> bindings(OrgUnitGrantExpander.MemberRef member) {
        List<OrgUnitGrantRowsRepository.BindingRow> joined =
                rows.bindingsOnMemberChain(member.memberKind(), member.memberId());
        Map<String, List<OrgUnitGrantRowsRepository.BindingRow>> byBinding = new LinkedHashMap<>();
        for (OrgUnitGrantRowsRepository.BindingRow row : joined) {
            byBinding.computeIfAbsent(row.orgUnitId() + "|" + row.roleId(), key -> new ArrayList<>())
                    .add(row);
        }
        List<OrgUnitGrantExpander.RoleBindingRow> bindings = new ArrayList<>(byBinding.size());
        for (List<OrgUnitGrantRowsRepository.BindingRow> sameBinding : byBinding.values()) {
            bindings.add(toBinding(sameBinding));
        }
        return bindings;
    }

    private OrgUnitGrantExpander.RoleBindingRow toBinding(
            List<OrgUnitGrantRowsRepository.BindingRow> sameBinding) {
        OrgUnitGrantRowsRepository.BindingRow first = sameBinding.get(0);
        LinkedHashSet<String> atoms = new LinkedHashSet<>();
        ArrayNode permissions = objectMapper.createArrayNode();
        for (OrgUnitGrantRowsRepository.BindingRow row : sameBinding) {
            if (row.actionClass() == null) {
                // LEFT JOIN: the role has no role_permissions rows at all. An empty array (not
                // "all atoms") is what the expander then drops as a non-governance role.
                continue;
            }
            atoms.add(row.actionClass());
            String resource = materializedResource(row.actionClass(), row.resourcePattern());
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", row.actionClass());
            if (resource != null) {
                atom.put("resource", resource);
            }
            permissions.add(atom);
        }
        return new OrgUnitGrantExpander.RoleBindingRow(first.orgUnitId(), first.roleId(),
                first.roleName(), List.copyOf(atoms), permissions);
    }

    /**
     * The same projection {@code RoleGrantMaterializer.materializableAtom} applies to a
     * {@code role_permissions} row, minus the credential special case (a credential atom can never
     * pass {@link OrgUnitGovernancePolicy}, so the branch would be unreachable here — and an
     * unreachable branch is a claim nobody tests).
     *
     * @return the resource to store, or {@code null} for the wildcard (omitted from the atom)
     * @throws IllegalStateException when the catalog does not know the atom — fail closed rather
     *                               than grant an atom the evaluator would silently drop
     */
    private static String materializedResource(String actionClass, String resourcePattern) {
        if (!PermissionAtomCatalog.isActionAtom(actionClass)) {
            throw new IllegalStateException("Unknown permission atom in role_permissions: " + actionClass);
        }
        PermissionAtomCatalog.requireScopeCompatible(actionClass, OrgUnitGrantExpander.SCOPE_INSTANCE);
        return resourcePattern == null || PermissionAtomCatalog.WILDCARD.equals(resourcePattern)
                ? null : resourcePattern;
    }
}
