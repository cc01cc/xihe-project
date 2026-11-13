package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M2-8a: the org-unit group expander, the five cases {@code tasks.md:103} names.
 *
 * <p><b>Evidence level, stated up front.</b> These are function-level tests over the in-memory row
 * shapes ({@code org_units} / {@code org_unit_members} / {@code org_unit_role_bindings}): the card
 * is DB-free on purpose, so no table is touched here and the expander has no persistence
 * collaborator to call. "Not persisted" is therefore asserted <i>positively</i> — every expanded
 * row has {@code id == null}, and {@code AuthorizationGrant.onCreate()} is the only thing that
 * fills that field ({@code @PrePersist}) — rather than by counting rows in a table this test never
 * opens. The real-insert arm belongs to {@code M2-8c}, which owns the write side.</p>
 *
 * <p>Two of the five cases are the ones that are easy to get wrong, so they get extra assertions:
 * <b>ancestors are a union</b> (a binding two levels up must survive <i>and</i> a descendant's
 * binding must not — the ltree direction), and <b>non-governance roles</b> are the same judgement
 * the write side uses, tested in both arms (filtered by default, refused with a readable
 * {@code 409} in strict mode).</p>
 */
class OrgUnitGrantExpanderTest {

    private static final JsonNode READ_ATOMS = atoms("READ_ORG_UNIT_MEMBERS");
    private static final JsonNode MANAGE_ATOMS = atoms("MANAGE_ORG_UNITS", "MANAGE_ORG_UNIT_MEMBERS");

    private static final UUID ROOT = UUID.fromString("00000000-0000-4000-8000-0000000000b0");
    private static final UUID UNIT_A = UUID.fromString("00000000-0000-4000-8000-0000000000a0");
    private static final UUID UNIT_B = UUID.fromString("00000000-0000-4000-8000-0000000000b1");
    private static final UUID UNIT_C = UUID.fromString("00000000-0000-4000-8000-0000000000c1");
    private static final UUID UNIT_D = UUID.fromString("00000000-0000-4000-8000-0000000000d1");

    private static final UUID USER = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID OTHER_USER = UUID.fromString("99999999-9999-4999-8999-999999999999");
    private static final UUID ROLE_LEADER_ROOT = UUID.fromString("22222222-2222-4222-8222-222222222221");
    private static final UUID ROLE_LEADER_A = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID ROLE_MEMBER_B = UUID.fromString("22222222-2222-4222-8222-222222222223");
    private static final UUID ROLE_CONTENT = UUID.fromString("22222222-2222-4222-8222-222222222224");
    private static final UUID ROLE_DESCENDANT = UUID.fromString("22222222-2222-4222-8222-222222222225");
    private static final UUID ROLE_SIBLING = UUID.fromString("22222222-2222-4222-8222-222222222226");

    private final OrgUnitGrantExpander expander = new OrgUnitGrantExpander();

    private static JsonNode atoms(String... actionClasses) {
        var array = JsonNodeFactory.instance.arrayNode();
        for (String actionClass : actionClasses) {
            array.addObject().put("actionClass", actionClass).put("resource", "*");
        }
        return array;
    }

    /** The tree used by most cases: {@code root → a → b → c}, plus a sibling {@code root.d}. */
    private static List<OrgUnitGrantExpander.UnitRow> tree() {
        return List.of(
                new OrgUnitGrantExpander.UnitRow(ROOT, "root"),
                new OrgUnitGrantExpander.UnitRow(UNIT_A, "root.a"),
                new OrgUnitGrantExpander.UnitRow(UNIT_B, "root.a.b"),
                new OrgUnitGrantExpander.UnitRow(UNIT_C, "root.a.b.c"),
                new OrgUnitGrantExpander.UnitRow(UNIT_D, "root.d"));
    }

    private static List<OrgUnitGrantExpander.MembershipRow> memberOf(UUID unitId) {
        return List.of(new OrgUnitGrantExpander.MembershipRow(
                OrgUnitGrantExpander.MEMBER_HUMAN, USER, unitId));
    }

