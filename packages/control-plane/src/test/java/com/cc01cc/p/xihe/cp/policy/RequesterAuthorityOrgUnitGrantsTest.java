package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0773 M2-8b: <b>all four evaluation reads</b> in {@link RequesterAuthority} see the subject's
 * org-unit grants, and see nothing when the row is not a governance one.
 *
 * <p><b>Why four assertions and not one.</b> The failure mode is a <i>missed site</i>
 * ({@code tasks.md:106}: forgetting one means silently granting less — a 403 for somebody who
 * should pass). A test that only exercised {@code actionAtoms} would stay green while
 * {@code atomSources} answered from the pre-M2-8b rows; so each of the four public reads is
 * asserted separately, and the wiring itself is a single private method
 * ({@code withOrgUnitGrants}) counted by grep.</p>
 *
 * <p><b>Fixture shape.</b> The scoped repository answers empty on purpose: every atom in these
 * tests comes from the org-unit path, so a green assertion cannot be the old rows leaking through.
 * The binding rows are fed through a real {@link OrgUnitGrantExpander} (not a hand-built grant),
 * which is what keeps this test honest — if the expander stopped projecting {@code instance} rows
 * or format, the assertions here would fail too.</p>
 */
class RequesterAuthorityOrgUnitGrantsTest {

    private static final UUID USER = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID AGENT = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    private static final UUID UNIT = UUID.fromString("00000000-0000-4000-8000-0000000000a0");
    private static final UUID ROLE = UUID.fromString("22222222-2222-4222-8222-222222222221");
    private static final UUID WORKSPACE = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final ObjectMapper JSON = new ObjectMapper();

    private RequesterAuthority authority;

    /** Wires the read points with one unit and the given bindings; the scoped repo answers empty. */
    private void wire(String memberKind, UUID memberId, OrgUnitGrantExpander.RoleBindingRow... bindings) {
        AuthorizationGrantRepository scoped = mock(AuthorizationGrantRepository.class);
        when(scoped.findScopedGrants(any(), any(), any(), any()))
                .thenReturn(List.<AuthorizationGrant>of());
        OrgUnitGrantSource source = member -> new OrgUnitGrantExpander.Rows(
                List.of(new OrgUnitGrantExpander.UnitRow(UNIT, "root")),
                List.of(new OrgUnitGrantExpander.MembershipRow(memberKind, memberId, UNIT)),
                List.of(bindings));
        authority = new RequesterAuthority(scoped, new GrantIntersectionEvaluator(),
                mock(AuthzContext.class), new OrgUnitGrants(new OrgUnitGrantExpander(), source));
    }

    private static OrgUnitGrantExpander.RoleBindingRow governanceBinding(String roleName, String atom,
                                                                        String resource) {
        return new OrgUnitGrantExpander.RoleBindingRow(UNIT, ROLE, roleName, List.of(atom), permissions(atom, resource));
    }

    private static com.fasterxml.jackson.databind.JsonNode permissions(String atom, String resource) {
        var array = JSON.createArrayNode();
        array.addObject().put("actionClass", atom).put("resource", resource);
        return array;
    }

    private static PolicyRequest request(String atom, String resource) {
        return new PolicyRequest(atom.toLowerCase(), List.of(atom), List.of(resource),
                ToolShape.OPAQUE, USER.toString(), null, null);
    }

    /**
     * Site 1..4 in one test with four separate assertions: {@code allowsForUser}, {@code actionAtoms},
     * {@code atomSources}, {@code actionPermissions} each have to answer "yes" from the expansion.
     */
    @Test
    void everyReadPointSeesTheOrgUnitGrant() {
        wire(OrgUnitGrantExpander.MEMBER_HUMAN, USER,
                governanceBinding("ORG_LEADER", ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS, "*"));

        assertTrue(authority.allowsForUser(
                        request(ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS, "*"), WORKSPACE),
                "site 1 allowsForUser: an org-unit governance grant must authorize");
        assertTrue(authority.actionAtoms(USER, WORKSPACE).contains(ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS),
                "site 2 actionAtoms: the atom must appear");
        assertEquals(Set.of(OrgUnitGrantExpander.SOURCE),
                authority.atomSources(USER, ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS, WORKSPACE),
                "site 3 atomSources: the source must be org_unit, not role");
        assertTrue(authority.actionPermissions(USER, WORKSPACE).stream()
                        .anyMatch(atom -> ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS.equals(atom.actionClass())),
                "site 4 actionPermissions: the canonical atom row must appear");
        assertTrue(authority.holdsActionAtom(USER, ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS, null),
                "holdsActionAtom delegates to site 2 — same answer");
    }

