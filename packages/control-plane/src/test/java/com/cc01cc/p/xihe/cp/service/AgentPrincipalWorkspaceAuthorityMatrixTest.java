package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
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
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.RestTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * BL-331 / D-206 (方案 A, 2026-11-05 user ruling): who may change a <b>workspace-bound</b> agent
 * principal — the 2×3 authority matrix, plus the two refutations that prove each cell rides a real gate.
 *
 * <p>Ratified semantics: the instance atom ({@code MANAGE_AGENT_PRINCIPALS}) is an <b>override
 * channel</b>, the legacy {@code owner_user_id} still authorizes its own row, and — new — an actor
 * holding {@code MANAGE_WORKSPACE_AGENTS} <b>in a workspace that binds the principal</b> may manage it,
 * exactly like {@code setWorkspaceCap} / {@code unbindWorkspace}. The plain creator is deliberately
 * <b>not</b> an authority: creating a workspace-bound principal is a workspace operation, and its
 * lifecycle write belongs to the same workspace authority (before D-206 it answered 403 for everyone
 * except instance admins — the P1 gap).</p>
 *
 * <p>Gate order stays the D22 one: context {@code 409} → existence {@code 404} → authority {@code 403}.</p>
 */
class AgentPrincipalWorkspaceAuthorityMatrixTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository roleBindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private GrantDefaultService grantDefaultService;
    @Autowired private AuthzContext authzContext;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private final RestTemplate patchClient = patchCapableClient();
    private final List<UUID> seededRoleIds = new java.util.ArrayList<>();
    private final List<UUID> seededUserIds = new java.util.ArrayList<>();

    private UUID workspaceId;
    private String workspaceOwnerUserId;
    private UUID creatorUserId;
    private UUID workspaceAdminUserId;
    private UUID instanceAdminUserId;
    private final List<UUID> principalIds = new java.util.ArrayList<>();

    private static RestTemplate patchCapableClient() {
        RestTemplate client = new RestTemplate(new JdkClientHttpRequestFactory());
        client.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.client.ClientHttpResponse response)
                    throws java.io.IOException {
                // 4xx is data here (the matrix asserts codes); only 5xx is a test failure.
                return response.getStatusCode().is5xxServerError();
            }
        });
        return client;
    }

    @AfterEach
    void cleanFixtures() {
        for (UUID principalId : principalIds) {
            jdbcTemplate.update("DELETE FROM workspace_agents WHERE principal_id = ?", principalId);
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(resource_id AS VARCHAR) = ?",
                    principalId.toString());
            grantRepository.deleteAll(
                    grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
            principalRepository.deleteById(principalId);
        }
        for (UUID userId : seededUserIds) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
            roleBindingRepository.deleteAll(
                    roleBindingRepository.findBySubjectTypeAndSubjectId("user", userId));
        }
        for (UUID roleId : seededRoleIds) {
            permissionRepository.deleteAll(permissionRepository.findByIdRoleId(roleId));
            accessRoleRepository.deleteById(roleId);
        }
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        for (UUID userId : seededUserIds) {
            userRepository.deleteById(userId);
        }
        authzContext.invalidateAll();
    }

    // ------------------------------------------------------------------ the matrix

    @Test
    void matrixCreatorHasNoAuthorityWorkspaceAdminAndInstanceAdminDo() {
        fixture();

        // ① creator: created_by = creator, owner column null (D-174 semantics), bound to the workspace.
        assertCell(identity(creatorUserId), Operation.DISABLE, HttpStatus.FORBIDDEN,
                "AGENT_PRINCIPAL_OWNER_MISMATCH",
                "① creator without a workspace management atom must be refused (BL-331 方案 A)");
        assertCell(identity(creatorUserId), Operation.PATCH, HttpStatus.FORBIDDEN,
                "AGENT_PRINCIPAL_OWNER_MISMATCH", "① creator PATCH must be refused too");

        // ② workspace admin: MANAGE_WORKSPACE_AGENTS in the workspace that binds the principal.
        assertCell(identity(workspaceAdminUserId), Operation.DISABLE, HttpStatus.NO_CONTENT, null,
                "② workspace admin may disable a principal its workspace binds (D-206 addition)");
        assertCell(identity(workspaceAdminUserId), Operation.PATCH, HttpStatus.OK, null,
                "② workspace admin may PATCH the same row (same authority family)");

        // ③ instance admin: MANAGE_AGENT_PRINCIPALS (override channel, unchanged).
        assertCell(identity(instanceAdminUserId), Operation.DISABLE, HttpStatus.NO_CONTENT, null,
                "③ instance admin keeps the cross-workspace override channel");
        assertCell(identity(instanceAdminUserId), Operation.PATCH, HttpStatus.OK, null,
                "③ instance admin keeps PATCH through the override channel");
    }

    // ------------------------------------------------------------------ refutations

    @Test
    void revokingTheWorkspaceAtomFlipsTheWorkspaceAdminCellTo403() {
        fixture();
        Seeded seeded = seedManagementAtom(workspaceAdminUserId, AccessScope.WORKSPACE, workspaceId,
                ToolFaceConstants.MANAGE_WORKSPACE_AGENTS, workspaceId.toString());
        assertCell(identity(workspaceAdminUserId), Operation.DISABLE, HttpStatus.NO_CONTENT, null,
                "control: with the atom the workspace admin passes");

        revoke(seeded.bindingId(), seeded.roleId(), workspaceAdminUserId);
        assertCell(identity(workspaceAdminUserId), Operation.DISABLE, HttpStatus.FORBIDDEN,
                "AGENT_PRINCIPAL_OWNER_MISMATCH",
                "refutation: without MANAGE_WORKSPACE_AGENTS the workspace cell must go red — "
                        + "otherwise the gate is 'anyone may pass', not a real door");
    }

    @Test
    void revokingTheInstanceAtomFlipsTheInstanceAdminCellTo403() {
        fixture();
        Seeded seeded = seedManagementAtom(instanceAdminUserId, AccessScope.INSTANCE, null,
                ToolFaceConstants.MANAGE_AGENT_PRINCIPALS, "*");
        assertCell(identity(instanceAdminUserId), Operation.DISABLE, HttpStatus.NO_CONTENT, null,
                "control: with the atom the instance admin passes");

        revoke(seeded.bindingId(), seeded.roleId(), instanceAdminUserId);
        assertCell(identity(instanceAdminUserId), Operation.DISABLE, HttpStatus.FORBIDDEN,
                "AGENT_PRINCIPAL_OWNER_MISMATCH",
                "refutation: without MANAGE_AGENT_PRINCIPALS the override channel must close");
    }

    // ------------------------------------------------------------------ request plumbing

    private enum Operation { DISABLE, PATCH }

    private HttpResponse identity(UUID actorUserId) {
        return new HttpResponse(actorUserId);
    }

    private record HttpResponse(UUID actorUserId) {
    }

    private void assertCell(HttpResponse actor, Operation operation, HttpStatus expected,
                            String expectedCode, String why) {
        UUID principalId = seedWorkspaceBoundPrincipal();
        ResponseEntity<Map> response = operation == Operation.DISABLE
                ? call(actor, HttpMethod.POST, "/api/v1/agent-principals/" + principalId + "/disable", null)
                : call(actor, HttpMethod.PATCH, "/api/v1/agent-principals/" + principalId,
                        // D29-25 shape: memory policy document (a hooks PATCH needs a non-empty
                        // advisors array, which is not what this matrix is about).
                        Map.of("contextPolicy", Map.of("memory", Map.of("enabled", true))));
        assertEquals(expected, response.getStatusCode(), why + " — body=" + response.getBody());
        if (expectedCode != null) {
            assertEquals(expectedCode, response.getBody().get("code"), why);
        }
        principalIds.add(principalId);
    }

    private ResponseEntity<Map> call(HttpResponse actor, HttpMethod method, String path, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(TestDataFactory.createGlobalToken(
                actor.actorUserId().toString(),
                userRepository.findById(actor.actorUserId()).orElseThrow().getEmail(), "USER", 0));
        headers.setContentType(MediaType.APPLICATION_JSON);
        // D22: the write face requires an explicit workspace context; D-206 authority is evaluated
        // against the workspaces that bind the principal, not against this header alone.
        headers.set("X-Workspace-Id", workspaceId.toString());
        return patchClient.exchange(url(path), method, new HttpEntity<>(body, headers), Map.class);
    }

    /** A principal created by ①, unowned (`owner_user_id` null, D-174 semantics), bound to the ws. */
    private UUID seedWorkspaceBoundPrincipal() {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("matrixAgent" + UUID.randomUUID().toString().substring(0, 8));
        principal.setCreatedByUserId(creatorUserId.toString());
        principal.setTemplateId("template-1");
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        principal = principalRepository.saveAndFlush(principal);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(
                principal.getId().toString(), workspaceId.toString(), objectMapper.createArrayNode()));
        return principal.getId();
    }

    // ------------------------------------------------------------------ fixtures

    private void fixture() {
        User owner = newUser("matrix-ws-owner");
        workspaceOwnerUserId = owner.getId().toString();
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Authority matrix ws",
                workspaceOwnerUserId);
        workspaceId = workspace.getId();

        creatorUserId = newMember("matrix-creator");
        workspaceAdminUserId = newMember("matrix-ws-admin");
        instanceAdminUserId = newMember("matrix-instance-admin");

        // ② workspace admin: MANAGE_WORKSPACE_AGENTS scoped to this workspace.
        seedManagementAtom(workspaceAdminUserId, AccessScope.WORKSPACE, workspaceId,
                ToolFaceConstants.MANAGE_WORKSPACE_AGENTS, workspaceId.toString());
        // ③ instance admin: MANAGE_AGENT_PRINCIPALS at instance scope (override channel).
        seedManagementAtom(instanceAdminUserId, AccessScope.INSTANCE, null,
                ToolFaceConstants.MANAGE_AGENT_PRINCIPALS, "*");
    }

    private UUID newMember(String prefix) {
        User user = newUser(prefix);
        workspaceFixture.bindWorkspaceRole(workspaceId, user.getId(), WorkspaceRole.MEMBER);
        return user.getId();
    }

    private User newUser(String prefix) {
        User user = userRepository.saveAndFlush(new User(prefix + "-" + UUID.randomUUID() + "@test.com",
                "hash", "Matrix " + prefix));
        seededUserIds.add(user.getId());
        grantDefaultService.ensureUserDefault(user);
        return user;
    }

    /**
     * Seeds a test-only role carrying exactly one atom, binds it (workspace or instance scope) and
     * materializes it, mirroring the production path. Returns the binding id so a refutation can
     * revoke it.
     */
    /** A seeded test-only role + binding, so a refutation can revoke exactly that grant. */
    private record Seeded(UUID roleId, UUID bindingId) {
    }

    private Seeded seedManagementAtom(UUID userId, String scopeType, UUID scopeId, String atom,
                                      String resource) {
        UUID roleId = UUID.randomUUID();
        accessRoleRepository.saveAndFlush(new AccessRole(roleId,
                "TEST_MATRIX_" + roleId.toString().replace("-", "").substring(0, 10).toUpperCase(),
                "Test matrix role", "test-only role for the BL-331 authority matrix", false));
        permissionRepository.saveAndFlush(new AccessRolePermission(roleId, atom, resource));
        seededRoleIds.add(roleId);
        AccessRoleBinding binding = roleBindingRepository.saveAndFlush(new AccessRoleBinding(
                roleId, "user", userId, scopeType, scopeId, userId));
        materializer.materializeSubject("user", userId, userId,
                AccessScope.WORKSPACE.equals(scopeType) ? scopeId.toString() : null);
        authzContext.invalidateAll();
        return new Seeded(roleId, binding.getId());
    }

    private void revoke(UUID bindingId, UUID roleId, UUID userId) {
        jdbcTemplate.update("DELETE FROM role_permissions WHERE role_id = ?", roleId);
        jdbcTemplate.update("DELETE FROM role_bindings WHERE id = ?", bindingId);
        jdbcTemplate.update("DELETE FROM grants WHERE subject_type = 'user' AND subject_id = ?",
                userId);
        authzContext.invalidateAll();
    }

    /** Local copy of the two atom names so the test reads as a matrix (no magic strings inline). */
    private static final class ToolFaceConstants {
        static final String MANAGE_WORKSPACE_AGENTS =
                com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS;
        static final String MANAGE_AGENT_PRINCIPALS =
                com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS;
    }
}
