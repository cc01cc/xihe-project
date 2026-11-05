package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0629 task-12 (user ruling 2026-11-04 option A): an agent principal's permission is a
 * <b>role binding</b>. The ruling is only worth anything if binding actually changes behaviour
 * immediately, so this class asserts the two states plus the guard rails around them:
 *
 * <ol>
 *   <li>bind &rarr; effective <b>now</b> (the workspace's atoms appear as {@code source='role'});</li>
 *   <li>unbind &rarr; gone <b>now</b> (and the row disappears from the workspace list);</li>
 *   <li>an instance-administrator role cannot be bound to an agent principal at all;</li>
 *   <li>an unknown role id is refused with the same stable code (no existence leak);</li>
 *   <li>a principal with <b>no</b> role rows still works through the legacy ceiling — the rollback
 *       promise of the retirement.</li>
 * </ol>
 */
class AgentPrincipalRoleBindingIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AgentPrincipalService agentPrincipalService;
    @Autowired
    private AgentTemplateService agentTemplateService;
    @Autowired
    private AccessRoleRepository roleRepository;
    @Autowired
    private AccessRoleBindingRepository roleBindingRepository;
    @Autowired
    private AuthorizationGrantRepository grantRepository;
    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceFixture workspaceFixture;
    @Autowired
    private ObjectMapper objectMapper;

    private String userId;
    private UUID workspaceId;

    @BeforeEach
    void setUpOwnerWorkspace() {
        String email = "plan0629-roles-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registered = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "RoleBindingTest"), AuthResponse.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode());
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(user.getId());
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.OWNER);
    }

    @Test
    void bindTakesEffectImmediately() {
        AgentPrincipal principal = createPlainPrincipal("bindEffective");
        assertEquals(0, roleGrants(principal.getId(), GrantSources.ROLE).size(),
                "a fresh principal has no workspace role grants");

        bindToWorkspace(principal.getId());

        List<String> atoms = roleAtomNames(principal.getId());
        assertTrue(atoms.containsAll(List.of("read", "write", "exec")),
                "WS_EDITOR atoms must be materialized right away: " + atoms);
        assertTrue(roleBindingRepository
                        .findBySubjectTypeAndScopeTypeAndScopeId(
                                GrantPrincipalPathResolver.AGENT_PRINCIPAL, "workspace", workspaceId)
                        .stream().anyMatch(row -> principal.getId().equals(row.getSubjectId())),
                "the workspace role binding is the source of that effect");
    }

    @Test
    void unbindRevokesImmediately() {
        AgentPrincipal principal = createPlainPrincipal("unbind");
        bindToWorkspace(principal.getId());
        assertFalse(roleGrants(principal.getId(), GrantSources.ROLE).isEmpty());

        assertTrue(agentPrincipalService.unbindWorkspace(userId, workspaceId, principal.getId()));

        assertEquals(0, roleGrants(principal.getId(), GrantSources.ROLE).size(),
                "unbinding must remove the workspace role grants in the same transaction");
        assertFalse(agentPrincipalService.listWorkspaceAgents(userId, workspaceId).stream()
                        .anyMatch(view -> principal.getId().equals(view.principalId())),
                "and the row must disappear from the workspace list");
    }

    @Test
    void instanceAdminRoleCannotBeBoundToAnAgentPrincipal() {
        AccessRole admin = roleRepository.findByName("ADMIN").orElseThrow();
        CpApiException refused = assertThrows(CpApiException.class,
                () -> createPlainPrincipal("adminRole", List.of(admin.getId())));
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus());
        assertEquals("ROLE_NOT_GRANTABLE", refused.getCode());
        assertTrue(refused.getMessage().contains("instance-admin role"),
                "the detail names the rule: " + refused.getMessage());
    }

    @Test
    void unknownRoleIdIsRefusedWithTheSameStableCode() {
        CpApiException refused = assertThrows(CpApiException.class,
                () -> createPlainPrincipal("bogusRole", List.of(UUID.randomUUID())));
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus());
        assertEquals("ROLE_NOT_GRANTABLE", refused.getCode(),
                "no 404: the code must not leak which roles exist");
    }

    @Test
    void principalWithoutRoleRowsStillWorksThroughTheLegacyCeiling() {
        AgentPrincipal principal = createPlainPrincipal("legacyFallback");
        bindToWorkspace(principal.getId());
        // Simulate a pre-ruling row: drop the role side entirely, leave a legacy snapshot behind.
        roleBindingRepository.deleteAll(roleBindingRepository
                .findBySubjectTypeAndScopeTypeAndScopeId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, "workspace", workspaceId));
        grantRepository.deleteAll(roleGrants(principal.getId(), GrantSources.ROLE));
        AuthorizationGrant legacy = new AuthorizationGrant();
        legacy.setId(UUID.randomUUID());
        legacy.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        legacy.setSubjectId(principal.getId());
        legacy.setSource(GrantSources.AGENT_DEFAULT);
        legacy.setScopeType("workspace");
        legacy.setScopeId(workspaceId);
        legacy.setReadState("read");
        legacy.setPermissions(objectMapper.createArrayNode()
                .add(objectMapper.createObjectNode()
                        .put("actionClass", "read").put("resource", "*")));
        grantRepository.saveAndFlush(legacy);

        var cap = agentPrincipalService.resolveCapFor(principal.getId(), workspaceId);

        assertTrue(cap.toString().contains("read"),
                "a principal without role rows keeps the legacy ceiling (rollback path): " + cap);
    }

    private AgentPrincipal createPlainPrincipal(String name) {
        return createPlainPrincipal(name, List.of());
    }

    private AgentPrincipal createPlainPrincipal(String name, List<UUID> roleIds) {
        var template = agentTemplateService.resolveForCreation(userId, workspaceId.toString(), null);
        return agentPrincipalService.createPrincipal(userId, name, null, template.snapshot(),
                null, null, null, null, null, null, roleIds);
    }

    /** A minimal cap that both the principal and the actor hold — the binding is optional narrowing. */
    private void bindToWorkspace(UUID principalId) {
        var cap = objectMapper.createArrayNode()
                .add(objectMapper.createObjectNode().put("actionClass", "read").put("resource", "*"));
        agentPrincipalService.setWorkspaceCap(userId, workspaceId, principalId, cap);
    }

    private List<AuthorizationGrant> roleGrants(UUID principalId, String source) {
        return grantRepository
                .findScopedGrants(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                        List.of(source), workspaceId)
                .stream()
                .filter(row -> "workspace".equals(row.getScopeType()))
                .toList();
    }

    private List<String> roleAtomNames(UUID principalId) {
        return roleGrants(principalId, GrantSources.ROLE).stream()
                .map(row -> row.getPermissions().path(0).path("actionClass").asText())
                .toList();
    }
}
