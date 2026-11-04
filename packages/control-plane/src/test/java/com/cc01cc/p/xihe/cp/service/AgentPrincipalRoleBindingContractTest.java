package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
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
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0667 M1/T1.6: the agent-principal role binding API over real HTTP + PostgreSQL.
 *
 * <p>The property that matters most is not "the row is written" but "the agent's capability changed
 * in the same transaction". That is why every write case also asserts the materialized
 * {@code grants(source='role')} rows: a later or async materialization would pass a row-count test
 * and still leave the agent unauthorized for its next session (the failure mode PLAN-0660 hit from
 * the other side).</p>
 */
class AgentPrincipalRoleBindingContractTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private AccessRoleRepository roleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository roleBindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private User owner;
    private String ownerToken;
    private Workspace workspace;
    private AgentPrincipal principal;
    private UUID testRoleId;
    private final java.util.List<UUID> extraUsers = new java.util.ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        if (principal != null) {
            jdbcTemplate.update("DELETE FROM role_bindings WHERE subject_type = 'agent_principal'"
                    + " AND subject_id = ?::uuid", principal.getId().toString());
            jdbcTemplate.update("DELETE FROM grants WHERE subject_type = 'agent_principal'"
                    + " AND subject_id = ?::uuid", principal.getId().toString());
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(resource_id AS VARCHAR) LIKE ?",
                    principal.getId().toString() + "%");
            workspaceAgentRepository.deleteAll(workspaceAgentRepository.findByIdPrincipalId(principal.getId()));
            principalRepository.deleteById(principal.getId());
        }
        if (workspace != null) {
            jdbcTemplate.update("DELETE FROM workspace_agents WHERE workspace_id = ?::uuid",
                    workspace.getId().toString());
            jdbcTemplate.update("DELETE FROM role_bindings WHERE scope_type = 'workspace'"
                    + " AND scope_id = ?::uuid", workspace.getId().toString());
            workspaceRepository.deleteById(workspace.getId());
        }
        if (owner != null) {
            jdbcTemplate.update("DELETE FROM grants WHERE subject_type = 'user' AND subject_id = ?::uuid",
                    owner.getId().toString());
            jdbcTemplate.update("DELETE FROM role_bindings WHERE subject_type = 'user'"
                    + " AND subject_id = ?::uuid", owner.getId().toString());
            userRepository.deleteById(owner.getId());
        }
        for (UUID id : extraUsers) {
            userRepository.deleteById(id);
        }
        if (testRoleId != null) {
            permissionRepository.deleteAll(permissionRepository.findByIdRoleId(testRoleId));
            roleRepository.deleteById(testRoleId);
        }
        for (UUID authorityRoleId : authorityRoleIds) {
            permissionRepository.deleteAll(permissionRepository.findByIdRoleId(authorityRoleId));
            roleRepository.deleteById(authorityRoleId);
        }
    }

    @Test
    void bindWorkspaceRoleMaterializesGrantsInTheSameTransaction() {
        fixture();
        UUID roleId = createCustomRole("network", "CREATE_SCHEDULED_TASK");
        int before = totalBindingCount();

        ResponseEntity<Map> created = post("/roles?workspaceId=" + workspace.getId(),
                Map.of("roleId", roleId.toString()));

        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        Map<String, Object> body = created.getBody();
        assertNotNull(body);
        assertEquals(false, body.get("isSystem"));
        assertEquals("workspace", body.get("scopeType"));
        assertEquals(workspace.getId().toString(), body.get("scopeId"));
        assertEquals(2, body.get("atomCount"));
        assertTrue(((List<?>) body.get("atoms")).containsAll(List.of("出网访问", "创建定时任务")));
        assertTrue(String.valueOf(body.get("name")).startsWith("TEST_RB_"));
        assertNotNull(body.get("displayName"));

        assertEquals(before + 1, totalBindingCount(), "exactly one binding row is written");
        List<String> atoms = materializedAtoms();
        assertTrue(atoms.containsAll(List.of("network", "CREATE_SCHEDULED_TASK")),
                "grants must be materialized in the same transaction, got " + atoms);
    }

    @Test
    void deleteCustomBindingRemovesRowAndRevokesGrants() {
        fixture();
        UUID roleId = createCustomRole("network");
        int before = totalBindingCount();
        ResponseEntity<Map> created = post("/roles?workspaceId=" + workspace.getId(),
                Map.of("roleId", roleId.toString()));
        assertEquals(HttpStatus.CREATED, created.getStatusCode());
        String bindingId = String.valueOf(created.getBody().get("bindingId"));
        assertTrue(materializedAtoms().contains("network"));

        ResponseEntity<String> deleted = delete("/roles/" + bindingId + "?workspaceId=" + workspace.getId());

        assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode(), String.valueOf(deleted.getBody()));
        assertEquals(before, totalBindingCount());
        assertFalse(materializedAtoms().contains("network"),
                "the revoked atom must disappear from the materialized grants immediately");
    }

    @Test
    void seedRoleBindingIsImmutable() {
        fixture();
        int before = totalBindingCount();
        AccessRole seed = roleRepository.findByName("WS_VIEWER").orElseThrow();
        ResponseEntity<Map> created = post("/roles?workspaceId=" + workspace.getId(),
                Map.of("roleId", seed.getId().toString()));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        assertEquals(true, created.getBody().get("isSystem"));

        ResponseEntity<Map> refused = deleteProblem("/roles/" + created.getBody().get("bindingId")
                + "?workspaceId=" + workspace.getId());

        assertEquals(HttpStatus.CONFLICT, refused.getStatusCode());
        assertEquals("ROLE_BINDING_IMMUTABLE", refused.getBody().get("code"));
        assertEquals(before + 1, totalBindingCount(), "the seed binding is still there");
    }

    @Test
    void adminRoleIsRefusedWithAtomNamesOnly() {
        fixture();
        int before = totalBindingCount();
        AccessRole admin = roleRepository.findByName("ADMIN").orElseThrow();

        ResponseEntity<Map> refused = post("/roles",
                Map.of("roleId", admin.getId().toString()));

        assertEquals(HttpStatus.CONFLICT, refused.getStatusCode(), String.valueOf(refused.getBody()));
        Map<String, Object> body = refused.getBody();
        assertEquals("AGENT_PRINCIPAL_FORBIDDEN_ATOMS", body.get("code"));
        String detail = String.valueOf(body.get("detail"));
        assertTrue(detail.contains("instance:admin") || detail.contains("MANAGE_ROLES"),
                "the detail names the forbidden atoms: " + detail);
        assertFalse(detail.contains("\"*\""), "the detail never lists resources: " + detail);
        assertEquals(before, totalBindingCount(), "no row is written for a refused bind");
    }

    @Test
    void duplicateBindingConflictsAndUnknownIdsAreNotFound() {
        fixture();
        UUID roleId = createCustomRole("read");
        assertEquals(HttpStatus.CREATED, post("/roles?workspaceId=" + workspace.getId(),
                Map.of("roleId", roleId.toString())).getStatusCode());

        ResponseEntity<Map> duplicate = post("/roles?workspaceId=" + workspace.getId(),
                Map.of("roleId", roleId.toString()));
        assertEquals(HttpStatus.CONFLICT, duplicate.getStatusCode());
        assertEquals("ROLE_BINDING_EXISTS", duplicate.getBody().get("code"));

        ResponseEntity<Map> unknownRole = post("/roles?workspaceId=" + workspace.getId(),
                Map.of("roleId", UUID.randomUUID().toString()));
        assertEquals(HttpStatus.NOT_FOUND, unknownRole.getStatusCode());
        assertEquals("ROLE_NOT_FOUND", unknownRole.getBody().get("code"));

        ResponseEntity<Map> unknownBinding = deleteProblem("/roles/" + UUID.randomUUID()
                + "?workspaceId=" + workspace.getId());
        assertEquals(HttpStatus.NOT_FOUND, unknownBinding.getStatusCode());
        assertEquals("ROLE_BINDING_NOT_FOUND", unknownBinding.getBody().get("code"));
    }

    @Test
    void listReportsScopeAndAtomSummary() {
        fixture();
        UUID roleId = createCustomRole("network", "CREATE_SCHEDULED_TASK");
        assertEquals(HttpStatus.CREATED, post("/roles?workspaceId=" + workspace.getId(),
                Map.of("roleId", roleId.toString())).getStatusCode());

        ResponseEntity<Map> listed = get("/roles?workspaceId=" + workspace.getId());

        assertEquals(HttpStatus.OK, listed.getStatusCode(), String.valueOf(listed.getBody()));
        List<Map<String, Object>> bindings = (List<Map<String, Object>>) listed.getBody().get("items");
        Map<String, Object> row = bindings.stream()
                .filter(candidate -> roleId.toString().equals(String.valueOf(candidate.get("roleId"))))
                .findFirst().orElseThrow();
        assertEquals(false, row.get("isSystem"));
        assertEquals("workspace", row.get("scopeType"));
        assertEquals(workspace.getName(), row.get("scopeName"));
        assertEquals(2, row.get("atomCount"));
        assertTrue(((List<?>) row.get("atoms")).containsAll(List.of("出网访问", "创建定时任务")));
    }

    @Test
    void atomsAreLocalizedByAcceptLanguage() {
        fixture();
        UUID roleId = createCustomRole("network", "CREATE_SCHEDULED_TASK");
        HttpHeaders headers = authHeaders();
        headers.set(HttpHeaders.ACCEPT_LANGUAGE, "en-US");
        ResponseEntity<Map> created = restTemplate.exchange(
                url(pathFor("/roles?workspaceId=" + workspace.getId())), HttpMethod.POST,
                new HttpEntity<>(Map.of("roleId", roleId.toString()), headers), Map.class);

        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        assertTrue(((List<?>) created.getBody().get("atoms"))
                        .containsAll(List.of("Network access", "Create scheduled task")),
                "labels follow Accept-Language, machine names never leave the server: "
                        + created.getBody().get("atoms"));
    }

    /**
     * PLAN-0667 gap 1 (real-stack): the binding picker needs candidates for a workspace OWNER.
     * Before the fix this call was 403 because {@code GET /api/v1/roles} was hard-gated on
     * {@code MANAGE_ROLES}; now a workspace agent manager gets the agent-bindable subset.
     */
    @Test
    void roleCandidatesAreReadableByWorkspaceOwnerAndFilteredToBindableRoles() {
        fixture();
        ResponseEntity<List> listed = restTemplate.exchange(
                url("/api/v1/roles?workspaceId=" + workspace.getId()), HttpMethod.GET,
                new HttpEntity<>(authHeaders()), List.class);

        assertEquals(HttpStatus.OK, listed.getStatusCode(), String.valueOf(listed.getBody()));
        List<String> names = ((List<Map<String, Object>>) listed.getBody()).stream()
                .map(row -> String.valueOf(row.get("name")))
                .toList();
        assertTrue(names.contains("WS_EDITOR"), "bindable workspace role is listed: " + names);
        assertTrue(!names.contains("ADMIN"), "a role carrying forbidden atoms is not a candidate: " + names);
        assertTrue(!names.contains("SUPER_ADMIN"), "capability role is not a candidate: " + names);
        assertEquals(0, ((List<?>) listed.getBody()).stream()
                .filter(row -> Boolean.TRUE.equals(((Map<?, ?>) row).get("system"))
                        && "ADMIN".equals(((Map<?, ?>) row).get("name")))
                .count(), "no forbidden system role may leak into the candidate list");
    }

    /**
     * Gap 1 boundary: a workspace-tier manager may read candidates only inside a workspace context;
     * without one there is no instance authority to fall back on (403, not an empty list).
     */
    @Test
    void roleCandidatesNeedAWorkspaceContextForWorkspaceTierCallers() {
        fixture();
        User manager = createWorkspaceManager("wsm");
        String managerToken = TestDataFactory.createGlobalToken(
                manager.getId().toString(), manager.getEmail(), "USER", 0);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(managerToken);

        ResponseEntity<Map> withoutContext = restTemplate.exchange(url("/api/v1/roles"),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, withoutContext.getStatusCode(), String.valueOf(withoutContext.getBody()));
        assertEquals("FORBIDDEN", withoutContext.getBody().get("code"));

        ResponseEntity<List> withContext = restTemplate.exchange(
                url("/api/v1/roles?workspaceId=" + workspace.getId()), HttpMethod.GET,
                new HttpEntity<>(headers), List.class);
        assertEquals(HttpStatus.OK, withContext.getStatusCode(), String.valueOf(withContext.getBody()));
        assertTrue(((List<Map<String, Object>>) withContext.getBody()).stream()
                        .anyMatch(row -> "WS_EDITOR".equals(row.get("name"))),
                "workspace manager sees the bindable candidates");
    }

    /** Gap 2: the frozen body is {@code {roleId}} only — a scope sent by the caller is rejected. */
    @Test
    void bindBodyMustNotCarryClientSuppliedScope() {
        fixture();
        UUID roleId = createCustomRole("network");
        int before = totalBindingCount();
        ResponseEntity<Map> refused = post("/roles?workspaceId=" + workspace.getId(),
                Map.of("roleId", roleId.toString(), "scopeType", "workspace"));

        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatusCode());
        assertEquals("INVALID_REQUEST", refused.getBody().get("code"));
        assertEquals(before, totalBindingCount());
    }

    @Test
    void callerWithoutBindingAuthorityIsForbidden() {
        fixture();
        User stranger = userRepository.saveAndFlush(new User(
                "rb-stranger-" + UUID.randomUUID() + "@test.com", "hash", "Stranger"));
        extraUsers.add(stranger.getId());
        String strangerToken = TestDataFactory.createGlobalToken(
                stranger.getId().toString(), stranger.getEmail(), "USER", 0);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(strangerToken);
        ResponseEntity<Map> forbidden = restTemplate.exchange(
                url("/api/v1/agent-principals/" + principal.getId() + "/roles"),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, forbidden.getStatusCode());
        assertEquals("FORBIDDEN", forbidden.getBody().get("code"));
    }

    // ------------------------------------------------------------------ fixtures

    private void fixture() {
        owner = userRepository.saveAndFlush(new User(
                "rb-owner-" + UUID.randomUUID() + "@test.com", "hash", "Binding owner"));
        ownerToken = TestDataFactory.createGlobalToken(owner.getId().toString(), owner.getEmail(), "USER", 0);
        // The binding API's instance tier: a test-only role with the N1 atom, materialized the
        // post-V88 way (role binding + materializer), never a direct grant row.
        UUID authorityRole = UUID.randomUUID();
        roleRepository.save(new AccessRole(authorityRole, "TEST_RB_AUTH_" + shortId(),
                "Binding authority", "test-only", false));
        permissionRepository.save(new AccessRolePermission(authorityRole, "MANAGE_AGENT_PRINCIPALS", "*"));
        roleBindingRepository.save(new AccessRoleBinding(authorityRole, "user", owner.getId(),
                AccessScope.INSTANCE, null, owner.getId()));
        materializer.materializeSubject("user", owner.getId(), owner.getId(), null);
        authorityRoleIds.add(authorityRole);

        workspace = workspaceFixture.ensureOwnedWorkspace(owner.getId());
        workspaceFixture.bindWorkspaceRole(workspace.getId(), owner.getId(),
                com.cc01cc.p.xihe.cp.entity.WorkspaceRole.OWNER);
        materializer.materializeSubject("user", owner.getId(), owner.getId(),
                workspace.getId().toString());

        var template = agentTemplateService.resolveForCreation(
                owner.getId().toString(), workspace.getId().toString(), null);
        principal = agentPrincipalService.createPrincipal(owner.getId().toString(),
                "rbTarget" + shortId(), null, template.snapshot(),
                null, null, null, null, null, null, null, null, List.of());
        JsonNode cap = objectMapper.createArrayNode()
                .add(objectMapper.createObjectNode().put("actionClass", "read").put("resource", "*"));
        agentPrincipalService.setWorkspaceCap(owner.getId().toString(), workspace.getId(),
                principal.getId(), cap);
    }

    private final java.util.List<UUID> authorityRoleIds = new java.util.ArrayList<>();

    private UUID createCustomRole(String... atoms) {
        UUID roleId = UUID.randomUUID();
        roleRepository.save(new AccessRole(roleId, "TEST_RB_" + shortId(), "Test binding role",
                "test-only role", false));
        for (String atom : atoms) {
            permissionRepository.save(new AccessRolePermission(roleId, atom, "*"));
        }
        testRoleId = roleId;
        return roleId;
    }

    private String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 10).toUpperCase();
    }

    /**
     * A real workspace-tier manager: no instance atoms, only MANAGE_WORKSPACE_AGENTS materialized
     * in this workspace. Used to prove the gap-1 read path distinguishes "context given" from
     * "no authority at all".
     */
    private User createWorkspaceManager(String prefix) {
        User manager = userRepository.saveAndFlush(new User(
                prefix + "-" + UUID.randomUUID() + "@test.com", "hash", "Workspace manager"));
        extraUsers.add(manager.getId());
        // Membership so the tenant interceptor accepts the request; the authority under test is
        // the separately materialized MANAGE_WORKSPACE_AGENTS atom, not the member role.
        workspaceFixture.bindWorkspaceRole(workspace.getId(), manager.getId(),
                com.cc01cc.p.xihe.cp.entity.WorkspaceRole.MEMBER);
        UUID roleId = UUID.randomUUID();
        roleRepository.save(new AccessRole(roleId, "TEST_WSM_" + shortId(),
                "Workspace manager (test-only)", "test-only", false));
        permissionRepository.save(new AccessRolePermission(roleId, "MANAGE_WORKSPACE_AGENTS", "*"));
        authorityRoleIds.add(roleId);
        roleBindingRepository.save(new AccessRoleBinding(roleId, "user", manager.getId(),
                AccessScope.WORKSPACE, workspace.getId(), owner.getId()));
        materializer.materializeSubject("user", manager.getId(), owner.getId(),
                workspace.getId().toString());
        return manager;
    }

    /** Total rows of this principal (a created principal carries default role bindings too). */
    private int totalBindingCount() {
        return roleBindingRepository
                .findBySubjectTypeAndSubjectId("agent_principal", principal.getId()).size();
    }

    private List<String> materializedAtoms() {
        return jdbcTemplate.queryForList(
                "SELECT jsonb_array_elements(permissions)->>'actionClass' FROM grants"
                        + " WHERE subject_type = 'agent_principal' AND subject_id = ?::uuid"
                        + " AND scope_type = 'workspace' AND scope_id = ?::uuid",
                String.class, principal.getId().toString(), workspace.getId().toString());
    }

    // ------------------------------------------------------------------ HTTP helpers

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(ownerToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private String pathFor(String suffix) {
        return "/api/v1/agent-principals/" + principal.getId() + suffix;
    }

    private ResponseEntity<Map> get(String suffix) {
        return restTemplate.exchange(url(pathFor(suffix)), HttpMethod.GET,
                new HttpEntity<>(authHeaders()), Map.class);
    }

    private ResponseEntity<Map> post(String suffix, Map<String, Object> body) {
        return restTemplate.exchange(url(pathFor(suffix)), HttpMethod.POST,
                new HttpEntity<>(body, authHeaders()), Map.class);
    }

    private ResponseEntity<String> delete(String suffix) {
        return restTemplate.exchange(url(pathFor(suffix)), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders()), String.class);
    }

    private ResponseEntity<Map> deleteProblem(String suffix) {
        return restTemplate.exchange(url(pathFor(suffix)), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders()), Map.class);
    }
}