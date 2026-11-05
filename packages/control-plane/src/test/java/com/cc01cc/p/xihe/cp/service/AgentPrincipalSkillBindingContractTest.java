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
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.skill.Skill;
import com.cc01cc.p.xihe.cp.skill.SkillBinding;
import com.cc01cc.p.xihe.cp.skill.SkillBindingRepository;
import com.cc01cc.p.xihe.cp.skill.SkillRepository;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0667 M2/T2.4: the agent-principal skill binding API over real HTTP + PostgreSQL.
 *
 * <p>Besides the CRUD contract, the test pins the two properties the plan cares about:</p>
 * <ul>
 *   <li>the server, not the caller, decides {@code scope_type='instance'} / {@code scope_id=null}
 *       (a request cannot smuggle a workspace scope through the nested endpoint);</li>
 *   <li>the agent-session resolution query ({@link SkillBindingRepository#findResolvable}) sees the
 *       new binding immediately — that is the "agent's skill catalog contains the skill" requirement,
 *       asserted at the same layer the session actually reads.</li>
 * </ul>
 */
class AgentPrincipalSkillBindingContractTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private AccessRoleRepository roleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository roleBindingRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private com.cc01cc.p.xihe.cp.policy.GrantDefaultService grantDefaultService;
    @Autowired private SkillRepository skillRepository;
    @Autowired private SkillBindingRepository skillBindingRepository;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private User owner;
    private String ownerToken;
    private Workspace workspace;
    private AgentPrincipal principal;
    private final List<UUID> skillIds = new java.util.ArrayList<>();
    private final List<UUID> authorityRoleIds = new java.util.ArrayList<>();
    private final List<UUID> extraUsers = new java.util.ArrayList<>();
    private final List<UUID> extraWorkspaceIds = new java.util.ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        if (principal != null) {
            jdbcTemplate.update("DELETE FROM skill_bindings WHERE subject_type = 'agent_principal'"
                    + " AND subject_id = ?::uuid", principal.getId().toString());
            jdbcTemplate.update("DELETE FROM grants WHERE subject_type = 'agent_principal'"
                    + " AND subject_id = ?::uuid", principal.getId().toString());
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(resource_id AS VARCHAR) LIKE ?",
                    principal.getId().toString() + "%");
            workspaceAgentRepository.deleteAll(workspaceAgentRepository.findByIdPrincipalId(principal.getId()));
            principalRepository.deleteById(principal.getId());
        }
        for (UUID skillId : skillIds) {
            jdbcTemplate.update("DELETE FROM skill_bindings WHERE skill_id = ?::uuid", skillId.toString());
            skillRepository.deleteById(skillId);
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
        for (UUID id : extraWorkspaceIds) {
            jdbcTemplate.update("DELETE FROM workspace_agents WHERE workspace_id = ?::uuid", id.toString());
            jdbcTemplate.update("DELETE FROM role_bindings WHERE scope_type = 'workspace'"
                    + " AND scope_id = ?::uuid", id.toString());
            workspaceRepository.deleteById(id);
        }
        for (UUID roleId : authorityRoleIds) {
            permissionRepository.deleteAll(permissionRepository.findByIdRoleId(roleId));
            roleRepository.deleteById(roleId);
        }
    }

    @Test
    void bindPersistsInstanceScopeAndTheResolverSeesIt() {
        fixture();
        UUID skillId = createInstanceSkill("skill-a", 12);

        ResponseEntity<Map> created = post("/skills", Map.of("skillId", skillId.toString()));

        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        Map<String, Object> body = created.getBody();
        assertNotNull(body);
        assertEquals("skill-a", body.get("name"));
        assertEquals("personal", body.get("sourceType"));
        assertEquals(12, body.get("tokenEstimate"));
        assertNotNull(body.get("bindingId"));

        List<SkillBinding> rows = skillBindingRepository
                .findBySubjectTypeAndSubjectIdOrderByCreatedAtAsc("agent_principal", principal.getId());
        assertEquals(1, rows.size());
        assertEquals("instance", rows.get(0).getScopeType());
        assertEquals(null, rows.get(0).getScopeId(), "the server writes scope_id=NULL for principal bindings");
        assertTrue(resolvableSkillIds().contains(skillId),
                "the agent-session resolver must already see the new binding");
    }

    @Test
    void listReportsSkillSourceAndSize() {
        fixture();
        UUID skillId = createInstanceSkill("skill-b", 42);
        assertEquals(HttpStatus.CREATED, post("/skills", Map.of("skillId", skillId.toString()))
                .getStatusCode());

        ResponseEntity<Map> listed = get("/skills");

        assertEquals(HttpStatus.OK, listed.getStatusCode(), String.valueOf(listed.getBody()));
        List<Map<String, Object>> items = (List<Map<String, Object>>) listed.getBody().get("items");
        assertEquals(1, items.size());
        assertEquals(skillId.toString(), items.get(0).get("skillId"));
        assertEquals("skill-b", items.get(0).get("name"));
        assertEquals(42, items.get(0).get("tokenEstimate"));
    }

    @Test
    void duplicateBindAndUnknownIdsAreRefused() {
        fixture();
        UUID skillId = createInstanceSkill("skill-c", 5);
        assertEquals(HttpStatus.CREATED, post("/skills", Map.of("skillId", skillId.toString()))
                .getStatusCode());

        ResponseEntity<Map> duplicate = post("/skills", Map.of("skillId", skillId.toString()));
        assertEquals(HttpStatus.CONFLICT, duplicate.getStatusCode());
        assertEquals("SKILL_BINDING_EXISTS", duplicate.getBody().get("code"));

        ResponseEntity<Map> unknownSkill = post("/skills", Map.of("skillId", UUID.randomUUID().toString()));
        assertEquals(HttpStatus.NOT_FOUND, unknownSkill.getStatusCode());
        assertEquals("SKILL_NOT_FOUND", unknownSkill.getBody().get("code"));

        ResponseEntity<Map> unknownBinding = deleteProblem("/skills/" + UUID.randomUUID());
        assertEquals(HttpStatus.NOT_FOUND, unknownBinding.getStatusCode());
        assertEquals("SKILL_BINDING_NOT_FOUND", unknownBinding.getBody().get("code"));
    }

    @Test
    void deleteRemovesBindingAndResolverEntry() {
        fixture();
        UUID skillId = createInstanceSkill("skill-d", 7);
        ResponseEntity<Map> created = post("/skills", Map.of("skillId", skillId.toString()));
        assertEquals(HttpStatus.CREATED, created.getStatusCode());
        String bindingId = String.valueOf(created.getBody().get("bindingId"));
        assertTrue(resolvableSkillIds().contains(skillId));

        ResponseEntity<String> deleted = delete("/skills/" + bindingId);

        assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode());
        assertEquals(0, skillBindingRepository
                .findBySubjectTypeAndSubjectIdOrderByCreatedAtAsc("agent_principal", principal.getId()).size());
        assertTrue(!resolvableSkillIds().contains(skillId),
                "the resolver no longer returns the removed skill");
    }

    @Test
    void workspacePrivateSkillIsNotBindableThroughTheInstanceSurface() {
        fixture();
        UUID visiblePrivate = createWorkspaceSkill("skill-private-visible", workspace.getId());
        ResponseEntity<Map> visible = post("/skills", Map.of("skillId", visiblePrivate.toString()));
        assertEquals(HttpStatus.BAD_REQUEST, visible.getStatusCode(), String.valueOf(visible.getBody()));
        assertEquals("SKILL_DEFINITION_OUT_OF_SCOPE", visible.getBody().get("code"));

        Workspace invisibleWorkspace = workspaceFixture.createWorkspace("skInvisible" + shortId());
        extraWorkspaceIds.add(invisibleWorkspace.getId());
        UUID invisiblePrivate = createWorkspaceSkill("skill-private-invisible", invisibleWorkspace.getId());
        ResponseEntity<Map> invisible = post("/skills", Map.of("skillId", invisiblePrivate.toString()));
        assertEquals(HttpStatus.NOT_FOUND, invisible.getStatusCode());
        assertEquals("SKILL_NOT_FOUND", invisible.getBody().get("code"),
                "a workspace the caller cannot see is indistinguishable from a missing skill");
    }

    @Test
    void callerWithoutBindingAuthorityIsForbidden() {
        fixture();
        User stranger = userRepository.saveAndFlush(new User(
                "sk-stranger-" + UUID.randomUUID() + "@test.com", "hash", "Stranger"));
        extraUsers.add(stranger.getId());
        String strangerToken = TestDataFactory.createGlobalToken(
                stranger.getId().toString(), stranger.getEmail(), "USER", 0);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(strangerToken);
        ResponseEntity<Map> forbidden = restTemplate.exchange(
                url("/api/v1/agent-principals/" + principal.getId() + "/skills"),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, forbidden.getStatusCode());
        assertEquals("FORBIDDEN", forbidden.getBody().get("code"));
    }

    // ------------------------------------------------------------------ fixtures

    private void fixture() {
        owner = userRepository.saveAndFlush(new User(
                "sk-owner-" + UUID.randomUUID() + "@test.com", "hash", "Skill owner"));
        // B 类根因（BL-326）：`createPrincipal` 会给新 agent 默认 AGENT_USER（read/write/delete/exec/
        // network @ *），GrantabilityGuard 要求调用者自己也持有这些原子 ⇒ 直接用 userRepository 造
        // 账号会让 creator 缺 instance USER 默认集。走生产同一条路径（AuthService/UserAdminService
        // 也是这一句），不手写原子名。
        grantDefaultService.ensureUserDefault(owner);
        ownerToken = TestDataFactory.createGlobalToken(owner.getId().toString(), owner.getEmail(), "USER", 0);
        UUID authorityRole = UUID.randomUUID();
        roleRepository.save(new AccessRole(authorityRole, "TEST_SK_AUTH_" + shortId(),
                "Skill binding authority", "test-only", false));
        permissionRepository.save(new AccessRolePermission(authorityRole, "MANAGE_AGENT_PRINCIPALS", "*"));
        roleBindingRepository.save(new AccessRoleBinding(authorityRole, "user", owner.getId(),
                AccessScope.INSTANCE, null, owner.getId()));
        authorityRoleIds.add(authorityRole);
        materializer.materializeSubject("user", owner.getId(), owner.getId(), null);

        workspace = workspaceFixture.ensureOwnedWorkspace(owner.getId());
        workspaceFixture.bindWorkspaceRole(workspace.getId(), owner.getId(),
                com.cc01cc.p.xihe.cp.entity.WorkspaceRole.OWNER);
        materializer.materializeSubject("user", owner.getId(), owner.getId(),
                workspace.getId().toString());

        var template = agentTemplateService.resolveForCreation(
                owner.getId().toString(), workspace.getId().toString(), null);
        principal = agentPrincipalService.createPrincipal(owner.getId().toString(),
                "skTarget" + shortId(), null, template.snapshot(),
                null, null, null, null, null, null, List.of());
        JsonNode cap = objectMapper.createArrayNode()
                .add(objectMapper.createObjectNode().put("actionClass", "read").put("resource", "*"));
        agentPrincipalService.setWorkspaceCap(owner.getId().toString(), workspace.getId(),
                principal.getId(), cap);
    }

    private UUID createInstanceSkill(String name, int tokens) {
        return createSkill(name, "instance", null, tokens);
    }

    private UUID createWorkspaceSkill(String name, UUID definitionScopeId) {
        return createSkill(name, "workspace", definitionScopeId, 3);
    }

    private UUID createSkill(String name, String definitionScopeType, UUID definitionScopeId, int tokens) {
        Skill skill = new Skill();
        skill.setName(name);
        skill.setDefinitionScopeType(definitionScopeType);
        skill.setDefinitionScopeId(definitionScopeId);
        skill.setDescription(name + " description");
        skill.setBody("body of " + name);
        skill.setBodyTokensEst(tokens);
        skill.setOversize(false);
        skill.setAttachments(objectMapper.createArrayNode());
        skill.setTrusted(false);
        skill.setSourcePath("test/" + name + ".md");
        skill.setContentHash("0123456789abcdef".repeat(4));
        skill.setVersion(1);
        skill.setCreatedByUserId(owner.getId());
        UUID id = skillRepository.saveAndFlush(skill).getId();
        skillIds.add(id);
        return id;
    }

    private List<UUID> resolvableSkillIds() {
        return skillBindingRepository.findResolvable(principal.getId(), owner.getId(), workspace.getId())
                .stream()
                .map(row -> ((Skill) row[1]).getId())
                .toList();
    }

    private String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 10).toUpperCase();
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