    /**
     * The same four reads with a <b>non-governance</b> binding: nothing, at every site. A row like
     * this cannot reach the table through the {@code M2-8c} write gate, but the evaluation side must
     * not depend on that ({@code tasks.md:116}: 两处判据必须各自生效).
     */
    @Test
    void everyReadPointIgnoresANonGovernanceBinding() {
        wire(OrgUnitGrantExpander.MEMBER_HUMAN, USER,
                governanceBinding("CONTENT_EDITOR", ToolFaceRegistry.ACTION_EXEC, "*"));

        assertFalse(authority.allowsForUser(request(ToolFaceRegistry.ACTION_EXEC, "*"), WORKSPACE),
                "site 1: a non-governance org-unit role must not authorize anything");
        assertTrue(authority.actionAtoms(USER, WORKSPACE).isEmpty(), "site 2");
        assertTrue(authority.atomSources(USER, ToolFaceRegistry.ACTION_EXEC, WORKSPACE).isEmpty(), "site 3");
        assertTrue(authority.actionPermissions(USER, WORKSPACE).isEmpty(), "site 4");
    }

    /** No membership row ⇒ no units ⇒ nothing, at every site (the "0 rows" case, not a wildcard). */
    @Test
    void memberWithoutMembershipIsGivenNothing() {
        wire(OrgUnitGrantExpander.MEMBER_HUMAN, USER,
                governanceBinding("ORG_LEADER", ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS, "*"));
        // Same wiring, but nothing ties USER to the unit: a membership row for somebody else.
        wire(OrgUnitGrantExpander.MEMBER_HUMAN,
                UUID.fromString("99999999-9999-4999-8999-999999999999"),
                governanceBinding("ORG_LEADER", ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS, "*"));

        assertFalse(authority.allowsForUser(request(ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS, "*"), WORKSPACE),
                "somebody else's membership must not expand for this subject");
        assertTrue(authority.actionAtoms(USER, WORKSPACE).isEmpty());
        assertTrue(authority.actionPermissions(USER, WORKSPACE).isEmpty());
    }

    /** The port maps grant vocabulary to membership vocabulary in one place, agent principals included. */
    @Test
    void principalVocabularyIsTranslatedOnce() {
        assertEquals(OrgUnitGrantExpander.MEMBER_HUMAN, OrgUnitGrants.memberKindOf(GrantPrincipalPathResolver.USER));
        assertEquals(OrgUnitGrantExpander.MEMBER_AGENT_PRINCIPAL,
                OrgUnitGrants.memberKindOf(GrantPrincipalPathResolver.AGENT_PRINCIPAL));
        assertEquals(null, OrgUnitGrants.memberKindOf("capability"));
        assertEquals(null, OrgUnitGrants.memberKindOf(null));

        OrgUnitGrantSource source = member -> new OrgUnitGrantExpander.Rows(
                List.of(new OrgUnitGrantExpander.UnitRow(UNIT, "root")),
                List.of(new OrgUnitGrantExpander.MembershipRow(
                        OrgUnitGrantExpander.MEMBER_AGENT_PRINCIPAL, AGENT, UNIT)),
                List.of(governanceBinding("ORG_LEADER", ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS, "*")));
        OrgUnitGrants grants = new OrgUnitGrants(new OrgUnitGrantExpander(), source);

        assertEquals(1, grants.forPrincipal(GrantPrincipalPathResolver.AGENT_PRINCIPAL, AGENT).size(),
                "an agent principal expands through its own member_kind");
        assertTrue(grants.forPrincipal(GrantPrincipalPathResolver.USER, AGENT).isEmpty(),
                "the same id under the other vocabulary is not a member");
        assertTrue(grants.forPrincipal("capability", AGENT).isEmpty(),
                "an unknown vocabulary yields nothing (fewer grants, never more)");
        assertTrue(grants.forPrincipal(GrantPrincipalPathResolver.USER, null).isEmpty(),
                "no subject ⇒ nothing");
    }
}
