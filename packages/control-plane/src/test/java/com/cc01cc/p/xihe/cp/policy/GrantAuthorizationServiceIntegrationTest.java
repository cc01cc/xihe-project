package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.AgentTemplateService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GrantAuthorizationServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private GrantAuthorizationService grantAuthorizationService;

    /** B 类夹具单一来源（BL-326）：生产注册路径就是 ensureUserDefault。 */
    @Autowired
    private GrantDefaultService grantDefaultService;

    @Autowired
    private PolicyEngine policyEngine;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AgentPrincipalService agentPrincipalService;

    @Autowired
    private AgentTemplateService agentTemplateService;

    @Autowired
    private ConfigJpaRepository configJpaRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.AccessRoleRepository accessRoleRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository bindingRepository;

    @Autowired
    private RoleGrantMaterializer materializer;

    @Autowired
    private AuthzContext authzContext;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private UUID workspaceId;
    private UUID unjoinedWorkspaceId;
    private UUID principalId;
    private UUID parentRunId;
    private final List<UUID> sessionIds = new ArrayList<>();
    private final List<UUID> chatRunIds = new ArrayList<>();
    private final List<UUID> grantIds = new ArrayList<>();
    private final List<WorkspaceAgentId> workspaceAgentIds = new ArrayList<>();
    private final List<UUID> configIds = new ArrayList<>();
    /** Seeded config rows this fixture merged into: id -> the document to put back in {@code @AfterEach}. */
    private final java.util.Map<UUID, String> mergedConfigOriginals = new java.util.LinkedHashMap<>();

    @AfterEach
    void cleanFixtures() {
        // PLAN-0625: the instance agent-templates rows are product seeds (V97/V98). The fixture appends
        // to them, so the shared rows are restored byte-identical before the fixture's own rows go.
        mergedConfigOriginals.forEach((id, originalValue) -> configJpaRepository.findById(id).ifPresent(row -> {
            row.setConfigValue(originalValue);
            configJpaRepository.saveAndFlush(row);
        }));
        mergedConfigOriginals.clear();
        configJpaRepository.deleteAllById(configIds);
        grantRepository.deleteAllById(grantIds);
        if (parentRunId != null) {
            chatRunRepository.deleteById(parentRunId);
        }
        chatRunIds.forEach(chatRunRepository::deleteById);
        sessionIds.forEach(sessionRepository::deleteById);
        workspaceAgentRepository.deleteAllById(workspaceAgentIds);
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            agentPrincipalRepository.deleteById(principalId);
        }
        if (unjoinedWorkspaceId != null) {
            workspaceRepository.deleteById(unjoinedWorkspaceId);
        }
        if (workspaceId != null) {
            workspaceFixture.unbindWorkspace(workspaceId);
            workspaceRepository.deleteById(workspaceId);
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
    }

    @Test
    void stablePrincipalCapsAndWorkspaceBindingControlAgentActions() throws Exception {
        User user = userRepository.save(new User("grant-path-" + UUID.randomUUID() + "@test.com",
                "hash", "Grant path test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Grant path test", userId);
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.OWNER);

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Grant path test agent");
        principal.setCreatedByUserId(userId);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();
        bindPrincipal(workspaceId, atoms("read"));

        Session rootSession = saveAgentSession(workspaceId, userId, "Root agent", atoms("read", "write"));
        Session unboundSession = new Session(workspaceId.toString(), userId, "Unbound agent session");
        unboundSession.setId(UUID.randomUUID());
        unboundSession.setAgentPermissionsSnapshot(atoms("read", "write"));
        sessionRepository.saveAndFlush(unboundSession);
        sessionIds.add(unboundSession.getId());
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId,
                        unboundSession, "read", "src/main.java")),
                "principal-null Sessions cannot enter the Agent authorization path");

        String writeBody = "{\"params\":{\"arguments\":{\"path\":\"src/main.java\"}}}";
        parentRunId = UUID.randomUUID();
        ChatRun parentRun = chatRunRepository.saveAndFlush(new ChatRun(
                parentRunId.toString(), rootSession.getId().toString(), userId, workspaceId.toString(),
                "root-run", "root-hash", "provider", "model", "workspace", "running"));

        addGrant("user", UUID.fromString(userId), "role", null, null, atoms("read", "write"));
        UUID agentDefaultGrantId = addGrant(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                principalId, "role", null, null, atoms("read", "write"));
        assertTrue(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", writeBody,
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "a member's own user grant permits a user-direct mutation");
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "the Workspace binding cap constrains the stable principal grant set");
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", writeBody,
                rootSession.getId().toString(), userId, workspaceId.toString(), false),
                "Agent actions use the stable principal and per-Session cap");
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file",
                "{\"params\":{\"arguments\":{\"path\":\"C:\\\\outside\\\\secret\"}}}",
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "a wildcard grant cannot authorize an absolute host path");
        assertTrue(policyEngine.allowsByGrant(PolicyContext.EMPTY, "apply_patch",
                "{\"params\":{\"arguments\":{\"patches\":[{\"path\":\"src/main.java\"}]}}}",
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "structured patch paths are extracted and scoped to the workspace");
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "apply_patch",
                "{\"params\":{\"arguments\":{\"patches\":[{\"path\":\"../outside.java\"}]}}}",
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "structured patch paths cannot escape the workspace");

        setBindingCap(workspaceId, atoms("read", "write"));
        assertTrue(grantAuthorizationService.allows(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "principal grant, Workspace binding cap, and Session cap jointly permit the action");
        rootSession.setAgentPermissionsSnapshot(atoms("read"));
        sessionRepository.saveAndFlush(rootSession);
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "the Session instance cap further narrows the Workspace binding cap");
        rootSession.setAgentPermissionsSnapshot(atoms("read", "write"));
        sessionRepository.saveAndFlush(rootSession);
        AgentPrincipal activePrincipal = agentPrincipalRepository.findById(principalId).orElseThrow();
        activePrincipal.setDisabledAt(Instant.now());
        agentPrincipalRepository.saveAndFlush(activePrincipal);
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "disabled principals cannot authorize new actions");
        activePrincipal.setDisabledAt(null);
        agentPrincipalRepository.saveAndFlush(activePrincipal);
        grantRepository.deleteById(agentDefaultGrantId);
        grantIds.remove(agentDefaultGrantId);
        assertTrue(grantAuthorizationService.allowsUserOnly(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "User grants remain available to user-only operations");
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId, rootSession,
                        "write", "src/main.java")),
                "User grants cannot authorize an Agent when its stable principal has no grant");
        addGrant(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                principalId, "role", null, null, atoms("read", "write"));
        setBindingCap(workspaceId, atomWithResource("write", "src/*"));
        assertTrue(grantAuthorizationService.allows(request(workspaceId, userId,
                        rootSession, "write", "src/main.java")));
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId,
                        rootSession, "write", "docs/private.txt")),
                "Workspace cap resource patterns constrain concrete tool targets");
        setBindingCap(workspaceId, atoms("read", "write"));

        Workspace unjoinedWorkspace = workspaceRepository.save(
                TestDataFactory.directAttachWorkspace("Unjoined grant path test"));
        unjoinedWorkspaceId = unjoinedWorkspace.getId();
        Session unboundWorkspaceSession = saveAgentSession(unjoinedWorkspaceId, userId,
                "Unbound workspace agent", atoms("read", "write"));
        assertFalse(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "write", "src/main.java")),
                "a stable principal without a Workspace binding cannot act there");
        bindPrincipal(unjoinedWorkspaceId, atoms("read"));
        assertFalse(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "write", "src/main.java")),
                "the binding cap independently narrows principal-wide grants");
        assertTrue(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "read", "src/main.java")));
        setBindingCap(unjoinedWorkspaceId, atoms("read", "write"));
        assertTrue(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "write", "src/main.java")),
                "Agent Workspace binding is authoritative independently of human workspace membership");
        setBindingCap(workspaceId, atoms("read"));
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId,
                        rootSession, "write", "src/main.java")),
                "updating Workspace B cannot broaden Workspace A's binding cap");
        assertTrue(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "write", "src/main.java")),
                "narrowing Workspace A's cap must not narrow Workspace B's independent cap");
        assertFalse(grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                "write_file", List.of("write"), List.of("src/main.java"), ToolShape.STRUCTURED,
                userId, unjoinedWorkspaceId.toString(), null)),
                "wildcard grants cannot cross into a workspace where the user has no membership");
        workspaceAgentRepository.deleteById(new WorkspaceAgentId(principalId, unjoinedWorkspaceId));
        workspaceAgentIds.remove(new WorkspaceAgentId(principalId, unjoinedWorkspaceId));
        assertFalse(grantAuthorizationService.allows(request(unjoinedWorkspaceId, userId,
                        unboundWorkspaceSession, "write", "src/main.java")),
                "removing Workspace binding denies the next Agent action");

        UUID malformedGrantId = addGrant("user", UUID.fromString(userId), "role",
                "admin", UUID.randomUUID(), atoms("unknown-action"));
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", writeBody,
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "a malformed or out-of-vocabulary grant fails closed");
        grantRepository.deleteById(malformedGrantId);

        setBindingCap(workspaceId, atoms("read", "write"));
        rootSession.setAgentPermissionsSnapshot(atoms("read"));
        sessionRepository.saveAndFlush(rootSession);
        Session spawnSession = saveDerivedSession(workspaceId, userId, rootSession, parentRun,
                Session.KIND_SPAWN, atoms("write"));
        PolicyRequest spawnWrite = request(workspaceId, userId, spawnSession, "write", "src/main.java");

        boolean inFlightDecision = grantAuthorizationService.allows(spawnWrite);
        assertFalse(inFlightDecision, "the parent agent's narrower set constrains its spawned child");

        Session forkSession = saveDerivedSession(workspaceId, userId, rootSession, parentRun,
                Session.KIND_FORK, atoms("write"));
        assertTrue(grantAuthorizationService.allows(
                request(workspaceId, userId, forkSession, "write", "src/main.java")),
                "a fork points to its source but does not inherit the source agent grant path");

        rootSession.setAgentPermissionsSnapshot(atoms("read", "write"));
        sessionRepository.saveAndFlush(rootSession);
        assertFalse(inFlightDecision, "a committed capability change does not revise an already returned decision");
        assertTrue(grantAuthorizationService.allows(spawnWrite),
                "the next tool-boundary evaluation must re-read the spawn ancestor Session cap");

        rootSession.setKind(Session.KIND_SPAWN);
        rootSession.setSpawnedFromSessionId(rootSession.getId());
        rootSession.setSpawnedFromRunId(parentRun.getId());
        rootSession.setSpawnedAt(Instant.now());
        sessionRepository.saveAndFlush(rootSession);
        assertFalse(grantAuthorizationService.allows(
                request(workspaceId, userId, rootSession, "write", "src/main.java")),
                "cyclic or inconsistent principal paths fail closed");
    }

    @Test
    void spawnAncestorChainsAndWorkspaceMembershipStayIndependentPerSubject() {
        User user = userRepository.save(new User("grant-chain-" + UUID.randomUUID() + "@test.com",
                "hash", "Grant chain test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Grant chain test", userId);
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.OWNER);

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Grant chain agent");
        principal.setCreatedByUserId(userId);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();
        addGrant(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, "role", null, null,
                atoms("read", "write"));
        addGrant("user", UUID.fromString(userId), "role", null, null, atoms("read", "write"));
        bindPrincipal(workspaceId, atoms("read", "write"));

        Session memberSession = saveAgentSession(workspaceId, userId, "Member agent", atoms("read", "write"));
        PolicyRequest agentWrite = request(workspaceId, userId, memberSession, "write", "src/main.java");
        assertTrue(grantAuthorizationService.allows(agentWrite));

        workspaceFixture.unbindWorkspaceRole(workspaceId, UUID.fromString(userId));
        assertTrue(grantAuthorizationService.allows(agentWrite),
                "Agent actions follow the WorkspaceAgent binding, not human WorkspaceUser membership");
        assertFalse(grantAuthorizationService.allowsUserOnly(agentWrite),
                "revoking human membership denies the user-only path immediately");
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.OWNER);

        WorkspaceAgentId bindingId = new WorkspaceAgentId(principalId, workspaceId);
        workspaceAgentRepository.deleteById(bindingId);
        workspaceAgentIds.remove(bindingId);
        assertFalse(grantAuthorizationService.allows(agentWrite),
                "a Workspace member without a WorkspaceAgent binding cannot act as the Agent");
        assertTrue(grantAuthorizationService.allowsUserOnly(agentWrite),
                "human membership keeps the user-only path independent of the Agent binding");
        bindPrincipal(workspaceId, atoms("read", "write"));

        parentRunId = UUID.randomUUID();
        ChatRun parentRun = chatRunRepository.saveAndFlush(new ChatRun(
                parentRunId.toString(), memberSession.getId().toString(), userId, workspaceId.toString(),
                "chain-run", "chain-hash", "provider", "model", "workspace", "running"));
        Session spawnChild = saveDerivedSession(workspaceId, userId, memberSession, parentRun,
                Session.KIND_SPAWN, atoms("write"));
        UUID spawnRunId = UUID.randomUUID();
        ChatRun spawnRun = chatRunRepository.saveAndFlush(new ChatRun(
                spawnRunId.toString(), spawnChild.getId().toString(), userId, workspaceId.toString(),
                "spawn-run", "spawn-hash", "provider", "model", "workspace", "running"));
        chatRunIds.add(spawnRunId);
        Session grandChild = saveDerivedSession(workspaceId, userId, spawnChild, spawnRun,
                Session.KIND_SPAWN, atoms("read", "write"));

        assertTrue(grantAuthorizationService.allows(
                        request(workspaceId, userId, grandChild, "write", "src/main.java")),
                "every ancestor Session cap permits the action through the full spawn chain");
        assertFalse(grantAuthorizationService.allows(
                        request(workspaceId, userId, grandChild, "read", "src/main.java")),
                "an intermediate spawn cap denies an action the root Session would allow");

        memberSession.setAgentPermissionsSnapshot(atoms("read"));
        sessionRepository.saveAndFlush(memberSession);
        assertFalse(grantAuthorizationService.allows(
                        request(workspaceId, userId, grandChild, "write", "src/main.java")),
                "narrowing the root Session cap re-denies the next tool-boundary evaluation");
    }

    @Test
    void principalLifecycleAndWorkspaceCapsAreAuditedWithoutChangingGlobalGrants() {
        User user = userRepository.saveAndFlush(new User("principal-lifecycle-" + UUID.randomUUID() + "@test.com",
                "hash", "Principal lifecycle test"));
        userId = user.getId().toString();
        // B 类根因（BL-326）：该账号随后 createPrincipal，默认 AGENT_USER 原子必须由调用者自身持有；
        // 走生产同一路径 ensureUserDefault，不手写原子名。
        grantDefaultService.ensureUserDefault(user);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Principal lifecycle", userId);
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.OWNER);
        // read@*/write@* 已由 ensureUserDefault 的 USER 角色物化（uq_grants_role_atom 唯一约束），无需再手插。
        addGrant("user", UUID.fromString(userId), "role", null, null,
                atoms("MANAGE_WORKSPACE_AGENTS"));
        // BL-326/D22：`requireDisableAuthority` 只认 owner 或 MANAGE_AGENT_PRINCIPALS；0651 tier 移除后
        // workspace 作用域 principal 的 ownerUserId 为 null，所以"授权路径可用"必须由这个原子证明。
        addGrant("user", UUID.fromString(userId), "role", null, null,
                atoms("MANAGE_AGENT_PRINCIPALS"));

        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.put("templateId", "template-code");
        snapshot.put("templateName", "Code");
        snapshot.put("roleName", "USER");
        snapshot.put("systemPrompt", "internal template prompt");
        snapshot.set("permissions", atoms("read", "write", "network"));
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                userId, "ScopedAgent", "template-code", snapshot);
        principalId = principal.getId();

        // 2026-11-04 裁定（PLAN-0629「role 行是唯一权威源」）：creation 不再写 template 快照行
        // （createAgentPrincipalGrant 已删除），权限只来自绑定角色 —— 原断言"creation intersects
        // template capabilities with creator grants"已过时。新规则：每个原子一行，集合 = 绑定角色原子集。
        // B 类（BL-326，2026-11-05）：V127/D-174 之后 agent principal 的默认 instance 角色是
        // **AGENT_USER**（human USER 去掉 agent 禁用的 CREATE_OWN_AGENT），不再是 USER。
        // 期望集合从角色目录单一来源派生，不写字面量。
        java.util.Set<String> expectedRoleAtoms =
                RoleAtomExpectations.declaredAtoms(SystemAccessRoleCatalog.AGENT_USER);
        java.util.Set<String> grantedAtoms = new java.util.LinkedHashSet<>();
        grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId).stream()
                .filter(grant -> GrantSources.ROLE.equals(grant.getSource()))
                .forEach(grant -> grant.getPermissions()
                        .forEach(atom -> grantedAtoms.add(atom.path("actionClass").asText())));
        assertEquals(expectedRoleAtoms, grantedAtoms,
                "authority comes from the bound default role (one atom per row); the template "
                        + "snapshot write is gone");
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'agent_principal_created' AND user_id = ? AND resource_id = ?",
                Integer.class, UUID.fromString(userId), principalId.toString()));
        String createAuditDetail = jdbcTemplate.queryForObject("SELECT details FROM audit_logs "
                + "WHERE action = 'agent_principal_created' AND user_id = ? AND resource_id = ?",
                String.class, UUID.fromString(userId), principalId.toString());
        assertFalse(createAuditDetail.contains("internal template prompt"),
                "principal audit records permission facts, not template prompt contents");
        assertFalse(workspaceAgentRepository.existsById(new WorkspaceAgentId(principalId, workspaceId)),
                "creating a principal must not implicitly bind it to a Workspace");

        WorkspaceAgent binding = agentPrincipalService.setWorkspaceCap(
                userId, workspaceId, principalId, atoms("read"));
        workspaceAgentIds.add(binding.getId());
        Session session = saveAgentSession(workspaceId, userId, "Bound agent", atoms("read", "write"));
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId,
                        session, "write", "src/main.java")),
                "the Workspace binding cap narrows the principal's global grants");
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'workspace_agent_bound' AND workspace_id = ? AND resource_id = ?",
                Integer.class, workspaceId, principalId.toString()));

        agentPrincipalService.setWorkspaceCap(userId, workspaceId, principalId, atoms("read"));
        assertEquals(0, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'workspace_agent_cap_updated' AND workspace_id = ? AND resource_id = ?",
                Integer.class, workspaceId, principalId.toString()),
                "repeating the same cap is idempotent and does not duplicate audit");
        agentPrincipalService.setWorkspaceCap(userId, workspaceId, principalId, atoms("read", "write"));
        assertTrue(grantAuthorizationService.allows(request(workspaceId, userId,
                        session, "write", "src/main.java")));
        // 旧断言读 `.getFirst()` 的 template 行；快照写删除后，这里改为"role 行集合不变"的规则断言。
        // 注意：setWorkspaceCap 会经 ensureWorkspaceRoleBinding 物化 **workspace-scope** 角色行
        // （WS_EDITOR 的 atom 子集），所以"global principal grants"必须只比 instance-scope 行；
        // 把 workspace 行算进来会把"cap 变更顺带物化 workspace 角色"误判为"改了全局授权"。
        java.util.Set<String> roleAtomsAfterCap = new java.util.LinkedHashSet<>();
        grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId).stream()
                .filter(grant -> GrantSources.ROLE.equals(grant.getSource()))
                .filter(grant -> !AccessScope.WORKSPACE.equals(grant.getScopeType()))
                .forEach(grant -> grant.getPermissions()
                        .forEach(atom -> roleAtomsAfterCap.add(atom.path("actionClass").asText())));
        assertEquals(expectedRoleAtoms, roleAtomsAfterCap,
                "changing a Workspace cap must not mutate global (instance-scope) principal grants");
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'workspace_agent_cap_updated' AND workspace_id = ? AND resource_id = ?",
                Integer.class, workspaceId, principalId.toString()));

        // B 类（BL-326，2026-11-05）：夹具改走 ensureUserDefault 后，调用者已持有完整 instance USER
        // 默认集（含 network@*），旧用例用 "network" 已不再"超出调用者持有"。改用 CREATE_OWN_AGENT：
        // 调用者作为 human USER 持有它，而 agent principal（AGENT_USER）按 V127/D-174 明确**不**持有
        // —— 这正是"cap 不得超出被绑定 principal 的授权"的原意。
        assertThrows(CpApiException.class, () -> agentPrincipalService.setWorkspaceCap(
                userId, workspaceId, principalId, atoms("CREATE_OWN_AGENT")),
                "binding caps cannot exceed the principal or operator's current grants");
        assertTrue(grantAuthorizationService.allows(request(workspaceId, userId,
                        session, "write", "src/main.java")),
                "a rejected cap update must leave the prior binding unchanged");

        assertTrue(agentPrincipalService.unbindWorkspace(userId, workspaceId, principalId));
        assertTrue(sessionRepository.findById(session.getId()).isPresent(),
                "Workspace unbind must preserve historical Session rows");
        assertFalse(grantAuthorizationService.allows(request(workspaceId, userId,
                        session, "write", "src/main.java")),
                "unbinding revokes new actions in this Workspace");
        workspaceAgentIds.remove(binding.getId());
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'workspace_agent_unbound' AND workspace_id = ? AND resource_id = ?",
                Integer.class, workspaceId, principalId.toString()));

        // PLAN-0622 D22: disabling a WORKSPACE-scope principal requires an explicit workspace
        // context — the refusal is the contract (never a silent instance-wide disable), so assert
        // it first, then prove the authorized path still works inside a real context.
        CpApiException withoutContext = assertThrows(CpApiException.class,
                () -> agentPrincipalService.disablePrincipal(userId, principalId));
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", withoutContext.getCode(),
                "D22: without a workspace context the disable is refused");
        assertNull(agentPrincipalRepository.findById(principalId).orElseThrow().getDisabledAt(),
                "the refused call must not disable anything");
        TenantContext.setUserId(userId);
        TenantContext.setWorkspaceId(workspaceId.toString());
        TenantContext.setWorkspaceSource("header");
        try {
            assertTrue(agentPrincipalService.disablePrincipal(userId, principalId));
        } finally {
            TenantContext.clear();
        }
        AgentPrincipal disabled = agentPrincipalRepository.findById(principalId).orElseThrow();
        assertTrue(disabled.getDisabledAt() != null);
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs "
                + "WHERE action = 'agent_principal_disabled' AND user_id = ? AND resource_id = ?",
                Integer.class, UUID.fromString(userId), principalId.toString()));
    }

    @Test
    void agentTemplateResolverUsesAuthorizedRawLayersAndFreezesTheResolvedSnapshot() throws Exception {
        User user = userRepository.saveAndFlush(new User("template-scope-" + UUID.randomUUID() + "@test.com",
                "hash", "Template scope test"));
        userId = user.getId().toString();
        // B 类根因（BL-326）：同上 —— createPrincipal 需要调用者持有 instance USER 默认集。
        grantDefaultService.ensureUserDefault(user);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Template scope workspace", userId);
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.OWNER);
        // read@*/write@* 已由 ensureUserDefault 物化（uq_grants_role_atom），此测试不再手插。

        String userRoleId = UUID.randomUUID().toString();
        String workspaceRoleId = UUID.randomUUID().toString();
        String instanceRoleId = UUID.randomUUID().toString();
        String userTemplateId = UUID.randomUUID().toString();
        String workspaceTemplateId = UUID.randomUUID().toString();
        String instanceTemplateId = UUID.randomUUID().toString();
        ConfigEntity userRoles = saveTemplateConfig("user", UUID.fromString(userId), null, "roles",
                roleConfig(userRoleId, "User role", atoms("read", "write")).toString());
        ConfigEntity userTemplates = saveTemplateConfig("user", UUID.fromString(userId), null, "templates",
                templateConfig(userTemplateId, "User template", userRoleId, "user prompt v1").toString());
        saveTemplateConfig("workspace", null, workspaceId, "roles",
                roleConfig(workspaceRoleId, "Workspace role", atoms("read")).toString());
        saveTemplateConfig("workspace", null, workspaceId, "templates",
                templateConfig(workspaceTemplateId, "Workspace template", workspaceRoleId, "workspace prompt").toString());
        saveTemplateConfig("instance", null, null, "roles",
                roleConfig(instanceRoleId, "Instance role", atoms("read")).toString());
        saveTemplateConfig("instance", null, null, "templates",
                templateConfig(instanceTemplateId, "Instance template", instanceRoleId, "instance prompt").toString());

        AgentTemplateService.ResolvedTemplate userTemplate = agentTemplateService.resolveForCreation(
                userId, workspaceId.toString(), userTemplateId);
        assertEquals("user", userTemplate.sourceLayer());
        assertEquals("User role", userTemplate.snapshot().path("roleName").asText());
        assertEquals("user prompt v1", userTemplate.snapshot().path("systemPrompt").asText());
        assertEquals("openai", userTemplate.snapshot().path("provider").asText());
        assertEquals("test-model", userTemplate.snapshot().path("model").asText());
        AgentTemplateService.ResolvedTemplate workspaceTemplate = agentTemplateService.resolveForCreation(
                userId, workspaceId.toString(), workspaceTemplateId);
        assertEquals("workspace", workspaceTemplate.sourceLayer());
        assertEquals("Workspace role", workspaceTemplate.snapshot().path("roleName").asText());
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), instanceTemplateId),
                "non-admin users cannot enumerate or select instance templates");
        AgentTemplateService.ResolvedTemplate defaultTemplate = agentTemplateService.resolveForCreation(
                userId, workspaceId.toString(), null);
        assertEquals("default", defaultTemplate.sourceLayer());
        // PLAN-0610 W4b: the default snapshot is the caller's materialized atom set. The fixture user
        // holds the WS_OWNER binding, so the default carries the owner rings (design #23/#27: the
        // workspace usage atoms are materialized, only capability atoms are not).
        // PLAN-0651 M2 T2.1 widened WS_OWNER (adds N5–N9) — compare as a SET derived from the
        // catalog, not as an ordered literal, so the next widening does not re-break this assertion.
        java.util.Set<String> defaultAtoms = new java.util.LinkedHashSet<>();
        defaultTemplate.snapshot().path("permissions")
                .forEach(atom -> defaultAtoms.add(atom.path("actionClass").asText()));
        // B 类（BL-326）：夹具现在走生产注册路径（ensureUserDefault），调用者同时持有 instance USER
        // 默认集与 WS_OWNER 工作区环，default 快照就是两者的并集。期望从目录派生（不写字面量）。
        java.util.Set<String> expectedDefaultAtoms = new java.util.LinkedHashSet<>(
                RoleAtomExpectations.materializedAtoms(SystemAccessRoleCatalog.USER));
        expectedDefaultAtoms.addAll(
                RoleAtomExpectations.materializedAtoms(SystemAccessRoleCatalog.WS_OWNER));
        assertEquals(expectedDefaultAtoms, defaultAtoms,
                "no selected template preserves the bare-default grant behavior (catalog-derived set: "
                        + "instance USER ∪ workspace WS_OWNER)");

        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                userId, "TemplateBoundPrincipal", userTemplateId, userTemplate.snapshot());
        principalId = principal.getId();
        ConfigEntity updatedUserTemplates = configJpaRepository.findById(userTemplates.getId()).orElseThrow();
        updatedUserTemplates.setConfigValue(templateConfig(
                userTemplateId, "User template", userRoleId, "user prompt v2").toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);
        assertEquals("user prompt v2", agentTemplateService.resolveForCreation(
                userId, workspaceId.toString(), userTemplateId).snapshot().path("systemPrompt").asText());
        assertEquals("user prompt v1", agentPrincipalRepository.findById(principalId).orElseThrow()
                        .getTemplateSnapshot().path("systemPrompt").asText(),
                "existing principal snapshots must not follow later ConfigService changes");

        ConfigEntity updatedUserRoles = configJpaRepository.findById(userRoles.getId()).orElseThrow();
        updatedUserRoles.setConfigValue(roleConfig(userRoleId, "Updated user role", atoms("read")).toString());
        configJpaRepository.saveAndFlush(updatedUserRoles);
        AgentTemplateService.ResolvedTemplate changedRole = agentTemplateService.resolveForCreation(
                userId, workspaceId.toString(), userTemplateId);
        assertEquals("Updated user role", changedRole.snapshot().path("roleName").asText());
        assertEquals(atoms("read"), changedRole.snapshot().path("permissions"));
        assertEquals("User role", agentPrincipalRepository.findById(principalId).orElseThrow()
                        .getTemplateSnapshot().path("roleName").asText(),
                "existing principal role snapshots must not follow later role config changes");
        updatedUserRoles.setConfigValue(roleConfig(userRoleId, "User role", atoms("read", "write")).toString());
        configJpaRepository.saveAndFlush(updatedUserRoles);

        updatedUserTemplates.setConfigValue(templateConfig(
                userTemplateId, "User template", workspaceRoleId, "invalid cross-layer role reference").toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), userTemplateId),
                "template role references must resolve within the template's own config layer");
        updatedUserTemplates.setConfigValue(templateConfig(
                userTemplateId, "User template", userRoleId, "user prompt v2").toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);

        ArrayNode invalidTemplates = templateConfig(userTemplateId, "User template", userRoleId, "user prompt v2");
        ((ObjectNode) invalidTemplates.get(0)).put("unexpected", true);
        updatedUserTemplates.setConfigValue(invalidTemplates.toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), userTemplateId),
                "template config with unknown fields must fail schema validation");
        updatedUserTemplates.setConfigValue(templateConfig(
                userTemplateId, "User template", userRoleId, "user prompt v2").toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);

        ArrayNode duplicatedTemplates = (ArrayNode) objectMapper.readTree(updatedUserTemplates.getConfigValue());
        duplicatedTemplates.add(duplicatedTemplates.get(0).deepCopy());
        updatedUserTemplates.setConfigValue(duplicatedTemplates.toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), userTemplateId),
                "template IDs must be unique within each readable config layer");
        updatedUserTemplates.setConfigValue(templateConfig(
                userTemplateId, "User template", userRoleId, "user prompt v2").toString());
        configJpaRepository.saveAndFlush(updatedUserTemplates);

        ArrayNode duplicatedRoles = (ArrayNode) objectMapper.readTree(updatedUserRoles.getConfigValue());
        duplicatedRoles.add(duplicatedRoles.get(0).deepCopy());
        updatedUserRoles.setConfigValue(duplicatedRoles.toString());
        configJpaRepository.saveAndFlush(updatedUserRoles);
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), userTemplateId),
                "role IDs must be unique within the template's config layer");
        updatedUserRoles.setConfigValue(roleConfig(userRoleId, "User role", atoms("read", "write")).toString());
        configJpaRepository.saveAndFlush(updatedUserRoles);

        ArrayNode shadowingTemplates = (ArrayNode) objectMapper.readTree(
                configJpaRepository.findByWorkspaceIdAndDomainAndConfigKey(workspaceId, "agent-templates", "templates")
                        .orElseThrow().getConfigValue());
        shadowingTemplates.add(templateConfig(
                userTemplateId, "Shadow template", workspaceRoleId, "shadow prompt").get(0));
        ConfigEntity workspaceTemplates = configJpaRepository.findByWorkspaceIdAndDomainAndConfigKey(
                workspaceId, "agent-templates", "templates").orElseThrow();
        workspaceTemplates.setConfigValue(shadowingTemplates.toString());
        configJpaRepository.saveAndFlush(workspaceTemplates);
        assertThrows(CpApiException.class, () -> agentTemplateService.resolveForCreation(
                        userId, workspaceId.toString(), userTemplateId),
                "visible duplicate template IDs must fail rather than silently choose a layer");

        // PLAN-0610 W4a: the instance template layer is readable with cap:instance:admin, which a
        // binding provides (the retired users.role column no longer authorizes).
        grantInstanceAdmin(UUID.fromString(userId));
        AgentTemplateService.ResolvedTemplate instanceTemplate = agentTemplateService.resolveForCreation(
                userId, null, instanceTemplateId);
        assertEquals("instance", instanceTemplate.sourceLayer());
    }

    /**
     * PLAN-0610 W4a (round-3 P1-4): the instance template layer is gated by the
     * {@code cap:instance:admin} capability, which comes from a role binding — the retired
     * {@code users.role} column no longer authorizes anything.
     */
    private void grantInstanceAdmin(UUID userId) {
        AccessRole adminRole = accessRoleRepository.findByName(SystemAccessRoleCatalog.ADMIN)
                .orElseThrow();
        // One instance tier per subject: replace the registration USER binding before materializing,
        // otherwise the union of two tiers re-materializes atoms that already exist.
        bindingRepository.deleteAll(bindingRepository.findBySubjectTypeAndSubjectIdAndScopeType(
                "user", userId, AccessScope.INSTANCE));
        bindingRepository.flush();
        bindingRepository.save(new AccessRoleBinding(adminRole.getId(), "user", userId,
                AccessScope.INSTANCE, null, userId));
        // B 类（BL-326，2026-11-05）：必须**物化** ADMIN 的行动作原子（N2 READ_INSTANCE_CONTENT 等）。
        // 旧注释说"夹具已手写同原子行、capability 从绑定解析"——但 cap:instance:admin 是 capability，
        // 而实例层模板读取判定的是**行动作原子** `READ_INSTANCE_CONTENT`（AgentTemplateService:249 →
        // requesterAuthority.holdsActionAtom），它只认 grants 行；夹具只手写过 read/write，于是判定为
        // 不可读 → "No readable Agent template matches the selected ID"。物化是生产同一路径。
        materializer.materializeSubject("user", userId, userId, null);
        bindingRepository.flush();
        authzContext.invalidate(userId);
        // B 类（BL-326）：本测试在换绑定**之前**已经求值过 capability（第 571 行的默认模板解析），
        // 单主体 invalidate 不一定覆盖动作原子缓存 ⇒ 全量失效，否则实例层读取仍拿旧结果。
        authzContext.invalidateAll();
    }

    private ArrayNode roleConfig(String id, String name, ArrayNode permissions) {
        ObjectNode role = objectMapper.createObjectNode();
        role.put("id", id);
        role.put("name", name);
        role.set("permissions", permissions);
        ArrayNode result = objectMapper.createArrayNode();
        result.add(role);
        return result;
    }

    private ArrayNode templateConfig(String id, String name, String roleId, String systemPrompt) {
        ObjectNode template = objectMapper.createObjectNode();
        template.put("id", id);
        template.put("name", name);
        template.put("description", name + " description");
        template.put("systemPrompt", systemPrompt);
        template.put("toolMode", "workspace");
        template.put("provider", "openai");
        template.put("model", "test-model");
        template.put("roleId", roleId);
        ArrayNode result = objectMapper.createArrayNode();
        result.add(template);
        return result;
    }

    private Session saveAgentSession(UUID wsId, String ownerId, String title, ArrayNode cap) {
        Session session = new Session(wsId.toString(), ownerId, title);
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(cap);
        Session saved = sessionRepository.save(session);
        bindPrimaryParticipant(saved.getId().toString(), principalId.toString());
        sessionIds.add(saved.getId());
        return saved;
    }

    private Session saveDerivedSession(UUID wsId, String ownerId, Session parent, ChatRun parentRun,
                                       String kind, ArrayNode cap) {
        Session session = new Session(wsId.toString(), ownerId, kind + " agent");
        session.setId(UUID.randomUUID());
        session.setSpawnedFromSessionId(parent.getId());
        session.setSpawnedFromRunId(parentRun.getId());
        session.setSpawnedAt(Instant.now());
        session.setKind(kind);
        session.setAgentPermissionsSnapshot(cap);
        Session saved = sessionRepository.save(session);
        bindPrimaryParticipant(saved.getId().toString(), principalId.toString());
        sessionIds.add(saved.getId());
        return saved;
    }

    private void bindPrincipal(UUID workspace, ArrayNode cap) {
        WorkspaceAgent binding = workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principalId.toString(), workspace.toString(), cap));
        workspaceAgentIds.add(binding.getId());
    }

    private void setBindingCap(UUID workspace, ArrayNode cap) {
        WorkspaceAgent binding = workspaceAgentRepository.findById(
                new WorkspaceAgentId(principalId, workspace)).orElseThrow();
        binding.setPermissionsSnapshot(cap);
        workspaceAgentRepository.saveAndFlush(binding);
    }

    private ConfigEntity saveTemplateConfig(String layer, UUID ownerUserId, UUID ownerWorkspaceId,
                                            String key, String value) {
        if ("instance".equals(layer)) {
            // PLAN-0625 (V97/V98) seeds the instance layer with the guard role + template, and
            // uq_config_instance_scope allows exactly one (domain, config_key) row per layer — a blind
            // insert therefore dies on the product seed. Merge the fixture's entries into the existing
            // document instead of assuming an empty layer (0566 precedent), and restore it afterwards.
            var seeded = configJpaRepository.findByLayerAndDomainAndConfigKey(layer, "agent-templates", key);
            if (seeded.isPresent()) {
                return mergeIntoSeededConfig(seeded.get(), value);
            }
        }
        ConfigEntity entity = new ConfigEntity();
        entity.setLayer(layer);
        entity.setUserId(ownerUserId);
        entity.setWorkspaceId(ownerWorkspaceId);
        entity.setDomain("agent-templates");
        entity.setConfigKey(key);
        entity.setConfigValue(value);
        entity.setUpdatedBy("test-fixture");
        ConfigEntity saved = configJpaRepository.saveAndFlush(entity);
        configIds.add(saved.getId());
        return saved;
    }

    /**
     * Appends the fixture entries whose {@code id} is not already present. Idempotent on purpose: the
     * fixture must not depend on how many entries a future seed ships.
     */
    private ConfigEntity mergeIntoSeededConfig(ConfigEntity seeded, String fixtureDocument) {
        try {
            var merged = (ArrayNode) objectMapper.readTree(seeded.getConfigValue());
            for (var addition : (ArrayNode) objectMapper.readTree(fixtureDocument)) {
                boolean present = false;
                for (var existing : merged) {
                    if (existing.path("id").asText().equals(addition.path("id").asText())) {
                        present = true;
                        break;
                    }
                }
                if (!present) {
                    merged.add(addition);
                }
            }
            mergedConfigOriginals.putIfAbsent(seeded.getId(), seeded.getConfigValue());
            seeded.setConfigValue(merged.toString());
            seeded.setUpdatedBy("test-fixture");
            return configJpaRepository.saveAndFlush(seeded);
        } catch (com.fasterxml.jackson.core.JsonProcessingException | ClassCastException cause) {
            throw new IllegalStateException(
                    "Seeded agent-templates document is not a JSON array: id=" + seeded.getId(), cause);
        }
    }

    private UUID addGrant(String subjectType, UUID subjectId, String source,
                          String granterType, UUID granterId, ArrayNode permissions) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(subjectType);
        grant.setSubjectId(subjectId);
        grant.setGranterType(granterType);
        grant.setGranterId(granterId);
        grant.setSource(source);
        grant.setPermissions(permissions);
        UUID savedId = grantRepository.save(grant).getId();
        grantIds.add(savedId);
        return savedId;
    }

    private ArrayNode atoms(String... actionClasses) {
        ArrayNode permissions = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            permissions.add(atom);
        }
        return permissions;
    }

    private ArrayNode atomWithResource(String actionClass, String resource) {
        ArrayNode permissions = objectMapper.createArrayNode();
        ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", actionClass);
        atom.put("resource", resource);
        permissions.add(atom);
        return permissions;
    }

    private static PolicyRequest request(UUID wsId, String ownerId, Session session,
                                         String actionClass, String resource) {
        return new PolicyRequest("write_file", List.of(actionClass), List.of(resource), ToolShape.STRUCTURED,
                ownerId, wsId.toString(), session.getId().toString());
    }
}
