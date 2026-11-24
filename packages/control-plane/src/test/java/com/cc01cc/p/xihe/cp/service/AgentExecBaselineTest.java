package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-987: execution is a <b>two-level</b> grant and the workspace binding snapshot is only one
 * of the levels.
 *
 * <p>{@code GrantAuthorizationService.allows} evaluates every level of the principal path
 * (principal grants ∪ binding snapshot ∪ live session snapshots). DSD-1500 (Q-93 R2) removed
 * {@code action:exec} from the agent defaults (AGENT_USER / WS_EDITOR) precisely so that "exec
 * on the default host backend" is never on by accident; the intended opt-in is an explicit
 * per-principal {@code WS_RUNNER} binding at instance scope <em>plus</em> a binding snapshot that
 * carries exec. This class pins that shape:</p>
 *
 * <ul>
 *   <li>a principal that already holds exec at instance scope gets it in the derived baseline
 *       snapshot — the baseline is not a blanket omission;</li>
 *   <li>a principal that does <b>not</b> hold exec keeps a snapshot without it even when the
 *       binding actor (workspace owner) holds exec — the right-answer question from task-938: "the
 *       user has exec, the agent does not";</li>
 *   <li>an explicit exec cap is refused while the principal lacks exec, and accepted once the
 *       instance-scope reach exists. The reverse proof is the explicit-cap case without exec.</li>
 * </ul>
 */
class AgentExecBaselineTest extends AbstractReusableIntegrationTest {

    private static final List<String> BASE_ATOMS = List.of("read", "write", "delete");