    private static OrgUnitGrantExpander.RoleBindingRow binding(UUID unitId, UUID roleId, String roleName,
                                                              JsonNode permissions, String... atomNames) {
        return new OrgUnitGrantExpander.RoleBindingRow(unitId, roleId, roleName, List.of(atomNames), permissions);
    }

    private static OrgUnitGrantExpander.MemberRef user() {
        return new OrgUnitGrantExpander.MemberRef(OrgUnitGrantExpander.MEMBER_HUMAN, USER);
    }

    /** Case 1: one binding on the member's own unit ⇒ exactly one row. */
    @Test
    void oneBindingYieldsExactlyOneInstanceGrant() {
        List<AuthorizationGrant> grants = expander.expand(user(), new OrgUnitGrantExpander.Rows(
                tree(),
                memberOf(UNIT_A),
                List.of(binding(UNIT_A, ROLE_LEADER_A, "ORG_LEADER_A", MANAGE_ATOMS,
                        "MANAGE_ORG_UNITS", "MANAGE_ORG_UNIT_MEMBERS"))));

        assertEquals(1, grants.size(), "one binding on the member's own unit must yield exactly one row");
        AuthorizationGrant grant = grants.get(0);
        assertEquals(OrgUnitGrantExpander.SCOPE_INSTANCE, grant.getScopeType(),
                "§4.1.1: the only legal projection is instance");
        assertNull(grant.getScopeId(), "V87 CHECK: an instance row carries no scope id");
        assertEquals("user", grant.getSubjectType(), "a human member becomes a user subject");
        assertEquals(USER, grant.getSubjectId());
        assertEquals("ORG_LEADER_A", grant.getRoleName());
        assertEquals(MANAGE_ATOMS, grant.getPermissions());
        assertNull(grant.getId(), "never persisted: @PrePersist is the only writer of id");
    }

    /** Case 2: the member belongs to no unit ⇒ nothing, not "everything". */
    @Test
    void memberOfNoUnitYieldsNothing() {
        List<AuthorizationGrant> grants = expander.expand(user(), new OrgUnitGrantExpander.Rows(
                tree(),
                List.of(),
                List.of(binding(UNIT_A, ROLE_LEADER_A, "ORG_LEADER_A", MANAGE_ATOMS, "MANAGE_ORG_UNITS"))));

        assertTrue(grants.isEmpty(), "no org_unit_members row must expand to zero rows, not to a wildcard");

        // A membership row of a *different* member must not be mistaken for this one.
        List<AuthorizationGrant> other = expander.expand(user(), new OrgUnitGrantExpander.Rows(
                tree(),
                List.of(new OrgUnitGrantExpander.MembershipRow(
                        OrgUnitGrantExpander.MEMBER_HUMAN, OTHER_USER, UNIT_A)),
                List.of(binding(UNIT_A, ROLE_LEADER_A, "ORG_LEADER_A", MANAGE_ATOMS, "MANAGE_ORG_UNITS"))));
        assertTrue(other.isEmpty(), "someone else's membership row must not expand for this member");
    }

