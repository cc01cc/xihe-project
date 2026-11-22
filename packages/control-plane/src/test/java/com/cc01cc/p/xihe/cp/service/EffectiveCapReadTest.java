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
import com.cc01cc.p.xihe.cp.policy.OrgUnitGovernancePolicy;
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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
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
    /** task-57: the org-unit fixture's unit and its governance role (cleaned in {@link #cleanFixtures()}). */
    private UUID orgUnitId;
    private UUID orgUnitRoleId;

    @AfterEach
    void cleanFixtures() {
        // task-57 fixture first: org_unit_members / org_unit_preset_bindings hold RESTRICT FKs onto
        // org_units and roles, so the unit tree has to go before the role rows below.
        if (orgUnitId != null) {
            jdbcTemplate.update("DELETE FROM org_unit_members WHERE org_unit_id = ?", orgUnitId);
            jdbcTemplate.update("DELETE FROM org_unit_preset_bindings WHERE org_unit_id = ?", orgUnitId);
            jdbcTemplate.update("DELETE FROM org_units WHERE id = ?", orgUnitId);
        }
        if (orgUnitRoleId != null) {
            jdbcTemplate.update("DELETE FROM grant_preset_atoms WHERE role_id = ?", orgUnitRoleId);
            jdbcTemplate.update("DELETE FROM grant_presets WHERE id = ?", orgUnitRoleId);
        }
        if (workspaceRoleId != null) {
            jdbcTemplate.update("DELETE FROM grant_preset_bindings WHERE role_id = ?", workspaceRoleId);
            jdbcTemplate.update("DELETE FROM grant_presets WHERE id = ?", workspaceRoleId);
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
        assertEquals("action:read", cap.get(0).get("actionClass").asText());
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

    /**
     * task-57（判据包 {@code CRITERIA-A-filter-null.md} V2）：<b>读面 500 的现场</b>。
     *
     * <p>状态：agent principal 没有 {@code workspace_agents} 行（⇒ cap 走 role-binding 支），但它是某个
     * 组织单元的成员，该单元上挂着一个治理角色。展开出来的授权是<b>内存行</b>
     * （{@code OrgUnitGrantExpander.toGrant} 故意把 id 留 null），一旦那个 null 进了
     * {@code provenance.*GrantIds}，{@code WorkspaceAgentController.toEffectiveCapView} 的
     * {@code UUID::toString} 就抛 NPE ⇒ 500 而不是 cap。</p>
     *
     * <p><b>为什么用真行而不是 {@code @Primary} stub</b>：本类继承
     * {@code AbstractReusableIntegrationTest}，该桶禁止 {@code @TestConfiguration}
     * （context-reuse guard R1），而生产用的 {@code JdbcOrgUnitGrantSource} 正是当初产生 500 的那条链路。</p>
     *
     * <p><b>三条防假绿</b>：①id 列表按<b>值与数量</b>钉成恰好那一条落库 grant，不是「不含 null」；
     * ②binding 侧同样只能出现落库行（两侧由同一批行列表派生），org-unit 合成的行在任何一侧都不出现
     * —— 多个 null 被 {@code distinct()} 折成一个也骗不过 ① ②；
     * ③{@code effectiveCap} 必须仍等于内部单点求值且带着治理原子 —— 否则「列表干净」可能只是「整个丢权」。</p>
     */
    @Test
    void roleBindingWithOrgUnitGrants_answersProvenanceWithoutSyntheticIds() throws Exception {
        fixture();
        bindWorkspaceScopedRoleToPrincipal();
        bindOrgUnitGovernanceRole();
        List<AuthorizationGrant> persistedRows = grantRepository
                .findBySubjectTypeAndSubjectId("agent_principal", principalId);
        assertEquals(1, persistedRows.size(),
                "fixture invariant: exactly one persisted grant row, so the id lists below are pinned "
                        + "by value AND count");
        String persistedId = persistedRows.get(0).getId().toString();

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<?, ?> body = response.getBody();
        assertNotNull(body);
        assertEquals("role-binding", ((Map<?, ?>) body.get("capSource")).get("binding"),
                "no workspace_agents row ⇒ the cap comes from the role binding");
        assertEquals(Boolean.FALSE, body.get("bound"));

        Map<?, ?> provenance = (Map<?, ?>) body.get("provenance");
        assertEquals(List.of(persistedId), provenance.get("principalGrantIds"),
                "the id list must be exactly the persisted grant row — value AND count, because "
                        + "'contains no null' also passes when several nulls were folded into one");
        assertEquals(List.of(persistedId), provenance.get("bindingGrantIds"),
                "both sides derive from the same row lists, so the binding side carries the same "
                        + "persisted row and no synthetic one");

        assertEquals(objectMapper.valueToTree(agentPrincipalService.resolveCapFor(principalId, workspaceId)),
                objectMapper.valueToTree(body.get("effectiveCap")),
                "task-57 touched provenance only: the wire cap still equals the single internal evaluation");
        assertTrue(body.get("effectiveCap").toString()
                        .contains(OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS),
                "the org-unit governance atom must still reach the cap: " + body.get("effectiveCap"));
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

    /**
     * task-104（task-87 测试轮，判据 3）：wire 上 {@code provenance.grantSources} 恒在、是对象、
     * 键集恰好等于两条 id 数组的并集，且每个键的标签就是该 grant 行的 {@code source}（夹具里那条
     * {@code addPrincipalGrant} 写的是 TEMPLATE —— 断言取值而不是「存在吗」，错值才活不下来）。
     */
    @Test
    void provenanceGrantSourcesLabelsExactlyTheReturnedIds() throws Exception {
        fixture();
        bindSnapshot("[{\"actionClass\":\"read\"}]");

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<?, ?> body = response.getBody();
        assertNotNull(body);
        Map<?, ?> provenance = (Map<?, ?>) body.get("provenance");
        assertTrue(provenance.containsKey("grantSources"),
                "契约：grantSources 恒发 —— 缺键会被读成「本读面无标签面」，与「暂无标签」是两回事");
        Object raw = provenance.get("grantSources");
        assertInstanceOf(Map.class, raw, "grantSources 必须是对象（additionalProperties: string）");
        Map<?, ?> labels = (Map<?, ?>) raw;

        List<?> principalIds = (List<?>) provenance.get("principalGrantIds");
        List<?> bindingIds = (List<?>) provenance.get("bindingGrantIds");
        assertFalse(principalIds.isEmpty(), "夹具 invariant：主体持有至少一条落库 grant");
        assertTrue(bindingIds.isEmpty(), "binding-snapshot 支没有 binding grant 行");

        Set<String> expected = new LinkedHashSet<>();
        principalIds.forEach(id -> expected.add(String.valueOf(id)));
        bindingIds.forEach(id -> expected.add(String.valueOf(id)));
        assertEquals(expected, labels.keySet(),
                "键集必须恰好是两数组的并集（缺键=漏标、多键=drift）");
        assertEquals(GrantSources.TEMPLATE, labels.get(String.valueOf(principalIds.get(0))),
                "夹具 grant 的 source 是 TEMPLATE ⇒ 标签必须逐字是 template，不是 unknown/role 兜底");
    }

    /**
     * task-104（判据 2/3 的 role-binding 支）：没有 {@code workspace_agents} 行时两条数组都由
     * role 行派生，键集仍必须等于并集 —— 这一支才是「两边都有真实行」的形态，单看 binding 支会漏。
     */
    @Test
    void provenanceGrantSourcesCoversBothArraysOnRoleBindingPath() throws Exception {
        fixture();
        bindWorkspaceScopedRoleToPrincipal();

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<?, ?> provenance = (Map<?, ?>) response.getBody().get("provenance");
        assertInstanceOf(Map.class, provenance.get("grantSources"));
        Map<?, ?> labels = (Map<?, ?>) provenance.get("grantSources");
        List<?> principalIds = (List<?>) provenance.get("principalGrantIds");
        List<?> bindingIds = (List<?>) provenance.get("bindingGrantIds");

        Set<String> expected = new LinkedHashSet<>();
        principalIds.forEach(id -> expected.add(String.valueOf(id)));
        bindingIds.forEach(id -> expected.add(String.valueOf(id)));
        assertFalse(expected.isEmpty(), "role-binding 支应当有派生出行（否则并集为空、断言退化）");
        assertEquals(expected, labels.keySet());
        for (Object label : labels.values()) {
            assertTrue(GrantSources.PROVENANCE_SOURCES.contains(label) || GrantSources.UNKNOWN.equals(label),
                    () -> "标签越出词表: " + label);
        }
    }

    /**
     * task-104（判据 3 的空态）：两条 id 数组都空时，{@code grantSources} 必须是**空对象**，
     * 不是缺键、也不是 null —— 「空集」是契约里的一个取值，null 会让调用方必须做空判断。
     *
     * <p>造法：绑定行给空快照（cap 为空但 bound=true ⇒ 仍 200）+ 删掉夹具那条主体 grant ⇒
     * 两数组皆空。删行是安全动作（{@code cleanFixtures()} 本来就会按主体删 grant）。</p>
     */
    @Test
    void emptyProvenanceIsAnEmptyObjectNotNull() throws Exception {
        fixture();
        bindSnapshot("[]");
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<?, ?> provenance = (Map<?, ?>) response.getBody().get("provenance");
        assertTrue(((List<?>) provenance.get("principalGrantIds")).isEmpty());
        assertTrue(((List<?>) provenance.get("bindingGrantIds")).isEmpty());
        assertTrue(provenance.containsKey("grantSources"), "空态也必须是「有键、值为 {}」");
        assertInstanceOf(Map.class, provenance.get("grantSources"));
        assertTrue(((Map<?, ?>) provenance.get("grantSources")).isEmpty(),
                "空态是 empty object，不是 null、不是缺键");
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
        jdbcTemplate.update("INSERT INTO grant_presets (id, name, display_name, description, is_system)"
                        + " VALUES (?, ?, ?, ?, FALSE)",
                workspaceRoleId, "TEST_ECR_" + workspaceRoleId.toString().substring(0, 8).toUpperCase(),
                "Test workspace role", "test-only role for effective-cap role-binding source");
        jdbcTemplate.update("INSERT INTO grant_preset_bindings (id, role_id, subject_type, subject_id, scope_type,"
                        + " scope_id, granted_at) VALUES (gen_random_uuid(), ?, 'agent_principal', ?,"
                        + " 'workspace', ?, NOW())",
                workspaceRoleId, principalId, workspaceId);
    }

    /**
     * task-57: one real org-unit governance chain — unit + membership + role carrying the governance
     * atom + {@code org_unit_preset_bindings} — so the production {@code JdbcOrgUnitGrantSource} feeds
     * the expander (which is the path that produced the 500).
     */
    private void bindOrgUnitGovernanceRole() {
        orgUnitId = UUID.randomUUID();
        jdbcTemplate.update("INSERT INTO org_units (id, parent_id, name, path, depth)"
                        + " VALUES (?, NULL, ?, ?::ltree, 0)",
                orgUnitId, "task57-unit-" + orgUnitId.toString().substring(0, 8),
                orgUnitId.toString().replace("-", ""));
        jdbcTemplate.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'agent_principal', ?)", orgUnitId, principalId);
        orgUnitRoleId = UUID.randomUUID();
        jdbcTemplate.update("INSERT INTO grant_presets (id, name, display_name, description, is_system)"
                        + " VALUES (?, ?, ?, ?, FALSE)",
                orgUnitRoleId, "TEST_T57_" + orgUnitRoleId.toString().substring(0, 8).toUpperCase(),
                "Org-unit governance role", "task-57 fixture");
        jdbcTemplate.update("INSERT INTO grant_preset_atoms (role_id, action_class, resource_pattern)"
                + " VALUES (?, ?, '*')", orgUnitRoleId, OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS);
        jdbcTemplate.update("INSERT INTO org_unit_preset_bindings (id, org_unit_id, role_id, granted_at)"
                + " VALUES (gen_random_uuid(), ?, ?, NOW())", orgUnitId, orgUnitRoleId);
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
