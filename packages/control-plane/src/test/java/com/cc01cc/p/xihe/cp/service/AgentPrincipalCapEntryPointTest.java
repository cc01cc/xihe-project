package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * PLAN-0622 M1.3 (checklist C1–C6): the capability of a principal in a workspace has exactly one
 * computation entry — {@code AgentPrincipalService.resolveCapFor(principalId, workspaceId)}.
 *
 * <p>Written before the implementation (G2): {@code resolveCapFor} does not exist on the M1.2
 * baseline, so every case below fails to compile / fails on the first call.</p>
 */
class AgentPrincipalCapEntryPointTest extends AbstractIntegrationTest {

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
    private WorkspaceFixture workspaceFixture;
    @Autowired
    private ObjectMapper objectMapper;
    @Autowired
    private JdbcTemplate jdbcTemplate;
    @Autowired
    private AuthorizationGrantRepository grantRepository;

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
    // C5: the entry is scoped — bound in A, unbound in B must not fall back to A.
    // ---------------------------------------------------------------------------------------------

    @Test
    void capIsResolvedPerWorkspaceAndNeverFallsBackToAnotherBinding() throws Exception {
        User owner = newUser("cap-scope");
        Workspace boundIn = workspace("Cap bound", owner);
        Workspace unboundIn = workspace("Cap unbound", owner);
        AgentPrincipal principal = principal(owner, "Scoped agent");
        bind(principal, boundIn, "[{\"actionClass\":\"read\"}]");

        JsonNode cap = agentPrincipalService.resolveCapFor(principal.getId(), boundIn.getId());
        assertNotNull(cap);
        assertEquals("read", cap.path(0).path("actionClass").asText());

        CpApiException failure = assertThrows(CpApiException.class,
                () -> agentPrincipalService.resolveCapFor(principal.getId(), unboundIn.getId()));
        assertEquals(HttpStatus.FORBIDDEN, failure.getStatus(),
                "an unbound workspace must not resolve to another workspace's binding");
    }

    // ---------------------------------------------------------------------------------------------
    // C6: the signature takes explicit ids (no TenantContext), so 0623 can call it off-request.
    // ---------------------------------------------------------------------------------------------

    @Test
    void capResolvesWithoutAnyRequestContext() throws Exception {
        User owner = newUser("cap-context");
        Workspace workspace = workspace("Cap context", owner);
        AgentPrincipal principal = principal(owner, "Context-free agent");
        bind(principal, workspace, "[{\"actionClass\":\"write\"}]");

        // This test thread never ran a request, so TenantContext is empty by construction.
        assertNull(com.cc01cc.p.xihe.cp.config.TenantContext.getUserId());
        JsonNode cap = agentPrincipalService.resolveCapFor(principal.getId(), workspace.getId());
        assertEquals("write", cap.path(0).path("actionClass").asText());
    }

    // ---------------------------------------------------------------------------------------------
    // V16: no cache — a binding change is visible on the very next call.
    // ---------------------------------------------------------------------------------------------

    @Test
    void capIsRecomputedOnEveryCallWithoutCaching() throws Exception {
        User owner = newUser("cap-cache");
        Workspace workspace = workspace("Cap cache", owner);
        AgentPrincipal principal = principal(owner, "Fresh agent");
        WorkspaceAgent binding = bind(principal, workspace, "[{\"actionClass\":\"read\"}]");
        assertEquals("read", agentPrincipalService.resolveCapFor(principal.getId(), workspace.getId())
                .path(0).path("actionClass").asText());

        binding.setPermissionsSnapshot(objectMapper.readTree("[{\"actionClass\":\"exec\"}]"));
        bindingRepository.saveAndFlush(binding);

        assertEquals("exec", agentPrincipalService.resolveCapFor(principal.getId(), workspace.getId())
                .path(0).path("actionClass").asText(), "a cached cap would still read 'read'");
    }

    // ---------------------------------------------------------------------------------------------
    // C1: the pre-0622 entry point delegates — one computation, not two.
    // ---------------------------------------------------------------------------------------------

    @Test
    void legacyEntryPointDelegatesToTheSingleComputation() throws Exception {
        User owner = newUser("cap-legacy");
        Workspace workspace = workspace("Cap legacy", owner);
        AgentPrincipal principal = principal(owner, "Legacy agent");
        bind(principal, workspace, "[{\"actionClass\":\"network\"}]");

        JsonNode viaNew = agentPrincipalService.resolveCapFor(principal.getId(), workspace.getId());
        JsonNode viaLegacy = agentPrincipalService.resolveSessionCap(
                principal.getId().toString(), workspace.getId().toString());
        assertEquals(viaNew, viaLegacy, "the legacy entry must delegate, not recompute differently");
    }

    // ---------------------------------------------------------------------------------------------
    // A disabled principal is a 409 state conflict on the entry itself (V15 semantics).
    // ---------------------------------------------------------------------------------------------

    @Test
    void disabledPrincipalIsAConflictOnTheEntry() throws Exception {
        User owner = newUser("cap-disabled");
        Workspace workspace = workspace("Cap disabled", owner);
        AgentPrincipal principal = principal(owner, "Disabled agent");
        bind(principal, workspace, "[]");
        principal.setDisabledAt(java.time.Instant.now());
        principalRepository.saveAndFlush(principal);

        CpApiException failure = assertThrows(CpApiException.class,
                () -> agentPrincipalService.resolveCapFor(principal.getId(), workspace.getId()));
        assertEquals(HttpStatus.CONFLICT, failure.getStatus());
        assertEquals("AGENT_PRINCIPAL_DISABLED", failure.getCode());
    }

    // ---------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------


    private User newUser(String label) {
        User user = userRepository.saveAndFlush(new User(
                "plan0622-" + label + "-" + UUID.randomUUID() + "@test.com", "hash", label));
        users.add(user.getId());
        return user;
    }

    private Workspace workspace(String name, User owner) {
        Workspace workspace = workspaceFixture.createOwnedWorkspace(name, owner.getId().toString());
        workspaces.add(workspace.getId());
        return workspace;
    }

    /**
     * The cap is the intersection of the binding snapshot and the principal's own grants, so a
     * fixture without grants would always resolve to an empty cap (and hide a real regression).
     */
    private AgentPrincipal principal(User creator, String name) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(name);
        principal.setCreatedByUserId(creator.getId().toString());
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        AgentPrincipal saved = principalRepository.saveAndFlush(principal);
        principals.add(saved.getId());
        for (String actionClass : List.of("read", "write", "exec", "network")) {
            AuthorizationGrant grant = new AuthorizationGrant();
            grant.setGranterType("user");
            grant.setGranterId(creator.getId());
            grant.setSubjectType("agent_principal");
            grant.setSubjectId(saved.getId());
            grant.setSource("role");
            grant.setReadState("read");
            try {
                grant.setPermissions(objectMapper.readTree(
                        "[{\"actionClass\":\"" + actionClass + "\",\"resource\":\"*\"}]"));
            } catch (Exception e) {
                throw new IllegalStateException("fixture grant JSON", e);
            }
            grantRepository.saveAndFlush(grant);
        }
        return saved;
    }

    private WorkspaceAgent bind(AgentPrincipal principal, Workspace workspace, String snapshot)
            throws Exception {
        return bindingRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.readTree(snapshot)));
    }


}
