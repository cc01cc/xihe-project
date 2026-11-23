package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.GrantPreset;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-946: the principal read face must stay <b>narrow</b> once a subject carries materialized
 * rows — assigned rows plus active credential bindings, and nothing else.
 *
 * <p>The defect this class pins: {@code principalEffectiveAtomsWithProvenance} read
 * {@code List.of(GrantSources.PRESET, GrantSources.CREDENTIAL_BINDING)}. After V186 no persisted
 * row may carry {@code preset} (all historical rows were converted and the CHECK rejects the
 * value), so the narrow branch could never fire and every subject silently fell through to the
 * full {@link GrantSources#EVALUATION_SOURCES} arm. The legacy {@code agent_default}/{@code spawn}
 * snapshot atoms therefore stayed effective for subjects that should see only their own rows —
 * a widening of the read face that never 403s and never logs.</p>
 *
 * <p><b>Red-on-regression:</b> changing the source list in {@code AgentPrincipalService} back to
 * {@code PRESET} makes {@link #legacySnapshotAtomsDoNotWidenAMaterializedSubject()} fail: the
 * subject's only rows are {@code assigned}/{@code agent_default}, the PRESET read answers empty,
 * the code falls back to the full evaluation set and the snapshot atom reaches the cap.</p>
 *
 * <p>Fixture shape: reachability comes from a workspace-scoped role binding with <b>no</b>
 * {@code workspace_agents} row and <b>no</b> materializer run, so the binding side reads the
 * full evaluation set (see {@code AgentPrincipalOrgUnitGateTest}) while the principal side is
 * the narrowing under test. Both arms share the same grant rows, which is what makes the
 * assertion about the ceiling, not about the fixture.</p>
 */
class AgentPrincipalReadSourceScopeTest extends AbstractIntegrationTest {

    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private GrantPresetBindingRepository roleBindingRepository;
    @Autowired private GrantPresetRepository roleRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private final List<UUID> users = new ArrayList<>();
    private final List<UUID> workspaces = new ArrayList<>();
    private final List<UUID> principals = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        for (UUID principalId : principals) {
            roleBindingRepository.deleteAll(roleBindingRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
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

    /**
     * A subject whose only rows are {@code assigned} must not pick up the frozen
     * {@code agent_default} snapshot. This is the case that goes red when the source list is
     * reverted to {@code PRESET}.
     */
    @Test
    void legacySnapshotAtomsDoNotWidenAMaterializedSubject() throws Exception {
        Fixture fixture = fixture("assigned-narrows");
        grant(fixture, GrantSources.ASSIGNED, "[{\"actionClass\":\"read\"}]");
        grant(fixture, GrantSources.AGENT_DEFAULT, "[{\"actionClass\":\"SPAWN_AGENT\"}]");

        JsonNode cap = agentPrincipalService.resolveCapFor(
                fixture.principal().getId(), fixture.workspace().getId());
        Set<String> atoms = actionClasses(cap);

        assertTrue(atoms.contains("action:read"),
                "the materialized assigned atom must stay effective: " + cap);
        assertFalse(atoms.contains("action:SPAWN_AGENT"),
                "a legacy agent_default snapshot may not widen a subject that already has "
                        + "materialized rows (task-946 dead PRESET branch): " + cap);
    }

    /**
     * The credential arm is the second half of the narrow list: a subject holding only a
     * {@code credential_binding} row must stay narrow as well. This case is not the
     * red-on-PRESET control (credential rows are in both lists) — it guards the opposite
     * regression: deleting the special branch and always reading the full evaluation set.
     */
    @Test
    void credentialBindingRowsKeepTheNarrowReadFace() throws Exception {
        Fixture fixture = fixture("credential-narrows");
        String credentialId = "credential:" + UUID.randomUUID();
        grant(fixture, GrantSources.CREDENTIAL_BINDING,
                "[{\"actionClass\":\"credential_use\",\"resource\":\"" + credentialId + "\"}]");
        grant(fixture, GrantSources.AGENT_DEFAULT, "[{\"actionClass\":\"SPAWN_AGENT\"}]");

        JsonNode cap = agentPrincipalService.resolveCapFor(
                fixture.principal().getId(), fixture.workspace().getId());
        Set<String> atoms = actionClasses(cap);

        assertTrue(atoms.contains("action:credential_use"),
                "the active credential binding must stay effective: " + cap);
        assertFalse(atoms.contains("action:SPAWN_AGENT"),
                "a legacy agent_default snapshot may not widen a credential-bound subject: " + cap);
    }

    // ---------------------------------------------------------------------------------------------
    // fixtures
    // ---------------------------------------------------------------------------------------------

    private record Fixture(User owner, Workspace workspace, AgentPrincipal principal) {
    }

    /**
     * One principal reachable in one workspace <b>without</b> a {@code workspace_agents} row and
     * <b>without</b> a materializer run: reachability is a workspace-scoped role binding only.
     */
    private Fixture fixture(String label) {
        User owner = userRepository.saveAndFlush(new User(
                "task946-" + label + "-" + UUID.randomUUID() + "@test.com", "hash", label));
        users.add(owner.getId());
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Task946 " + label,
                owner.getId().toString());
        workspaces.add(workspace.getId());

        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName("Task946Agent-" + label);
        principal.setCreatedByUserId(owner.getId().toString());
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        AgentPrincipal saved = principalRepository.saveAndFlush(principal);
        principals.add(saved.getId());

        // Reachability only. No materializer: "holds a role binding" and "has grant rows" stay
        // separate, so the grant rows below are exactly the fixture's own shape.
        GrantPreset role = roleRepository.findAll().get(0);
        roleBindingRepository.saveAndFlush(new GrantPresetBinding(role.getId(),
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, saved.getId(), "workspace",
                workspace.getId(), owner.getId()));

        return new Fixture(owner, workspace, saved);
    }

    /** One persisted grant row of the given source; instance-scoped by the entity default. */
    private void grant(Fixture fixture, String source, String permissionsJson) throws Exception {
        AuthorizationGrant row = new AuthorizationGrant();
        row.setGranterType("user");
        row.setGranterId(fixture.owner().getId());
        row.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        row.setSubjectId(fixture.principal().getId());
        row.setSource(source);
        row.setReadState("read");
        row.setPermissions(objectMapper.readTree(permissionsJson));
        grantRepository.saveAndFlush(row);
    }

    private static Set<String> actionClasses(JsonNode permissions) {
        Set<String> names = new LinkedHashSet<>();
        if (permissions instanceof ArrayNode) {
            permissions.forEach(atom -> names.add(atom.path("actionClass").asText()));
        }
        return names;
    }
}