    /**
     * Case 3: <b>multi-level ancestors are a union</b> — every level that carries a binding
     * contributes, and nothing from outside the ancestor chain does.
     *
     * <p>The negative halves are the point: {@code c} is a <i>descendant</i> of {@code b} and
     * {@code d} is a sibling, so neither may contribute. ltree agrees: {@code 'root.a.b' <@
     * 'root.a.b.c'} is false — ancestors are the path's prefixes, not its subtree.</p>
     */
    @Test
    void ancestorBindingsAreUnionedAcrossEveryLevel() {
        List<AuthorizationGrant> grants = expander.expand(user(), new OrgUnitGrantExpander.Rows(
                tree(),
                memberOf(UNIT_B),
                List.of(
                        binding(ROOT, ROLE_LEADER_ROOT, "ORG_LEADER_ROOT", READ_ATOMS, "READ_ORG_UNIT_MEMBERS"),
                        binding(UNIT_A, ROLE_LEADER_A, "ORG_LEADER_A", MANAGE_ATOMS, "MANAGE_ORG_UNITS"),
                        binding(UNIT_B, ROLE_MEMBER_B, "MEMBER_B", READ_ATOMS, "READ_ORG_UNIT_MEMBERS"),
                        binding(UNIT_C, ROLE_DESCENDANT, "DESCENDANT_C", READ_ATOMS, "READ_ORG_UNIT_MEMBERS"),
                        binding(UNIT_D, ROLE_SIBLING, "SIBLING_D", READ_ATOMS, "READ_ORG_UNIT_MEMBERS"))));

        Set<String> roles = grants.stream().map(AuthorizationGrant::getRoleName).collect(Collectors.toSet());
        assertEquals(Set.of("ORG_LEADER_ROOT", "ORG_LEADER_A", "MEMBER_B"), roles,
                "every ancestor level must contribute (union); nearest-level-only and intersection are both wrong");
        assertEquals(3, grants.size(), "the descendent unit c and the sibling unit d must not contribute");
        assertFalse(roles.contains("DESCENDANT_C"),
                "a descendant's binding must not travel upwards (ltree: 'root.a.b' <@ 'root.a.b.c' is false)");
        assertFalse(roles.contains("SIBLING_D"), "a sibling unit's binding is not on the ancestor chain");
        grants.forEach(grant -> assertEquals(OrgUnitGrantExpander.SCOPE_INSTANCE, grant.getScopeType()));
    }

    /**
     * The direction itself, at the function that implements it: the chain of {@code root.a.b} is
     * {@code [root, root.a, root.a.b]} — its prefixes — and never contains a descendant.
     */
    @Test
    void ancestorPathsArePrefixesNotSubtrees() {
        assertEquals(List.of("root", "root.a", "root.a.b"),
                OrgUnitGrantExpander.ancestorPaths("root.a.b"),
                "ancestors are the path's prefixes (root first), self included");
        assertFalse(OrgUnitGrantExpander.ancestorPaths("root.a.b").contains("root.a.b.c"),
                "ltree '<@' is descendant-or-self: 'root.a.b' <@ 'root.a.b.c' is false, so c is not an ancestor of b");
        assertEquals(List.of("root"), OrgUnitGrantExpander.ancestorPaths("root"));
        assertThrows(IllegalArgumentException.class, () -> OrgUnitGrantExpander.ancestorPaths(" "));
    }

    /** Case 4: the member's chain carries no binding ⇒ zero rows. */
    @Test
    void emptyBindingsYieldNothing() {
        assertTrue(expander.expand(user(), new OrgUnitGrantExpander.Rows(
                tree(), memberOf(UNIT_B), List.of())).isEmpty(), "no bindings at all ⇒ zero rows");

        assertTrue(expander.expand(user(), new OrgUnitGrantExpander.Rows(
                tree(), memberOf(UNIT_B),
                List.of(binding(UNIT_D, ROLE_SIBLING, "SIBLING_D", READ_ATOMS, "READ_ORG_UNIT_MEMBERS")))).isEmpty(),
                "bindings that exist but sit off the chain ⇒ zero rows");
    }