    @Autowired
    private AgentPrincipalService agentPrincipalService;
    @Autowired
    private AgentPrincipalRepository principalRepository;
    @Autowired
    private WorkspaceAgentRepository bindingRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceRepository workspaceRepository;
    @Autowired
    private AuthorizationGrantRepository grantRepository;
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
        for (UUID principalId : principals) {
            bindingRepository.deleteAll(bindingRepository.findByIdPrincipalId(principalId));
            grantRepository.deleteAll(
                    grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
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
    // Pin 1: instance reach present -> the derived baseline snapshot carries exec.
    // ---------------------------------------------------------------------------------------------

    @Test
    void baselineSnapshotCarriesExecWhenThePrincipalHoldsItAtInstanceScope() throws Exception {
        Fixture fixture = fixture("exec-baseline-reach", true);

        WorkspaceAgent binding = agentPrincipalService.setWorkspaceCap(
                fixture.owner().getId().toString(), fixture.workspace().getId(),
                fixture.principal().getId(), null);

        assertEquals(WorkspaceAgent.CAP_SOURCE_BASELINE, binding.getCapSource());
        Set<String> atoms = snapshotAtoms(binding);
        assertTrue(atoms.contains("action:exec"),
                "WS_RUNNER reach must be copied into the baseline snapshot: " + atoms);
        assertTrue(effectiveAtoms(fixture).contains("action:exec"),
                "the effective cap must keep exec when both levels hold it");
    }

    // ---------------------------------------------------------------------------------------------
    // Pin 2 (task-938's exact shape): the workspace owner has exec, the agent does not.
    // The baseline must NOT invent exec for the agent — the reverse proof for the fix.
    // ---------------------------------------------------------------------------------------------

    @Test
    void baselineSnapshotOmitsExecWhenOnlyTheBindingActorHoldsIt() throws Exception {
        Fixture fixture = fixture("exec-baseline-owner-only", false);

        assertTrue(ownerWorkspaceAtoms(fixture).contains("action:exec"),
                "fixture precondition: the workspace owner holds exec (task-938 R2 reading)");

        WorkspaceAgent binding = agentPrincipalService.setWorkspaceCap(
                fixture.owner().getId().toString(), fixture.workspace().getId(),
                fixture.principal().getId(), null);

        Set<String> atoms = snapshotAtoms(binding);
        assertFalse(atoms.contains("action:exec"),
                "the baseline must not copy the actor's exec into an agent that lacks the reach: " + atoms);
        assertFalse(effectiveAtoms(fixture).contains("action:exec"),
                "execute_command must still be denied: the snapshot alone cannot grant exec");
    }

    // ---------------------------------------------------------------------------------------------
    // Pin 3a (reverse proof): an explicit exec cap is refused while the principal lacks exec.
    // ---------------------------------------------------------------------------------------------

    @Test
    void explicitExecCapIsRefusedWithoutInstanceReach() throws Exception {
        Fixture fixture = fixture("exec-explicit-denied", false);

        CpApiException failure = assertThrows(CpApiException.class,
                () -> agentPrincipalService.setWorkspaceCap(
                        fixture.owner().getId().toString(), fixture.workspace().getId(),
                        fixture.principal().getId(),
                        objectMapper.readTree("[{\"actionClass\":\"exec\",\"resource\":\"*\"}]")));

        assertEquals(HttpStatus.FORBIDDEN, failure.getStatus());
        assertEquals("AGENT_PERMISSION_SCOPE_EXCEEDED", failure.getCode());
        assertTrue(failure.getMessage().contains("action:exec"),
                "the refusal must name the missing atom: " + failure.getMessage());
    }

    // ---------------------------------------------------------------------------------------------
    // Pin 3b: the same explicit cap is accepted once the instance-scope reach exists.
    // ---------------------------------------------------------------------------------------------

    @Test
    void explicitExecCapIsAcceptedWithInstanceReach() throws Exception {
        Fixture fixture = fixture("exec-explicit-accepted", true);

        WorkspaceAgent binding = agentPrincipalService.setWorkspaceCap(
                fixture.owner().getId().toString(), fixture.workspace().getId(),
                fixture.principal().getId(),
                objectMapper.readTree("[{\"actionClass\":\"exec\",\"resource\":\"*\"}]"));

        assertEquals(WorkspaceAgent.CAP_SOURCE_EXPLICIT, binding.getCapSource());
        assertTrue(snapshotAtoms(binding).contains("action:exec"));
        assertTrue(effectiveAtoms(fixture).contains("action:exec"));
    }

    // ---------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------

    private record Fixture(User owner, Workspace workspace, AgentPrincipal principal) {}

    private Fixture fixture(String label, boolean instanceExecReach) {
        User owner = userRepository.saveAndFlush(new User(
                "task987-" + label + "-" + UUID.randomUUID() + "@test.com", "hash", label));
        users.add(owner.getId());
        Workspace workspace = workspaceFixture.createOwnedWorkspace("task987 " + label,
                owner.getId().toString());
        workspaces.add(workspace.getId());

        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName("ExecAgent-" + label);
        principal.setCreatedByUserId(owner.getId().toString());
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        AgentPrincipal saved = principalRepository.saveAndFlush(principal);
        principals.add(saved.getId());

        // Simulates the materialized instance-scope role stack: AGENT_USER always, plus WS_RUNNER
        // (exec + USE_WORKSPACE_RUNTIME) when the opt-in exists. Scope is instance by construction
        // (no scope columns), exactly like RoleGrantMaterializer's bindInstanceRoles output.
        List<String> actions = new ArrayList<>(BASE_ATOMS);
        if (instanceExecReach) {
            actions.add("exec");
            actions.add("USE_WORKSPACE_RUNTIME");
        }
        for (String actionClass : actions) {
            AuthorizationGrant grant = new AuthorizationGrant();
            grant.setGranterType("user");
            grant.setGranterId(owner.getId());
            grant.setSubjectType("agent_principal");
            grant.setSubjectId(saved.getId());
            grant.setSource("assigned");
            grant.setReadState("read");
            try {
                grant.setPermissions(objectMapper.readTree(
                        "[{\"actionClass\":\"" + actionClass + "\",\"resource\":\"*\"}]"));
            } catch (Exception e) {
                throw new IllegalStateException("fixture grant JSON", e);
            }
            grantRepository.saveAndFlush(grant);
        }
        return new Fixture(owner, workspace, saved);
    }

    private Set<String> snapshotAtoms(WorkspaceAgent binding) throws Exception {
        return atomNames(binding.getPermissionsSnapshot());
    }

    private Set<String> effectiveAtoms(Fixture fixture) throws Exception {
        return atomNames(agentPrincipalService.resolveCapFor(
                fixture.principal().getId(), fixture.workspace().getId()));
    }

    private Set<String> ownerWorkspaceAtoms(Fixture fixture) {
        return new LinkedHashSet<>(jdbcTemplate.queryForList(
                "SELECT jsonb_array_elements(g.permissions)->>'actionClass' FROM grants g "
                        + "WHERE g.subject_type = 'user' AND g.subject_id = ?::uuid "
                        + "AND (g.scope_type = 'instance' OR (g.scope_type = 'workspace' AND g.scope_id = ?::uuid))",
                String.class, fixture.owner().getId().toString(), fixture.workspace().getId().toString()));
    }

    private Set<String> atomNames(JsonNode permissions) {
        Set<String> names = new LinkedHashSet<>();
        for (JsonNode row : permissions) {
            String actionClass = row.path("actionClass").asText("");
            if (!actionClass.isBlank()) {
                // Snapshots store the canonical name (`action:exec`); a raw `exec` is normalized the
                // same way the production writer does, so the assertion is about the atom either way.
                names.add(actionClass.startsWith("action:") ? actionClass : "action:" + actionClass);
            }
        }
        return names;
    }
}
