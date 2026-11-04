package com.cc01cc.p.xihe.cp.service;
import com.cc01cc.p.xihe.cp.policy.GrantSources;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import java.util.Set;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0496 M1 (T1.2): the credential naming rule at the two write boundaries —
 * principal minting reports uncovered credential atoms explicitly (422 listing the
 * ids) while other atoms keep silent narrowing; the workspace cap uses the same
 * rule ({@code credential:*} ceiling covers any id, exact ids are equal-only, 403).
 */
class AgentPrincipalCredentialBoundaryTest extends AbstractIntegrationTest {

    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AuthService authService;
    @Autowired private WorkspaceService workspaceService;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository roleBindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private ObjectMapper objectMapper;

    private UUID creatorId;
    private UUID creatorRoleId;
    private String workspaceId;
    private final List<UUID> principalIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        principalIds.forEach(principalId -> {
            workspaceAgentRepository.deleteAll(workspaceAgentRepository.findByIdPrincipalId(principalId));
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            agentPrincipalRepository.deleteById(principalId);
        });
        if (creatorId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.USER, creatorId));
            roleBindingRepository.deleteAll(
                    roleBindingRepository.findBySubjectTypeAndSubjectId("user", creatorId));
            auditLogRepository.deleteAll(
                    auditLogRepository.findByUserIdOrderByCreatedAtDesc(creatorId.toString()));
            if (workspaceId != null) {
                UUID workspaceUuid = UUID.fromString(workspaceId);
                workspaceFixture.unbindWorkspace(workspaceUuid);
                workspaceRepository.deleteById(workspaceUuid);
            }
            userRepository.deleteById(creatorId);
        }
        if (creatorRoleId != null) {
            permissionRepository.deleteAll(permissionRepository.findByIdRoleId(creatorRoleId));
            accessRoleRepository.deleteById(creatorRoleId);
            creatorRoleId = null;
        }
    }

    @Test
    void creationRejectsUncoveredCredentialAtomsWith422ListingTheIds() {
        registerCreator();
        String credentialId = "credential:" + UUID.randomUUID();

        CpApiException error = assertThrows(CpApiException.class, () ->
                agentPrincipalService.createPrincipal(creatorId.toString(), "uncoveredAgent", null,
                        snapshot("""
                                [{"actionClass":"read"},
                                 {"actionClass":"credential_use","resource":"%s"}]
                                """.formatted(credentialId))));

        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, error.getStatus());
        assertEquals("CREDENTIAL_ATOMS_NOT_COVERED", error.getCode());
        assertTrue(error.getMessage().contains(credentialId),
                "the 422 detail must list the uncovered ids: " + error.getMessage());
    }

    @Test
    void coveredCredentialAtomComesFromABoundRoleNotFromTheTemplateSnapshot() {
        registerCreator();
        grantCreator("""
                [{"actionClass":"credential_use","resource":"credential:*"}]
                """);
        String credentialId = "credential:" + UUID.randomUUID();

        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                creatorId.toString(), "coveredAgent", null,
                snapshot("""
                        [{"actionClass":"read"},
                         {"actionClass":"credential_use","resource":"%s"}]
                        """.formatted(credentialId)));
        principalIds.add(principal.getId());

        // 2026-11-04 裁定（role 行唯一权威源）：template 快照写已删除 ⇒ 模板里的 credential 原子不落库，
        // 主体只有默认实例角色的原子集；要拿到它必须由角色携带（先绑角色，再设 cap）。
        assertFalse(actionClassNames(principalGrant(principal.getId())).contains("credential_use"),
                "a template-only credential atom must not materialize: "
                        + principalGrant(principal.getId()));

        CpApiException denied = assertThrows(CpApiException.class, () ->
                agentPrincipalService.setWorkspaceCap(creatorId.toString(), UUID.fromString(workspaceId),
                        principal.getId(), permissions("""
                                [{"actionClass":"credential_use","resource":"%s"}]
                                """.formatted(credentialId))));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals("AGENT_PERMISSION_SCOPE_EXCEEDED", denied.getCode());

        grantRoleAtom(principal.getId(), """
                [{"actionClass":"credential_use","resource":"%s"}]
                """.formatted(credentialId));
        assertDoesNotThrow(() -> agentPrincipalService.setWorkspaceCap(creatorId.toString(),
                UUID.fromString(workspaceId), principal.getId(), permissions("""
                        [{"actionClass":"credential_use","resource":"%s"}]
                        """.formatted(credentialId))),
                "with the atom carried by a bound role, the cap is accepted");
    }

    @Test
    void templateOnlyAtomsAreNeverMaterializedForANewPrincipal() {
        registerCreator();

        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                creatorId.toString(), "narrowedAgent", null,
                snapshot("""
                        [{"actionClass":"read"},{"actionClass":"SPAWN_AGENT"}]
                        """));
        principalIds.add(principal.getId());

        // 原断言"被 creator grants 收窄成 read"过时：模板快照不再落库，主体拿到的就是默认角色的原子集。
        Set<String> atoms = actionClassNames(principalGrant(principal.getId()));
        assertTrue(atoms.contains("read"), "the default role still grants read: " + atoms);
        assertFalse(atoms.contains("SPAWN_AGENT"),
                "a template-only SPAWN_AGENT must not materialize: " + atoms);
    }

    @Test
    void workspaceCapUsesTheCredentialNamingRule() {
        registerCreator();
        grantCreator("""
                [{"actionClass":"MANAGE_WORKSPACE_AGENTS"}]
                """);
        grantCreator("""
                [{"actionClass":"credential_use","resource":"credential:*"}]
                """);
        String credentialId = "credential:" + UUID.randomUUID();
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                creatorId.toString(), "capAgent", null,
                snapshot("""
                        [{"actionClass":"credential_use","resource":"%s"}]
                        """.formatted(credentialId)));
        principalIds.add(principal.getId());
        // 2026-11-04 裁定（role 行是唯一权威源）：cap 的 ceiling 读 role 行，而 template 派生行已降级为
        // legacy-only，所以这里把 credential 原子写进一条 role 行（与"先绑角色再设 cap"等价的最小形态）。
        grantRoleAtom(principal.getId(), """
                [{"actionClass":"credential_use","resource":"%s"}]
                """.formatted(credentialId));
        UUID workspaceUuid = UUID.fromString(workspaceId);

        // A concrete cap under a wildcard ceiling is allowed by the naming rule.
        agentPrincipalService.setWorkspaceCap(creatorId.toString(), workspaceUuid, principal.getId(),
                permissions("""
                        [{"actionClass":"credential_use","resource":"%s"}]
                        """.formatted(credentialId)));

        // A wildcard cap over a concrete principal atom exceeds the ceiling (403).
        CpApiException error = assertThrows(CpApiException.class, () ->
                agentPrincipalService.setWorkspaceCap(creatorId.toString(), workspaceUuid,
                        principal.getId(), permissions("""
                                [{"actionClass":"credential_use","resource":"credential:*"}]
                                """)));
        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
        assertEquals("AGENT_PERMISSION_SCOPE_EXCEEDED", error.getCode());
    }

    /**
     * 反向契约（2026-11-04 裁定「role 行是唯一权威源」）：只有 template 派生行、没有角色携带该原子时，
     * `setWorkspaceCap` 必须 403 —— 把这条不对称固定下来，别让它以后被当成 bug 改回去。
     */
    @Test
    void templateOnlyGrantDoesNotAuthorizeAWorkspaceCap() {
        registerCreator();
        grantCreator("""
                [{"actionClass":"MANAGE_WORKSPACE_AGENTS"}]
                """);
        grantCreator("""
                [{"actionClass":"credential_use","resource":"credential:*"}]
                """);
        String credentialId = "credential:" + UUID.randomUUID();
        AgentPrincipal principal = agentPrincipalService.createPrincipal(creatorId.toString(),
                "legacyOnlyAgent", null, snapshot("""
                        [{"actionClass":"credential_use","resource":"%s"}]
                        """.formatted(credentialId)));
        principalIds.add(principal.getId());

        CpApiException error = assertThrows(CpApiException.class, () ->
                agentPrincipalService.setWorkspaceCap(creatorId.toString(), UUID.fromString(workspaceId),
                        principal.getId(), permissions("""
                                [{"actionClass":"credential_use","resource":"%s"}]
                                """.formatted(credentialId))));

        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
        assertEquals("AGENT_PERMISSION_SCOPE_EXCEEDED", error.getCode());
    }

    private void registerCreator() {
        User user = authService.registerUser(new RegisterRequest(
                "cred-boundary-" + UUID.randomUUID() + "@test.com",
                "boundary-test-password", "Boundary Test"));
        AuthResponse registered = authService.issueTokens(user, workspaceFixture.createOwnedWorkspace("Fixture Workspace", user.getId().toString()).getId().toString());
        creatorId = user.getId();
        workspaceId = registered.getWorkspaceId();
    }

    /**
     * W1c: the creator's ceiling is seeded the post-W1 way — a test-only role bound at instance scope
     * and materialized into {@code grants(source='role')}.
     *
     * <p>The helper used to merge into a single {@code source='direct'} row. The authorization gates
     * no longer read that source ({@code GrantSources.EVALUATION_SOURCES} excludes the retired rows),
     * which is the intended end state: after V88 direct is not an authorization input. Successive
     * calls accumulate atoms on the same role, exactly like the old merge.</p>
     */
    private void grantCreator(String permissionsJson) {
        if (creatorRoleId == null) {
            creatorRoleId = UUID.randomUUID();
            accessRoleRepository.save(new AccessRole(creatorRoleId, "TEST_CREATOR_" + creatorRoleId.toString().replace("-", "").toUpperCase(),
                    "Boundary test creator", "test-only role", false));
            roleBindingRepository.save(new AccessRoleBinding(creatorRoleId, "user", creatorId,
                    AccessScope.INSTANCE, null, creatorId));
        }
        for (JsonNode atom : permissions(permissionsJson)) {
            String actionClass = atom.path("actionClass").asText();
            String resource = atom.has("resource") ? atom.path("resource").asText()
                    : com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog.WILDCARD;
            permissionRepository.save(new AccessRolePermission(creatorRoleId, actionClass, resource));
        }
        materializer.materializeSubject("user", creatorId, creatorId, null);
    }

    /**
     * 2026-11-04 裁定（PLAN-0629「role 行是唯一权威源」）：creation 不再写 template/agent_default
     * 快照行（`createAgentPrincipalGrant` 已删除），所以"模板原子被 creator grants 收窄"只能从
     * **role 行**观察：主体拿到的就是它绑定的角色原子。
     */
    private JsonNode principalGrant(UUID principalId) {
        com.fasterxml.jackson.databind.node.ArrayNode merged = objectMapper.createArrayNode();
        grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId).stream()
                .filter(grant -> GrantSources.ROLE.equals(grant.getSource()))
                .forEach(grant -> grant.getPermissions().forEach(merged::add));
        assertTrue(merged.size() > 0, "a created principal must carry its bound-role atoms");
        return merged;
    }

    private JsonNode snapshot(String permissionsJson) {
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.put("systemPrompt", "boundary-agent-prompt");
        snapshot.set("permissions", permissions(permissionsJson));
        return snapshot;
    }

    /** 直接写一条 source='role' 的授权行：这是求值唯一认的权威源（legacy-only 行不算）。 */
    private void grantRoleAtom(UUID principalId, String permissionsJson) {
        com.cc01cc.p.xihe.cp.entity.AuthorizationGrant grant =
                new com.cc01cc.p.xihe.cp.entity.AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(creatorId);
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principalId);
        grant.setSource(com.cc01cc.p.xihe.cp.policy.GrantSources.ROLE);
        grant.setReadState("read");
        grant.setPermissions(permissions(permissionsJson));
        grantRepository.saveAndFlush(grant);
    }

    private static Set<String> actionClassNames(JsonNode permissions) {
        Set<String> names = new java.util.LinkedHashSet<>();
        permissions.forEach(atom -> names.add(atom.path("actionClass").asText()));
        return names;
    }

    private JsonNode permissions(String permissionsJson) {
        try {
            return objectMapper.readTree(permissionsJson);
        } catch (JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }
}