    /**
     * Case 5, arm A (filter): a binding whose role carries a non-governance atom is dropped, so it
     * cannot reach evaluation — the row grants nothing rather than everything.
     *
     * <p>{@code EXEC} is a real catalog atom (scope class {@code both}), not an invented string: the
     * danger is precisely that a workspace-executable atom would become instance-wide.</p>
     */
    @Test
    void nonGovernanceRoleIsFilteredOut() {
        List<AuthorizationGrant> grants = expander.expand(user(), new OrgUnitGrantExpander.Rows(
                tree(),
                memberOf(UNIT_A),
                List.of(binding(UNIT_A, ROLE_CONTENT, "CONTENT_EDITOR",
                        atoms("READ_ORG_UNIT_MEMBERS", ToolFaceRegistry.ACTION_EXEC),
                        OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS, ToolFaceRegistry.ACTION_EXEC))));

        assertTrue(grants.isEmpty(),
                "a role with a non-governance atom must be filtered out, not projected as instance");

        // Mixing: the governance binding on the same unit still expands — one bad row is dropped,
        // it does not poison the whole chain (that would turn a filter into an outage).
        List<AuthorizationGrant> mixed = expander.expand(user(), new OrgUnitGrantExpander.Rows(
                tree(),
                memberOf(UNIT_A),
                List.of(binding(UNIT_A, ROLE_CONTENT, "CONTENT_EDITOR",
                                atoms("READ_ORG_UNIT_MEMBERS", ToolFaceRegistry.ACTION_EXEC),
                                OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS, ToolFaceRegistry.ACTION_EXEC),
                        binding(UNIT_A, ROLE_LEADER_A, "ORG_LEADER_A", MANAGE_ATOMS, "MANAGE_ORG_UNITS"))));
        assertEquals(1, mixed.size(), "only the governance binding survives the filter");
        assertEquals("ORG_LEADER_A", mixed.get(0).getRoleName());
    }

    /**
     * Case 5, arm B (refuse): the strict policy raises the write side's own {@code 409}, and the
     * message names <b>both</b> the role and the offending atom — "one of your roles is not allowed"
     * is not something an operator can act on.
     */
    @Test
    void nonGovernanceRoleIsRefusedWithReadableMessage() {
        OrgUnitGrantExpander.Rows rows = new OrgUnitGrantExpander.Rows(
                tree(),
                memberOf(UNIT_A),
                List.of(binding(UNIT_A, ROLE_CONTENT, "CONTENT_EDITOR",
                        atoms("READ_ORG_UNIT_MEMBERS", ToolFaceRegistry.ACTION_EXEC),
                        OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS, ToolFaceRegistry.ACTION_EXEC)));

        CpApiException refused = assertThrows(CpApiException.class, () -> expander.expand(user(), rows,
                OrgUnitGrantExpander.NonGovernanceRolePolicy.STRICT));

        assertEquals(HttpStatus.CONFLICT, refused.getStatus(), "same status the write side answers");
        assertEquals(OrgUnitGovernancePolicy.CODE_FORBIDDEN, refused.getCode(), "same code, same judgement");
        assertTrue(refused.getMessage().contains("CONTENT_EDITOR"),
                "the refusal must name the role: " + refused.getMessage());
        assertTrue(refused.getMessage().contains(ToolFaceRegistry.ACTION_EXEC),
                "the refusal must name the offending atom: " + refused.getMessage());
    }

    /**
     * The card's hard assertion, made positively: the expander has no persistence collaborator and
     * hands back transient rows. {@code AuthorizationGrant} fills {@code id}/{@code createdAt} in
     * {@code @PrePersist}, so a non-null id would prove a write went through JPA.
     */
    @Test
    void expandedRowsAreTransientAndTheExpanderCannotPersist() {
        assertEquals(0, OrgUnitGrantExpander.class.getDeclaredConstructors()[0].getParameterCount(),
                "no repository / EntityManager / materializer may be injected: this class cannot write");
        assertTrue(Arrays.stream(OrgUnitGrantExpander.class.getDeclaredMethods())
                        .noneMatch(method -> method.toString().matches(".*(Repository|EntityManager|Materializer).*")),
                "no method may take or return a persistence collaborator");

        List<AuthorizationGrant> grants = expander.expand(user(), new OrgUnitGrantExpander.Rows(
                tree(),
                memberOf(UNIT_B),
                List.of(binding(ROOT, ROLE_LEADER_ROOT, "ORG_LEADER_ROOT", READ_ATOMS, "READ_ORG_UNIT_MEMBERS"),
                        binding(UNIT_A, ROLE_LEADER_A, "ORG_LEADER_A", MANAGE_ATOMS, "MANAGE_ORG_UNITS"))));

        assertEquals(2, grants.size());
        for (AuthorizationGrant grant : grants) {
            assertNull(grant.getId(), "an id here would prove JPA ran; the card requires 未落库");
            assertNull(grant.getCreatedAt(), "createdAt is set by @PrePersist only");
        }
    }
}
