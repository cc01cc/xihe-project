package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.PermissionAtom;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGrantExpander.MemberRef;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGrantExpander.Rows;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGrantExpander.UnitRow;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-33 / Q-11: the org-unit grant source reads the real tables instead of the M1-9 placeholder.
 *
 * <p>This test is the card's evidence, so each method maps to one acceptance clause:</p>
 * <ul>
 *   <li>{@link #theWiredSourceIsTheJdbcOneAndNoPendingPlaceholderIsLeft()} — the bean in the
 *       container is the reader, not a no-op that would keep the whole expansion silently empty;</li>
 *   <li>{@link #aMemberOfNoUnitGetsNoRowsAtAll()} / {@link #theChainIsTheOwnUnitPlusEveryAncestorRootFirst()} /
 *       {@link #aBindingOnADescendantUnitDoesNotReachTheAncestorMember()} — the member → self+ancestors
 *       chain, which is the ltree direction that is easy to get backwards;</li>
 *   <li>{@link #anEmptyOrgTreeLeavesTheAtomSetIdenticalAndKeepsTheSameListInstance()} — the
 *       <b>empty-table equivalence</b> regression: today's atom set is not moved by the rewiring;</li>
 *   <li>{@link #oneBindingAddsExactlyItsGovernanceAtom()} — the positive case: one row in
 *       {@code org_unit_role_bindings} yields exactly one more atom, nothing else;</li>
 *   <li>{@link #thePermissionArrayOmitsTheWildcardAndKeepsAnExplicitResource()} — the permission
 *       JSON the expander consumes, not a re-derived copy of it;</li>
 *   <li>{@link #aNonGovernanceRoleOnTheChainIsDroppedNotHandedToTheEvaluator()} — the reader hands
 *       raw rows to the expander; the governance filter still decides, so a stray row cannot leak
 *       {@code WRITE_WORKSPACE_CONTENT} into every reachable workspace;</li>
 *   <li>{@link #anUnknownPermissionAtomFailsLoudly()} — a role row with an atom the catalog does
 *       not know must fail, not silently shrink the atom set.</li>
 * </ul>
 *
 * <p>Writes go through SQL/entities on purpose: the write face ({@code OrgUnitRoleBindingService})
 * refuses non-governance roles, and a reader test that could only produce legal rows could never
 * show that the filter still works.</p>
 */
class JdbcOrgUnitGrantSourceIntegrationTest extends AbstractIntegrationTest {

    private static final String HUMAN = "human";

    @Autowired
    private OrgUnitGrantSource source;

    @Autowired
    private OrgUnitGrants orgUnitGrants;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private UserRepository users;

    @Autowired
    private AccessRoleRepository roles;

    @Autowired
    private AuthorizationGrantRepository grants;

    @Autowired
    private ObjectMapper objectMapper;

    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();

    private String suffix;
    private UUID member;

    @BeforeEach
    void cleanTables() {
        jdbc.update("DELETE FROM org_unit_role_bindings");
        jdbc.update("DELETE FROM org_unit_members");
        jdbc.update("DELETE FROM org_units");
        suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        member = insertUser("member");
    }

    @Test
    void theWiredSourceIsTheJdbcOneAndNoPendingPlaceholderIsLeft() {
        assertInstanceOf(JdbcOrgUnitGrantSource.class, source,
                "Q-11 replaced the M1-9 placeholder: a no-op bean here makes every org grant vanish"
                        + " while every other test still passes");
    }

    @Test
    void aMemberOfNoUnitGetsNoRowsAtAll() {
        Rows rows = source.rowsFor(new MemberRef(HUMAN, member));

        assertTrue(rows.units().isEmpty(), "no membership row means no chain");
        assertTrue(rows.members().isEmpty());
        assertTrue(rows.bindings().isEmpty());
        assertTrue(orgUnitGrants.forPrincipal(GrantPrincipalPathResolver.USER, member).isEmpty(),
                "and the whole expansion stays empty, which is the legal answer (M2-10a)");
    }

    @Test
    void theChainIsTheOwnUnitPlusEveryAncestorRootFirst() {
        UUID root = insertUnit(null, "root", null, 0);
        UUID middle = insertUnit(root, "middle", pathOf(root), 1);
        UUID leaf = insertUnit(middle, "leaf", pathOf(middle), 2);
        insertMembership(leaf, HUMAN, member);
        bind(root, insertRole(Map.of(OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS, "*")));

        Rows rows = source.rowsFor(new MemberRef(HUMAN, member));

        List<UUID> chain = rows.units().stream().map(UnitRow::id).toList();
        assertEquals(List.of(root, middle, leaf), chain,
                "depth ascending: root first, the member's own unit last");
        assertEquals(1, rows.members().size());
        assertEquals(leaf, rows.members().getFirst().orgUnitId(),
                "the membership row names the member's own unit, not the root");
        assertEquals(1, rows.bindings().size(),
                "the root's binding is on the chain and therefore reaches the leaf member");
    }

    @Test
    void aBindingOnADescendantUnitDoesNotReachTheAncestorMember() {
        UUID root = insertUnit(null, "root", null, 0);
        UUID child = insertUnit(root, "child", pathOf(root), 1);
        insertMembership(root, HUMAN, member);
        bind(child, insertRole(Map.of(OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS, "*")));

        Rows rows = source.rowsFor(new MemberRef(HUMAN, member));

        assertEquals(List.of(root), rows.units().stream().map(UnitRow::id).toList());
        assertTrue(rows.bindings().isEmpty(),
                "a member of a.b must not inherit a.b.c's bindings — the reverse of the ltree"
                        + " direction would hand out the whole subtree");
        assertTrue(orgUnitGrants.forPrincipal(GrantPrincipalPathResolver.USER, member).isEmpty());
    }

    @Test
    void anEmptyOrgTreeLeavesTheAtomSetIdenticalAndKeepsTheSameListInstance() {
        grantInstanceAtom(ToolFaceRegistry.ACTION_READ);
        grantInstanceAtom(ToolFaceRegistry.ACTION_WRITE);

        List<AuthorizationGrant> scoped =
                grants.findScopedGrants(GrantPrincipalPathResolver.USER, member,
                        GrantSources.EVALUATION_SOURCES, null);
        assertFalse(scoped.isEmpty(), "the fixture must produce a non-empty baseline");
        Set<PermissionAtom> before = evaluator.union(scoped);

        var expanded = orgUnitGrants.forPrincipal(GrantPrincipalPathResolver.USER, member);
        assertTrue(expanded.isEmpty(), "no unit, no membership, no binding — nothing to expand");

        List<AuthorizationGrant> merged = OrgUnitGrants.merge(scoped, expanded);
        assertSame(scoped, merged,
                "merge returns the caller's own list when the expansion is empty: the rewiring"
                        + " cannot even reorder the atom set");
        assertEquals(before, evaluator.union(merged));
        assertEquals(scoped.size(), merged.size());
    }

    @Test
    void oneBindingAddsExactlyItsGovernanceAtom() {
        UUID unit = insertUnit(null, "unit", null, 0);
        insertMembership(unit, HUMAN, member);
        grantInstanceAtom(ToolFaceRegistry.ACTION_READ);

        List<AuthorizationGrant> scoped =
                grants.findScopedGrants(GrantPrincipalPathResolver.USER, member,
                        GrantSources.EVALUATION_SOURCES, null);
        Set<PermissionAtom> before = evaluator.union(scoped);

        UUID role = insertRole(Map.of(OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNIT_MEMBERS, "*"));
        bind(unit, role);

        var expanded = orgUnitGrants.forPrincipal(GrantPrincipalPathResolver.USER, member);
        assertEquals(1, expanded.size(), "one binding on the chain is one expanded grant");
        AuthorizationGrant expandedGrant = expanded.iterator().next();
        assertEquals(OrgUnitGrantExpander.SCOPE_INSTANCE, expandedGrant.getScopeType(),
                "a group grant has no location: it only adds atoms to a subject");
        assertNull(expandedGrant.getId(), "and it is never persisted");

        Set<PermissionAtom> after = evaluator.union(OrgUnitGrants.merge(scoped, expanded));
        Set<PermissionAtom> added = new LinkedHashSet<>(after);
        added.removeAll(before);
        Set<PermissionAtom> removed = new LinkedHashSet<>(before);
        removed.removeAll(after);

        assertEquals(Set.of(new PermissionAtom(OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNIT_MEMBERS, "*")),
                added, "exactly the bound atom appears, with the wildcard spelled the way parse() does");
        assertTrue(removed.isEmpty(), "nothing the scoped grants gave is taken away");
    }

    @Test
    void thePermissionArrayOmitsTheWildcardAndKeepsAnExplicitResource() {
        UUID unit = insertUnit(null, "unit", null, 0);
        insertMembership(unit, HUMAN, member);
        Map<String, String> atoms = new LinkedHashMap<>();
        atoms.put(OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS, "*");
        atoms.put(OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS, "org:unit:*");
        bind(unit, insertRole(atoms));

        Rows rows = source.rowsFor(new MemberRef(HUMAN, member));

        assertEquals(1, rows.bindings().size());
        var binding = rows.bindings().getFirst();
        assertEquals(roleNameOf(unit), binding.roleName(), "the role name travels with the rows");
        assertEquals(List.of(OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS,
                OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS), binding.atoms());

        ArrayNode permissions = (ArrayNode) binding.permissions();
        assertEquals(2, permissions.size());
        Map<String, String> resourceByAtom = new LinkedHashMap<>();
        for (var node : permissions) {
            ObjectNode permission = (ObjectNode) node;
            resourceByAtom.put(permission.get("actionClass").asText(),
                    permission.has("resource") ? permission.get("resource").asText() : "<absent>");
        }
        assertEquals("<absent>", resourceByAtom.get(OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS),
                "a '*' pattern is written as no resource at all, exactly what parse() turns back"
                        + " into the wildcard");
        assertEquals("org:unit:*", resourceByAtom.get(OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS));
    }

    @Test
    void aNonGovernanceRoleOnTheChainIsDroppedNotHandedToTheEvaluator() {
        UUID unit = insertUnit(null, "unit", null, 0);
        insertMembership(unit, HUMAN, member);
        // Inserted straight into the table: the write face would refuse this role, so the row can
        // only exist through a manual write — which is exactly the case the filter must survive.
        bind(unit, insertRole(Map.of("WRITE_WORKSPACE_CONTENT", "*")));

        Rows rows = source.rowsFor(new MemberRef(HUMAN, member));
        assertEquals(1, rows.bindings().size(), "the reader reports what the table says");

        assertTrue(orgUnitGrants.forPrincipal(GrantPrincipalPathResolver.USER, member).isEmpty(),
                "the expansion still drops it: an instance-scope atom reaches every workspace the"
                        + " member can see, so a non-governance role must never be projected");
    }

    @Test
    void anUnknownPermissionAtomFailsLoudly() {
        UUID unit = insertUnit(null, "unit", null, 0);
        insertMembership(unit, HUMAN, member);
        bind(unit, insertRole(Map.of("NO_SUCH_ATOM_XYZ", "*")));

        IllegalStateException refused = assertThrows(IllegalStateException.class,
                () -> source.rowsFor(new MemberRef(HUMAN, member)));
        assertTrue(refused.getMessage().contains("NO_SUCH_ATOM_XYZ"),
                "the failure names the atom: a silently skipped row would shrink the atom set"
                        + " without a single test noticing, was " + refused.getMessage());
    }

    // ------------------------------------------------------------------ fixtures

    private UUID insertUnit(UUID parentId, String name, String parentPath, int depth) {
        UUID id = UUID.randomUUID();
        String path = parentPath == null ? label(id) : parentPath + "." + label(id);
        jdbc.update("INSERT INTO org_units (id, parent_id, name, path, depth)"
                + " VALUES (?, ?, ?, ?::ltree, ?)", id, parentId, name, path, depth);
        return id;
    }

    private void insertMembership(UUID unitId, String memberKind, UUID memberId) {
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, ?, ?)", unitId, memberKind, memberId);
    }

    private UUID insertRole(Map<String, String> atomToPattern) {
        String name = "ORG_GOV_" + suffix.toUpperCase() + "_" + UUID.randomUUID().toString()
                .replace("-", "").substring(0, 6).toUpperCase();
        AccessRole role = new AccessRole();
        role.setName(name);
        role.setDisplayName(name);
        role.setSystem(false);
        role = roles.saveAndFlush(role);
        for (Map.Entry<String, String> entry : atomToPattern.entrySet()) {
            jdbc.update("INSERT INTO role_permissions (role_id, action_class, resource_pattern)"
                    + " VALUES (?, ?, ?)", role.getId(), entry.getKey(), entry.getValue());
        }
        return role.getId();
    }

    private void bind(UUID unitId, UUID roleId) {
        jdbc.update("INSERT INTO org_unit_role_bindings (id, org_unit_id, role_id, granted_by)"
                + " VALUES (?, ?, ?, ?)", UUID.randomUUID(), unitId, roleId, member);
    }

    private String roleNameOf(UUID unitId) {
        return jdbc.queryForObject("SELECT r.name FROM org_unit_role_bindings b"
                + " JOIN roles r ON r.id = b.role_id WHERE b.org_unit_id = ?", String.class, unitId);
    }

    private void grantInstanceAtom(String actionClass) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType(GrantPrincipalPathResolver.USER);
        grant.setGranterId(member);
        grant.setSubjectType(GrantPrincipalPathResolver.USER);
        grant.setSubjectId(member);
        grant.setSource(GrantSources.ROLE);
        grant.setScopeType("instance");
        grant.setReadState("read");
        ArrayNode permissions = objectMapper.createArrayNode();
        permissions.addObject().put("actionClass", actionClass);
        grant.setPermissions(permissions);
        grants.saveAndFlush(grant);
    }

    private UUID insertUser(String handle) {
        String unique = handle + "-" + suffix;
        User user = new User();
        user.setEmail(unique + "@org-unit-grant-source.test");
        user.setUsername(unique);
        user.setPasswordHash("x");
        user.setName(unique);
        return users.save(user).getId();
    }

    private String label(UUID id) {
        return "n" + id.toString().replace("-", "");
    }

    private String pathOf(UUID unitId) {
        return jdbc.queryForObject("SELECT path::text FROM org_units WHERE id = ?", String.class, unitId);
    }
}
