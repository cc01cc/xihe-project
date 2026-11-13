package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGrantExpander;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGrantSource;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGovernancePolicy;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * `task-197`: the <b>behavioural</b> half of the two gates `task-182` wired into
 * {@code AgentPrincipalService} but could not prove offline.
 *
 * <p>Why this class exists at all ({@code task-197} card, Lead ruling 2026-11-13): "the same
 * function was proven" does <i>not</i> prove "these two call sites were proven" — the parameter
 * origin, the short-circuit order and the cap/role path differ between them. `RequesterAuthority`'s
 * four read points are covered by a DB-free unit test; these two need the real chain.</p>
 *
 * <p><b>The shapes this class deliberately creates</b> (both branches the two gates live on):</p>
 * <ul>
 *   <li><b>gate 773</b> is reached with <b>no</b> {@code workspace_agents} row — that is the
 *       {@code workspaceAgent() == null} arm, the only one that merges org-unit rows into the
 *       <i>binding</i> side; reachability is supplied by a workspace-scoped role binding instead</li>
 *   <li><b>gate 971</b> is reached with <b>no</b> {@code grants} rows for the principal
 *       ({@code roleRows.isEmpty()}) — that is the fallback arm. The fixture inserts the role
 *       binding <i>without</i> running {@code RoleGrantMaterializer}, so "held a role" and
 *       "has a role row" are separated on purpose: only the latter decides the branch.</li>
 * </ul>
 *
 * <p>Atom choice: {@link OrgUnitGovernancePolicy#ATOM_MANAGE_ORG_UNITS} — the <b>same</b> atom the
 * {@code RequesterAuthority} org-unit test uses, so the two paths cross-check each other instead of
 * each proving a different atom.</p>
 *
 * <p>Negative control discipline (`task-182` §6): the assertion that must be true is paired with
 * one that must be false — the second case keeps the whole fixture identical and only removes the
 * org-unit rows, so "widened" cannot be explained by the fixture itself.</p>
 */
class AgentPrincipalOrgUnitGateTest extends AbstractReusableIntegrationTest {

    private static final String GOVERNANCE_ATOM = OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS;

    /** What the stub source answers with. Mutable on purpose: the two cases differ only here. */
    private static volatile OrgUnitGrantExpander.Rows stubRows =
            new OrgUnitGrantExpander.Rows(List.of(), List.of(), List.of());

    @TestConfiguration
    static class OrgUnitStubConfiguration {

        /**
         * Replaces the placeholder source for this class only. `@Primary` rather than a bean-name
         * override: the production bean stays defined (this is a fixture swap, not a deletion), and
         * `OrgUnitGrants` gets the stub by type preference.
         */
        @Bean
        @Primary
        OrgUnitGrantSource stubOrgUnitGrantSource() {
            return member -> stubRows;
        }
    }

    @Autowired
    private AgentPrincipalService agentPrincipalService;
    @Autowired
    private AgentPrincipalRepository principalRepository;
    @Autowired
    private AuthorizationGrantRepository grantRepository;
    @Autowired
    private AccessRoleBindingRepository roleBindingRepository;
    @Autowired
    private AccessRoleRepository roleRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceRepository workspaceRepository;
    @Autowired
    private WorkspaceFixture workspaceFixture;
    @Autowired
    private ObjectMapper objectMapper;
    @Autowired
    private JdbcTemplate jdbcTemplate;

    private final List<UUID> users = new ArrayList<>();
    private final List<UUID> workspaces = new ArrayList<>();
    private final List<UUID> principals = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        stubRows = new OrgUnitGrantExpander.Rows(List.of(), List.of(), List.of());
        for (UUID principalId : principals) {
            roleBindingRepository.deleteAll(
                    roleBindingRepository.findBySubjectTypeAndSubjectId(
                            GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            grantRepository.deleteAll(
                    grantRepository.findBySubjectTypeAndSubjectId(
                            GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            jdbcTemplate.update("DELETE FROM audit_logs WHERE resource_type = 'agent_principal' "
                    + "AND CAST(resource_id AS VARCHAR) = ?", principalId.toString());
            principalRepository.deleteById(principalId);
        }
        principals.clear();
        for (UUID workspaceId : workspaces) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        workspaces.clear();
        for (UUID userId : users) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE user_id = CAST(? AS UUID)",
                    userId.toString());
            userRepository.deleteById(userId);
        }
        users.clear();
    }

    // ---------------------------------------------------------------------------------------------
    // 正例：组织单元治理授权到达 cap（同时走过 773 的 null 臂与 971 的无 role 行臂）
    // ---------------------------------------------------------------------------------------------

    @Test
    void anOrgUnitGovernanceGrantReachesTheResolvedCap() throws Exception {
        Fixture fixture = fixture("orgunit-reaches");
        stubRows = orgUnitRows(fixture);

        assertFalse(hasRoleGrants(fixture.principal()),
                "fixture precondition: this case must take the no-role-row fallback (gate 971)");

        JsonNode cap = agentPrincipalService.resolveCapFor(fixture.principal().getId(),
                fixture.workspace().getId());
        assertEquals(1, cap.size(), "the cap must carry exactly the org-unit grant: " + cap);
        assertEquals(GOVERNANCE_ATOM, cap.path(0).path("actionClass").asText(),
                "gate 773/971 must let the org-unit governance atom into the cap: " + cap);
    }

    // ---------------------------------------------------------------------------------------------
    // 阴性对照：同一夹具只撤掉组织单元行 ⇒ cap 必须不含该原子
    // ---------------------------------------------------------------------------------------------

    @Test
    void withoutOrgUnitRowsTheSameCapDoesNotContainTheAtom() throws Exception {
        Fixture fixture = fixture("orgunit-absent");
        // stubRows stays empty: everything else about the fixture is identical.

        JsonNode cap = agentPrincipalService.resolveCapFor(fixture.principal().getId(),
                fixture.workspace().getId());
        assertEquals(0, cap.size(), "with no org-unit rows the cap must stay empty: " + cap);
        for (JsonNode atom : cap) {
            assertFalse(GOVERNANCE_ATOM.equals(atom.path("actionClass").asText()),
                    "a non-existent org-unit grant may not appear out of nowhere: " + cap);
        }
        assertTrue(cap.isEmpty(), "negative control: nothing may be granted") ;
    }

    // ---------------------------------------------------------------------------------------------
    // fixtures
    // ---------------------------------------------------------------------------------------------

    private record Fixture(User owner, Workspace workspace, AgentPrincipal principal, UUID unitId,
                           UUID roleId) {
    }

    /**
     * One principal reachable in one workspace <b>without</b> a {@code workspace_agents} row and
     * <b>without</b> any {@code grants} row — the two shapes `task-197` has to create on purpose.
     */
    private Fixture fixture(String label) {
        User owner = userRepository.saveAndFlush(new User(
                "plan0773-" + label + "-" + UUID.randomUUID() + "@test.com", "hash", label));
        users.add(owner.getId());
        Workspace workspace = workspaceFixture.createOwnedWorkspace("OrgUnit " + label,
                owner.getId().toString());
        workspaces.add(workspace.getId());

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("OrgUnitAgent-" + label);
        principal.setCreatedByUserId(owner.getId().toString());
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        AgentPrincipal saved = principalRepository.saveAndFlush(principal);
        principals.add(saved.getId());

        // Reachability only: a workspace-scoped role binding, with NO materialiser run and NO
        // workspace_agents row. "Holds a role" and "has role rows" are separated here on purpose.
        AccessRole role = roleRepository.findAll().get(0);
        roleBindingRepository.saveAndFlush(new AccessRoleBinding(role.getId(),
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, saved.getId(), "workspace",
                workspace.getId(), owner.getId()));

        return new Fixture(owner, workspace, saved, UUID.randomUUID(), role.getId());
    }

    /** Rows that say: this agent principal is a member of one unit whose role grants the atom. */
    private OrgUnitGrantExpander.Rows orgUnitRows(Fixture fixture) throws Exception {
        var permissions = objectMapper.createArrayNode();
        permissions.addObject().put("actionClass", GOVERNANCE_ATOM).put("resource", "*");
        return new OrgUnitGrantExpander.Rows(
                List.of(new OrgUnitGrantExpander.UnitRow(fixture.unitId(), "orgunit-" + fixture.unitId())),
                List.of(new OrgUnitGrantExpander.MembershipRow(
                        OrgUnitGrantExpander.MEMBER_AGENT_PRINCIPAL, fixture.principal().getId(),
                        fixture.unitId())),
                List.of(new OrgUnitGrantExpander.RoleBindingRow(fixture.unitId(), fixture.roleId(),
                        "OrgGovernance", List.of(GOVERNANCE_ATOM), permissions)));
    }

    private boolean hasRoleGrants(AgentPrincipal principal) {
        return !grantRepository.findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principal.getId()).isEmpty();
    }
}
