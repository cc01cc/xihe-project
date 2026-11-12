package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * D-1109 (46A + 47A, task-64): the workspace-agent cap write accepts an OMITTED permissions array.
 *
 * <p>Guard 1 (the default stays auditable): the row records whether the cap was inherited
 * (cap_source='baseline') or pinned (cap_source='explicit'), so "the field was forgotten" cannot
 * be confused with "inherit on purpose" after the fact.</p>
 * <p>Guard 2 (D-1096): an explicit atom outside the ceilings is refused with 403
 * AGENT_PERMISSION_SCOPE_EXCEEDED - it is never silently truncated to the baseline.</p>
 * <p>Guard 3 (46C): an empty array is an explicit ZERO cap and is never read as "inherit".</p>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class WorkspaceAgentCapSourceIntegrationTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private GrantDefaultService grantDefaultService;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private ObjectMapper objectMapper;

    @AfterEach
    void clearTenant() {
        com.cc01cc.p.xihe.cp.config.TenantContext.clear();
    }

    /** 47A: a binding born from an omitted field carries the whole role baseline (set difference 0). */
    @Test
    void omittedPermissionsInheritTheRoleBaseline() {
        User owner = newUser("inherit");
        grantDefaultService.ensureUserDefault(owner);
        Workspace ws = workspaceFixture.createOwnedWorkspace("CapInherit", owner.getId().toString());
        UUID principal = newPrincipal(owner, "InheritP");

        WorkspaceAgent row = agentPrincipalService.setWorkspaceCap(owner.getId().toString(),
                ws.getId(), principal, null);

        assertEquals(WorkspaceAgent.CAP_SOURCE_BASELINE, row.getCapSource(),
                "an omitted field must be recorded as an inherited cap");
        Set<String> baseline = roleGrantAtoms(principal, ws.getId());
        assertFalse(baseline.isEmpty(), "the structural binding materializes role grants");
        Set<String> capAtoms = atomsOf(row.getPermissionsSnapshot());
        assertTrue(capAtoms.containsAll(baseline),
                "cap must cover the role baseline: missing=" + minus(baseline, capAtoms));
        Set<String> effective = atomsOf(agentPrincipalService.resolveCapFor(principal, ws.getId()));
        assertEquals(baseline, effective, "effective = role ∩ cap = the baseline: " + effective);
        assertEquals(WorkspaceAgent.CAP_SOURCE_BASELINE, capSourceInDatabase(principal, ws.getId()),
                "the provenance is persisted, not just returned");
    }

    /** 46C: an empty array is an explicit ZERO cap; flipping it to inherit must be visible. */
    @Test
    void explicitEmptyCapIsZeroAndNotInheritance() {
        User owner = newUser("zero-cap");
        grantDefaultService.ensureUserDefault(owner);
        Workspace ws = workspaceFixture.createOwnedWorkspace("CapZero", owner.getId().toString());
        UUID principal = newPrincipal(owner, "ZeroP");

        WorkspaceAgent explicitZero = agentPrincipalService.setWorkspaceCap(owner.getId().toString(),
                ws.getId(), principal, json("[]"));
        assertEquals(WorkspaceAgent.CAP_SOURCE_EXPLICIT, explicitZero.getCapSource());
        assertTrue(atomsOf(explicitZero.getPermissionsSnapshot()).isEmpty(),
                "[] is a zero cap, not the baseline");
        assertTrue(agentPrincipalService.resolveCapFor(principal, ws.getId()).isEmpty(),
                "zero cap => zero effective rights even though the role carries atoms");

        WorkspaceAgent inherited = agentPrincipalService.setWorkspaceCap(owner.getId().toString(),
                ws.getId(), principal, null);
        assertEquals(WorkspaceAgent.CAP_SOURCE_BASELINE, inherited.getCapSource(),
                "explicit [] -> omitted is a provenance change, not a no-op");
        assertEquals(WorkspaceAgent.CAP_SOURCE_BASELINE, capSourceInDatabase(principal, ws.getId()));
        assertFalse(atomsOf(agentPrincipalService.resolveCapFor(principal, ws.getId())).isEmpty(),
                "inheriting restores the reach the zero cap had removed");
    }

    /** D-1096: an explicit over-ceiling atom is refused - never truncated to the baseline. */
    @Test
    void explicitExceedingAtomIsRefusedNotTruncated() {
        User owner = newUser("over-cap");
        grantDefaultService.ensureUserDefault(owner);
        Workspace ws = workspaceFixture.createOwnedWorkspace("CapOver", owner.getId().toString());
        UUID principal = newPrincipal(owner, "OverP");
        // The ACTOR holds the atom instance-wide; the PRINCIPAL has no such grant, so the
        // principal-side ceiling is what refuses this cap.
        UUID actorRole = roleWith("TEST_CAPSRC_POLICY", ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY);
        bindingRepository.save(new AccessRoleBinding(actorRole, "user", owner.getId(),
                AccessScope.INSTANCE, null, owner.getId()));
        materializer.materializeSubject("user", owner.getId(), owner.getId(), null);

        String atom = ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY;
        String requested = "[{\"actionClass\":\"" + atom + "\",\"resource\":\"*\"}]";
        CpApiException denied = assertThrows(CpApiException.class,
                () -> agentPrincipalService.setWorkspaceCap(owner.getId().toString(), ws.getId(),
                        principal, json(requested)));
        assertEquals("AGENT_PERMISSION_SCOPE_EXCEEDED", denied.getCode());
        assertTrue(denied.getMessage().contains("principal-exceeding=[" + atom + "@*]"),
                "the refused atom is named: " + denied.getMessage());
        assertFalse(workspaceAgentRepository.existsById(new WorkspaceAgentId(principal, ws.getId())),
                "a refusal must not leave a baseline-truncated row behind (D-1096)");
    }

    /** Wire face: the field is optional, an empty body inherits, foreign keys stay 400. */
    @Test
    void emptyBodyInheritsWhileForeignKeysStayRejected() {
        User owner = newUser("http-cap");
        grantDefaultService.ensureUserDefault(owner);
        Workspace ws = workspaceFixture.createOwnedWorkspace("CapHttp", owner.getId().toString());
        UUID principal = newPrincipal(owner, "HttpP");
        HttpHeaders headers = headersFor(owner, ws);

        var inherited = restTemplate.exchange(
                url("/api/v1/workspaces/" + ws.getId() + "/agents/" + principal),
                HttpMethod.PUT, new HttpEntity<>(Map.of(), headers), String.class);
        assertEquals(HttpStatus.OK, inherited.getStatusCode(), String.valueOf(inherited.getBody()));
        assertTrue(String.valueOf(inherited.getBody()).contains("\"capSource\":\"baseline\""),
                "an empty body inherits the baseline: " + inherited.getBody());
        assertEquals(WorkspaceAgent.CAP_SOURCE_BASELINE, capSourceInDatabase(principal, ws.getId()));

        var foreignKey = restTemplate.exchange(
                url("/api/v1/workspaces/" + ws.getId() + "/agents/" + principal),
                HttpMethod.PUT,
                new HttpEntity<>(Map.of("permissions", List.of(), "unexpected", "x"), headers),
                String.class);
        assertEquals(HttpStatus.BAD_REQUEST, foreignKey.getStatusCode(),
                "a second body key is still a shape error: " + foreignKey.getBody());
        assertTrue(String.valueOf(foreignKey.getBody()).contains("INVALID_REQUEST"),
                String.valueOf(foreignKey.getBody()));
        assertEquals(WorkspaceAgent.CAP_SOURCE_BASELINE, capSourceInDatabase(principal, ws.getId()),
                "a rejected call must not rewrite the stored provenance");
    }

    private HttpHeaders headersFor(User user, Workspace ws) {
        String token = TestDataFactory.createWorkspaceToken(user.getId().toString(), user.getEmail(),
                "OWNER", ws.getId().toString(), 0);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Workspace-Id", ws.getId().toString());
        return headers;
    }

    /** The materialized role grants of this subject in this workspace (source='role'). */
    private Set<String> roleGrantAtoms(UUID principalId, UUID workspaceId) {
        // grants.permissions is a jsonb atom array (RoleGrantMaterializer.atomArray), not columns.
        return new HashSet<>(jdbcTemplate.queryForList(
                "SELECT DISTINCT atom->>'actionClass' FROM grants g,"
                        + " jsonb_array_elements(g.permissions) AS atom"
                        + " WHERE g.subject_type='agent_principal'"
                        + " AND g.subject_id=CAST(? AS UUID) AND g.source='role'"
                        + " AND (g.scope_type='instance' OR (g.scope_type='workspace'"
                        + " AND g.scope_id=CAST(? AS UUID)))",
                String.class, principalId.toString(), workspaceId.toString()));
    }

    private String capSourceInDatabase(UUID principalId, UUID workspaceId) {
        return jdbcTemplate.queryForObject(
                "SELECT cap_source FROM workspace_agents WHERE principal_id=CAST(? AS UUID)"
                        + " AND workspace_id=CAST(? AS UUID)",
                String.class, principalId.toString(), workspaceId.toString());
    }

    private Set<String> atomsOf(JsonNode permissions) {
        return new HashSet<>(permissions.findValuesAsText("actionClass"));
    }

    private static Set<String> minus(Set<String> left, Set<String> right) {
        Set<String> out = new HashSet<>(left);
        out.removeAll(right);
        return out;
    }

    private JsonNode json(String value) {
        try {
            return objectMapper.readTree(value);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private User newUser(String prefix) {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        return userRepository.saveAndFlush(new User(
                prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
    }

    private UUID newPrincipal(User owner, String name) {
        UUID ws = workspaceFixture.ensureOwnedWorkspace(owner.getId()).getId();
        com.cc01cc.p.xihe.cp.config.TenantContext.setUserId(owner.getId().toString());
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspaceId(ws.toString());
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspaceSource("test");
        try {
            var template = agentTemplateService.resolveForCreation(
                    owner.getId().toString(), ws.toString(), null);
            return agentPrincipalService.createPrincipal(owner.getId().toString(), name, null,
                    template.snapshot(), null, null, null, null, null, null, null).getId();
        } finally {
            com.cc01cc.p.xihe.cp.config.TenantContext.clear();
        }
    }

    private UUID roleWith(String name, String... atoms) {
        AccessRole role = accessRoleRepository.saveAndFlush(new AccessRole(
                UUID.randomUUID(), name, name, "test-only", false));
        for (String atom : atoms) {
            permissionRepository.saveAndFlush(new AccessRolePermission(
                    role.getId(), atom, com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog.atom(atom)
                            .canonicalResource()));
        }
        return role.getId();
    }
}
