package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
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

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-448 (D-1286 / ui-2 417 P1-6): the live-cap public read face
 * {@code GET /workspaces/{ws}/agents/{pid}/effective-cap}. Asserts the wire cap is byte-identical to
 * the internal {@code resolveCapFor} (single computation point C1), that it tracks the LIVE
 * evaluation rather than the stored snapshot, the hit source / grant provenance, and the
 * membership gate + disabled/unbound error semantics.
 */
class EffectiveCapReadTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private GrantAuthorizationService grantAuthorizationService;

    private UUID userId;
    private UUID workspaceId;
    private UUID principalId;
    private UUID workspaceRoleId;
    private UUID outsiderId;
    private String token;

    @AfterEach
    void cleanFixtures() {
        if (workspaceRoleId != null) {
            jdbcTemplate.update("DELETE FROM role_bindings WHERE role_id = ?", workspaceRoleId);
            jdbcTemplate.update("DELETE FROM roles WHERE id = ?", workspaceRoleId);
        }
        if (workspaceId != null && principalId != null) {
            // 幂等：task-193 选项 0 的快照用例会主动删掉这条 binding 行（删行正是被测状态）。
            bindingRepository.findById(new WorkspaceAgentId(principalId, workspaceId))
                    .ifPresent(bindingRepository::delete);
        }
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM sessions WHERE workspace_id = ?", workspaceId);
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
            principalRepository.deleteById(principalId);
        }
        if (userId != null) {
            userRepository.deleteById(userId);
        }
        if (outsiderId != null) {
            userRepository.deleteById(outsiderId);
        }
    }

    @Test
    void effectiveCap_matchesResolveCapFor_withBindingSnapshotSourceAndProvenance() throws Exception {
        fixture();
        bindSnapshot("[{\"actionClass\":\"read\"}]");

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<?, ?> body = response.getBody();
        assertNotNull(body);
        // C1: the wire cap is byte-identical to the internal evaluation.
        JsonNode internal = agentPrincipalService.resolveCapFor(principalId, workspaceId);
        assertEquals(objectMapper.valueToTree(internal), objectMapper.valueToTree(body.get("effectiveCap")),
                "effectiveCap must equal resolveCapFor atom-for-atom (single computation point)");
        assertEquals("binding-snapshot", ((Map<?, ?>) body.get("capSource")).get("binding"));
        assertEquals(Boolean.TRUE, body.get("bound"));
        Map<?, ?> provenance = (Map<?, ?>) body.get("provenance");
        assertFalse(((List<?>) provenance.get("principalGrantIds")).isEmpty(),
                "P1-1: the principal grant-row provenance must be non-empty");
        assertTrue(((List<?>) provenance.get("bindingGrantIds")).isEmpty(),
                "a binding-snapshot cap has no binding grant rows");
        // task-481：断言不能只问「存在吗」——错值能活下来正是因为只查存在。
        // 契约（openapi.yaml EffectiveCapView.defaultGrants.readFace）写的是「workspace members
        // (gate is membership at the atom layer, no role special-case)」⇒ 取值是成员标记 token，
        // 不是角色名列表。
        assertEquals(List.of("workspace-member"), ((Map<?, ?>) body.get("defaultGrants")).get("readFace"),
                "task-481: readFace 必须是成员标记 token，不是 [OWNER,EDITOR,VIEWER] 角色名");
    }

    @Test
    void liveCapShrinksWhenPrincipalNarrowed_snapshotStaysStale() throws Exception {
        fixture();
        // Snapshot claims read+write, but the principal only holds read ⇒ live cap = read only.
        bindSnapshot("[{\"actionClass\":\"read\"},{\"actionClass\":\"write\"}]");

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        JsonNode cap = objectMapper.valueToTree(response.getBody().get("effectiveCap"));
        assertEquals(1, cap.size(), "live cap must drop the uncovered write atom");
        assertEquals("read", cap.get(0).get("actionClass").asText());
        // The stored snapshot is untouched — this is exactly why the UI could only annotate it.
        JsonNode snapshot = bindingRepository.findById(new WorkspaceAgentId(principalId, workspaceId))
                .orElseThrow().getPermissionsSnapshot();
        assertEquals(2, snapshot.size(), "the stored snapshot still claims read+write (stale)");
    }

    @Test
    void roleBindingSource_whenNoBindingRow() throws Exception {
        fixture();
        bindWorkspaceScopedRoleToPrincipal();

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<?, ?> body = response.getBody();
        assertEquals("role-binding", ((Map<?, ?>) body.get("capSource")).get("binding"));
        assertEquals(Boolean.FALSE, body.get("bound"), "no cap binding row ⇒ bound=false");
        JsonNode internal = agentPrincipalService.resolveCapFor(principalId, workspaceId);
        assertEquals(objectMapper.valueToTree(internal), objectMapper.valueToTree(body.get("effectiveCap")));
    }

    @Test
    void unboundWorkspace_answers403() throws Exception {
        fixture();
        // No binding row and no role binding ⇒ resolveCapFor scoped refusal.
        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
    }

    @Test
    void disabledPrincipal_answers409() throws Exception {
        fixture();
        bindSnapshot("[{\"actionClass\":\"read\"}]");
        AgentPrincipal principal = principalRepository.findById(principalId).orElseThrow();
        principal.setDisabledAt(Instant.now());
        principalRepository.saveAndFlush(principal);

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode(), String.valueOf(response.getBody()));
    }

    @Test
    void nonMember_answers403() throws Exception {
        fixture();
        bindSnapshot("[{\"actionClass\":\"read\"}]");
        User outsider = userRepository.saveAndFlush(new User("outsider-" + UUID.randomUUID() + "@test.com",
                "hash", "Outsider"));
        outsiderId = outsider.getId();
        String outsiderToken = TestDataFactory.createWorkspaceToken(outsiderId.toString(), outsider.getEmail(),
                "USER", workspaceId.toString(), 0);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(outsiderToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.exchange(url(capPath()), HttpMethod.GET,
                new HttpEntity<>(null, headers), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(),
                "the read face gate is workspace membership, not a role special-case");
    }

    /**
     * task-77 (task-193 选项 0 / Lead m01783)：**读面与工具面在同一状态下读数相反**的快照用例。
     *
     * <p>状态：principal 持有 workspace 作用域 role binding（裸 SQL 造，同 {@link #roleBindingSource_whenNoBindingRow()}）
     * 但**没有** {@code workspace_agents} 行。此时
     * <ul>
     *   <li>读面 {@code GET .../effective-cap} 答 200 且 {@code capSource.binding=role-binding}（role 分支，
     *       {@code AgentPrincipalService.evaluateCap} 的 {@code binding == null} 支）；</li>
     *   <li>工具面 {@code GrantAuthorizationService.allows()} 答 false（该方法在绑定快照之前就
     *       {@code if (binding == null) return false;}）。</li>
     * </ul>
     *
     * <p><b>这不是 bug 的证明，是 bug 的快照。</b>该状态在现行树只能由夹具/裸 SQL 产生，
     * 生产不可达（证据：internal/A03-xihe/evidence/2026-11-21-task193-cap-asymmetry/README.md §10.5）。
     * <b>改任何一侧都必须同时改这条测试</b>：读面若收紧为 403，删掉读面那两条断言；工具面若放宽为
     * 认 role binding，删掉 {@code assertFalse} 那一条并改成 {@code assertTrue}。</p>
     *
     * <p>正控在同一夹具里先跑一次绑定行存在时的 {@code allows()=true}，证明后面的 false 不是
     * path 解析或夹具缺件造成的（否则这条测试会「绿得莫名其妙」）。</p>
     */
    @Test
    void readFaceAnswersButToolFaceDenies_whenRoleBindingWithoutCapRow() throws Exception {
        fixture();
        bindWorkspaceScopedRoleToPrincipal();
        WorkspaceAgent binding = bindSnapshot("[{\"actionClass\":\"read\"},{\"actionClass\":\"write\"}]");
        addPrincipalGrant("write", "*");
        Session session = saveAgentSession("[{\"actionClass\":\"read\"},{\"actionClass\":\"write\"}]");
        PolicyRequest request = request(session, "write", "src/main.java");

        // 正控：有绑定行时同一请求放行 ⇒ 下面的 false 可归因到「删了绑定行」，不是夹具/链路问题。
        assertTrue(grantAuthorizationService.allows(request),
                "control: with the workspace_agents row in place the same request is allowed");

        bindingRepository.delete(binding);
        bindingRepository.flush();

        // 读面：仍然 200，来源标为 role-binding，bound=false —— 与一侧放行同时成立。
        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<?, ?> body = response.getBody();
        assertNotNull(body);
        assertEquals("role-binding", ((Map<?, ?>) body.get("capSource")).get("binding"),
                "read face still resolves the cap from the role binding");
        assertEquals(Boolean.FALSE, body.get("bound"), "no cap binding row ⇒ bound=false");

        // 工具面：同一状态、同一请求，硬拒绝。两条读数必须成对，缺一条这条测试就失去意义。
        assertFalse(grantAuthorizationService.allows(request),
                "tool face fails closed on the missing workspace_agents row (GrantAuthorizationService.java:98-102)");
    }

    private Session saveAgentSession(String permissionsJson) throws Exception {
        Session session = new Session(workspaceId.toString(), userId.toString(), "Effective cap asymmetry");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(objectMapper.readTree(permissionsJson));
        Session saved = sessionRepository.saveAndFlush(session);
        bindPrimaryParticipant(saved.getId().toString(), principalId.toString());
        return saved;
    }

    private PolicyRequest request(Session session, String actionClass, String resource) {
        return new PolicyRequest("write_file", List.of(actionClass), List.of(resource), ToolShape.STRUCTURED,
                userId.toString(), workspaceId.toString(), session.getId().toString());
    }

    private void fixture() throws Exception {
        User user = userRepository.saveAndFlush(new User("effective-cap-" + UUID.randomUUID() + "@test.com",
                "hash", "Effective Cap Test"));
        userId = user.getId();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Effective cap test", userId.toString());
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId.toString(), WorkspaceRole.EDITOR);
        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName("CapAgent");
        principal.setCreatedByUserId(userId.toString());
        principal.setTemplateId("template-1");
        principal.setTemplateSnapshot(objectMapper.readTree(
                "{\"templateId\":\"template-1\",\"templateName\":\"Cap\"}"));
        principal = principalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        addPrincipalGrant("read", "*");
        token = TestDataFactory.createWorkspaceToken(userId.toString(), user.getEmail(), "USER", workspaceId.toString(), 0);
    }

    private WorkspaceAgent bindSnapshot(String permissionsJson) throws Exception {
        return bindingRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId.toString(),
                objectMapper.readTree(permissionsJson)));
    }

    private void bindWorkspaceScopedRoleToPrincipal() {
        workspaceRoleId = UUID.randomUUID();
        jdbcTemplate.update("INSERT INTO roles (id, name, display_name, description, is_system)"
                        + " VALUES (?, ?, ?, ?, FALSE)",
                workspaceRoleId, "TEST_ECR_" + workspaceRoleId.toString().substring(0, 8).toUpperCase(),
                "Test workspace role", "test-only role for effective-cap role-binding source");
        jdbcTemplate.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                        + " scope_id, granted_at) VALUES (gen_random_uuid(), ?, 'agent_principal', ?,"
                        + " 'workspace', ?, NOW())",
                workspaceRoleId, principalId, workspaceId);
    }

    private void addPrincipalGrant(String actionClass, String resource) throws Exception {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(userId);
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principalId);
        grant.setSource(GrantSources.TEMPLATE);
        grant.setReadState("read");
        grant.setPermissions(objectMapper.readTree("[{\"actionClass\":\"" + actionClass
                + "\",\"resource\":\"" + resource + "\"}]"));
        grantRepository.saveAndFlush(grant);
    }

    private String capPath() {
        return "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId + "/effective-cap";
    }

    private ResponseEntity<Map> get() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url(capPath()), HttpMethod.GET, new HttpEntity<>(null, headers), Map.class);
    }
}