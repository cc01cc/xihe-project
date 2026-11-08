package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
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
 * <p>PLAN-0680 makes the surface dual-axis. The tests pin the two properties the plan cares
 * about:</p>
 * <ul>
 *   <li>the server, not the caller, decides the scope: a workspace authorization context writes
 *       {@code scope_type='workspace'} / {@code scope_id=thatWorkspace}, its absence writes
 *       {@code instance}/{@code null}; the request body still carries only {@code skillId};</li>
 *   <li>the agent-session resolution query ({@link SkillBindingRepository#findResolvable}) sees the
 *       new binding immediately — that is the "agent's skill catalog contains the skill" requirement,
 *       asserted at the same layer the session actually reads.</li>
 * </ul>
 */
class AgentPrincipalSkillBindingContractTest extends AbstractReusableIntegrationTest {

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
            jdbcTemplate.update("DELETE FROM grants WHERE subject_type = 'user'"
                    + " AND subject_id = ?::uuid", id.toString());
            jdbcTemplate.update("DELETE FROM role_bindings WHERE subject_type = 'user'"
                    + " AND subject_id = ?::uuid", id.toString());
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

        ResponseEntity<Map> smuggled = post("/skills",
                Map.of("skillId", skillId.toString(), "scopeType", "workspace"));
        assertEquals(HttpStatus.BAD_REQUEST, smuggled.getStatusCode(), String.valueOf(smuggled.getBody()));
        assertEquals("INVALID_REQUEST", smuggled.getBody().get("code"),
                "the body never accepts a client-chosen scope");

        ResponseEntity<Map> created = post("/skills", Map.of("skillId", skillId.toString()));

        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        Map<String, Object> body = created.getBody();
        assertNotNull(body);
        assertEquals("skill-a", body.get("name"));
        assertEquals("personal", body.get("sourceType"));
        assertEquals("instance", body.get("scopeType"));
        assertEquals(null, body.get("scopeId"));
        assertEquals(null, body.get("scopeName"));
        assertEquals(12, body.get("tokenEstimate"));
        assertNotNull(body.get("bindingId"));

        List<SkillBinding> rows = skillBindingRepository
                .findBySubjectTypeAndSubjectIdOrderByCreatedAtAsc("agent_principal", principal.getId());
        assertEquals(1, rows.size());
        assertEquals("instance", rows.get(0).getScopeType());
        assertEquals(null, rows.get(0).getScopeId(), "the server writes scope_id=NULL for principal bindings");
        assertTrue(resolvableSkillIds().contains(skillId),
                "the agent-session resolver must already see the new binding");
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_skill_bind'"
                        + " AND details LIKE '%\"scopeType\":\"instance\"%'"
                        + " AND details LIKE '%\"scopeId\":null%'"
                        + " AND details LIKE '%" + body.get("bindingId") + "%'", Integer.class),
                "bind audit detail must carry the derived row scope");
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
        assertEquals("instance", items.get(0).get("scopeType"));
        assertEquals(null, items.get(0).get("scopeId"));
        assertEquals(null, items.get(0).get("scopeName"));
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
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_skill_unbind'"
                        + " AND details LIKE '%\"scopeType\":\"instance\"%'"
                        + " AND details LIKE '%\"result\":\"unbound\"%'"
                        + " AND details LIKE '%" + bindingId + "%'", Integer.class),
                "unbind audit detail must carry the deleted row scope");
    }

    @Test
    void workspacePrivateSkillIsInvisibleWithoutAWorkspaceContext() {
        fixture();
        UUID visiblePrivate = createWorkspaceSkill("skill-private-visible", workspace.getId());
        ResponseEntity<Map> visible = post("/skills", Map.of("skillId", visiblePrivate.toString()));
        assertEquals(HttpStatus.NOT_FOUND, visible.getStatusCode(), String.valueOf(visible.getBody()));
        assertEquals("SKILL_NOT_FOUND", visible.getBody().get("code"),
                "without a workspace context a private definition is indistinguishable from missing");

        Workspace invisibleWorkspace = workspaceFixture.createWorkspace("skInvisible" + shortId());
        extraWorkspaceIds.add(invisibleWorkspace.getId());
        UUID invisiblePrivate = createWorkspaceSkill("skill-private-invisible", invisibleWorkspace.getId());
        ResponseEntity<Map> invisible = post("/skills", Map.of("skillId", invisiblePrivate.toString()));
        assertEquals(HttpStatus.NOT_FOUND, invisible.getStatusCode());
        assertEquals("SKILL_NOT_FOUND", invisible.getBody().get("code"),
                "a workspace the caller cannot see is indistinguishable from a missing skill");
    }

    @Test
    void workspaceContextBindsPrivateSkillOnWorkspaceAxis() {
        fixture();
        UUID skillId = createWorkspaceSkill("skill-ws", workspace.getId());

        ResponseEntity<Map> created = post("/skills", Map.of("skillId", skillId.toString()),
                workspace.getId());

        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        assertEquals("workspace", created.getBody().get("sourceType"));
        assertEquals("workspace", created.getBody().get("scopeType"));
        assertEquals(workspace.getId().toString(), created.getBody().get("scopeId"));
        assertEquals(workspace.getName(), created.getBody().get("scopeName"));
        List<SkillBinding> rows = bindingsOfPrincipal();
        assertEquals(1, rows.size());
        assertEquals("workspace", rows.get(0).getScopeType());
        assertEquals(workspace.getId(), rows.get(0).getScopeId());
        assertTrue(resolvableSkillIds().contains(skillId),
                "the agent-session resolver must see the workspace-axis binding immediately");
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_skill_bind'"
                        + " AND details LIKE '%\"scopeType\":\"workspace\"%'"
                        + " AND details LIKE '%" + workspace.getId() + "%'"
                        + " AND details LIKE '%" + created.getBody().get("bindingId") + "%'", Integer.class),
                "bind audit detail must carry the workspace scope id");

        ResponseEntity<Map> duplicate = post("/skills", Map.of("skillId", skillId.toString()),
                workspace.getId());
        assertEquals(HttpStatus.CONFLICT, duplicate.getStatusCode(), String.valueOf(duplicate.getBody()));
        assertEquals("SKILL_BINDING_EXISTS", duplicate.getBody().get("code"));

        ResponseEntity<Map> noContext = post("/skills", Map.of("skillId", skillId.toString()));
        assertEquals(HttpStatus.NOT_FOUND, noContext.getStatusCode(), String.valueOf(noContext.getBody()));
        assertEquals("SKILL_NOT_FOUND", noContext.getBody().get("code"));
        assertEquals(1, bindingsOfPrincipal().size(), "a rejected bind must not write a row");

        UUID querySkill = createWorkspaceSkill("skill-ws-query", workspace.getId());
        ResponseEntity<Map> viaQuery = postWithQueryWorkspace("/skills",
                Map.of("skillId", querySkill.toString()), workspace.getId());
        assertEquals(HttpStatus.CREATED, viaQuery.getStatusCode(), String.valueOf(viaQuery.getBody()));
        assertEquals("workspace", viaQuery.getBody().get("scopeType"));
        assertEquals(workspace.getId().toString(), viaQuery.getBody().get("scopeId"));
        assertEquals(HttpStatus.CONFLICT, post("/skills", Map.of("skillId", querySkill.toString()),
                workspace.getId()).getStatusCode(),
                "query and header must derive the same duplicate key");
        assertEquals(2, bindingsOfPrincipal().size());
    }

    @Test
    void instanceLibraryBindsOnBothAxesAndTheRowsCoexist() {
        fixture();
        UUID skillId = createInstanceSkill("skill-both", 9);

        ResponseEntity<Map> workspaceAxis = post("/skills", Map.of("skillId", skillId.toString()),
                workspace.getId());
        assertEquals(HttpStatus.CREATED, workspaceAxis.getStatusCode(),
                String.valueOf(workspaceAxis.getBody()));
        ResponseEntity<Map> instanceAxis = post("/skills", Map.of("skillId", skillId.toString()));
        assertEquals(HttpStatus.CREATED, instanceAxis.getStatusCode(),
                String.valueOf(instanceAxis.getBody()));

        List<SkillBinding> rows = bindingsOfPrincipal();
        assertEquals(2, rows.size(), "an instance row and a workspace row may coexist (B-3)");
        SkillBinding workspaceRow = rows.stream()
                .filter(row -> "workspace".equals(row.getScopeType())).findFirst().orElseThrow();
        SkillBinding instanceRow = rows.stream()
                .filter(row -> "instance".equals(row.getScopeType())).findFirst().orElseThrow();
        assertEquals(workspace.getId(), workspaceRow.getScopeId());
        assertEquals(null, instanceRow.getScopeId());

        ResponseEntity<Map> duplicateInstance = post("/skills", Map.of("skillId", skillId.toString()));
        assertEquals(HttpStatus.CONFLICT, duplicateInstance.getStatusCode());
        assertEquals("SKILL_BINDING_EXISTS", duplicateInstance.getBody().get("code"));
        assertTrue(resolvableSkillIds().contains(skillId));
    }

    @Test
    void otherWorkspacePrivateDefinitionIsNotFoundUnderOwnWorkspaceContext() {
        fixture();
        Workspace other = workspaceFixture.createWorkspace("skOther" + shortId());
        extraWorkspaceIds.add(other.getId());
        UUID foreignPrivate = createWorkspaceSkill("skill-foreign-private", other.getId());

        ResponseEntity<Map> withOwnContext = post("/skills",
                Map.of("skillId", foreignPrivate.toString()), workspace.getId());
        assertEquals(HttpStatus.NOT_FOUND, withOwnContext.getStatusCode(),
                String.valueOf(withOwnContext.getBody()));
        assertEquals("SKILL_NOT_FOUND", withOwnContext.getBody().get("code"),
                "another workspace's private definition must not leak existence");

        assertEquals(0, bindingsOfPrincipal().size());
        assertEquals(List.of(), resolvableSkillIds());
    }

    @Test
    void workspaceTierCannotDeleteInstanceOrForeignWorkspaceRows() {
        fixture();
        UUID instanceSkill = createInstanceSkill("skill-del-instance", 2);
        String instanceBinding = String.valueOf(post("/skills", Map.of("skillId", instanceSkill.toString()))
                .getBody().get("bindingId"));

        User workspaceAdmin = userRepository.saveAndFlush(new User(
                "sk-ws-admin-" + UUID.randomUUID() + "@test.com", "hash", "Workspace admin"));
        extraUsers.add(workspaceAdmin.getId());
        grantDefaultService.ensureUserDefault(workspaceAdmin);
        workspaceFixture.bindWorkspaceRole(workspace.getId(), workspaceAdmin.getId(), WorkspaceRole.OWNER);
        materializer.materializeSubject("user", workspaceAdmin.getId(), workspaceAdmin.getId(),
                workspace.getId().toString());
        String workspaceAdminToken = TestDataFactory.createGlobalToken(workspaceAdmin.getId().toString(),
                workspaceAdmin.getEmail(), "USER", 0);

        UUID workspaceSkill = createWorkspaceSkill("skill-del-ws", workspace.getId());
        String workspaceBinding = String.valueOf(postWithToken("/skills",
                Map.of("skillId", workspaceSkill.toString()), workspaceAdminToken, workspace.getId())
                .getBody().get("bindingId"));

        Workspace other = workspaceFixture.createWorkspace("skDeleteOther" + shortId());
        extraWorkspaceIds.add(other.getId());
        workspaceFixture.bindWorkspaceRole(other.getId(), owner.getId(), WorkspaceRole.OWNER);
        materializer.materializeSubject("user", owner.getId(), owner.getId(), other.getId().toString());
        UUID otherSkill = createInstanceSkill("skill-del-other", 3);
        ResponseEntity<Map> otherCreated = post("/skills",
                Map.of("skillId", otherSkill.toString()), other.getId());
        assertEquals(HttpStatus.CREATED, otherCreated.getStatusCode(),
                String.valueOf(otherCreated.getBody()));
        String otherBinding = String.valueOf(otherCreated.getBody().get("bindingId"));

        ResponseEntity<Map> foreign = deleteProblemWithToken("/skills/" + otherBinding,
                workspaceAdminToken, workspace.getId());
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode(), String.valueOf(foreign.getBody()));
        assertEquals("SKILL_BINDING_NOT_FOUND", foreign.getBody().get("code"));
        assertTrue(skillBindingRepository.findById(UUID.fromString(otherBinding)).isPresent(),
                "a denied delete must keep the row");

        ResponseEntity<Map> instanceRowWithoutInstanceTier = deleteProblemWithToken(
                "/skills/" + instanceBinding, workspaceAdminToken, null);
        assertEquals(HttpStatus.FORBIDDEN, instanceRowWithoutInstanceTier.getStatusCode(),
                String.valueOf(instanceRowWithoutInstanceTier.getBody()));
        assertEquals("FORBIDDEN", instanceRowWithoutInstanceTier.getBody().get("code"));
        assertTrue(skillBindingRepository.findById(UUID.fromString(instanceBinding)).isPresent());

        ResponseEntity<String> own = deleteWithToken("/skills/" + workspaceBinding,
                workspaceAdminToken, workspace.getId());
        assertEquals(HttpStatus.NO_CONTENT, own.getStatusCode(), String.valueOf(own.getBody()));
        assertTrue(skillBindingRepository.findById(UUID.fromString(workspaceBinding)).isEmpty());

        ResponseEntity<String> instanceTierAnyRow = delete("/skills/" + otherBinding);
        assertEquals(HttpStatus.NO_CONTENT, instanceTierAnyRow.getStatusCode(),
                "instance tier may delete a workspace row");
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

        User editor = userRepository.saveAndFlush(new User(
                "sk-editor-" + UUID.randomUUID() + "@test.com", "hash", "Workspace editor"));
        extraUsers.add(editor.getId());
        grantDefaultService.ensureUserDefault(editor);
        workspaceFixture.bindWorkspaceRole(workspace.getId(), editor.getId(), WorkspaceRole.EDITOR);
        materializer.materializeSubject("user", editor.getId(), editor.getId(),
                workspace.getId().toString());
        String editorToken = TestDataFactory.createGlobalToken(editor.getId().toString(),
                editor.getEmail(), "USER", 0);

        ResponseEntity<Map> editorBind = postWithToken("/skills",
                Map.of("skillId", createInstanceSkill("skill-editor-denied", 1).toString()),
                editorToken, workspace.getId());
        assertEquals(HttpStatus.FORBIDDEN, editorBind.getStatusCode(),
                "WS_EDITOR lacks MANAGE_WORKSPACE_AGENTS, so the atom gate refuses before row scope");
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

    private List<SkillBinding> bindingsOfPrincipal() {
        return skillBindingRepository.findBySubjectTypeAndSubjectIdOrderByCreatedAtAsc(
                "agent_principal", principal.getId());
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
        return authHeaders(ownerToken, null);
    }

    private HttpHeaders authHeaders(String token, UUID workspaceId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (workspaceId != null) {
            headers.set("X-Workspace-Id", workspaceId.toString());
        }
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

    private ResponseEntity<Map> post(String suffix, Map<String, Object> body, UUID workspaceId) {
        return postWithToken(suffix, body, ownerToken, workspaceId);
    }

    private ResponseEntity<Map> postWithToken(String suffix, Map<String, Object> body,
                                              String token, UUID workspaceId) {
        return restTemplate.exchange(url(pathFor(suffix)), HttpMethod.POST,
                new HttpEntity<>(body, authHeaders(token, workspaceId)), Map.class);
    }

    private ResponseEntity<Map> postWithQueryWorkspace(String suffix, Map<String, Object> body,
                                                       UUID workspaceId) {
        return restTemplate.exchange(url(pathFor(suffix)) + "?workspaceId=" + workspaceId,
                HttpMethod.POST, new HttpEntity<>(body, authHeaders()), Map.class);
    }

    private ResponseEntity<String> delete(String suffix) {
        return restTemplate.exchange(url(pathFor(suffix)), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders()), String.class);
    }

    private ResponseEntity<Map> deleteProblem(String suffix) {
        return restTemplate.exchange(url(pathFor(suffix)), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders()), Map.class);
    }

    private ResponseEntity<Map> deleteProblemWithToken(String suffix, String token, UUID workspaceId) {
        return restTemplate.exchange(url(pathFor(suffix)), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders(token, workspaceId)), Map.class);
    }

    private ResponseEntity<String> deleteWithToken(String suffix, String token, UUID workspaceId) {
        return restTemplate.exchange(url(pathFor(suffix)), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders(token, workspaceId)), String.class);
    }
}