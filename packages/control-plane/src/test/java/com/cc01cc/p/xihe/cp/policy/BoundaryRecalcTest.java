package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class BoundaryRecalcTest extends AbstractIntegrationTest {

    @Autowired
    private PolicyEngine policyEngine;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ObjectMapper objectMapper;

    private String userId;
    private UUID workspaceId;
    private UUID principalId;
    private final List<UUID> sessionIds = new ArrayList<>();
    private final List<UUID> grantIds = new ArrayList<>();
    private final List<WorkspaceAgentId> workspaceAgentIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        grantRepository.deleteAllById(grantIds);
        sessionIds.forEach(sessionRepository::deleteById);
        workspaceAgentRepository.deleteAllById(workspaceAgentIds);
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            agentPrincipalRepository.deleteById(principalId);
        }
        if (workspaceId != null) {
            workspaceUserRepository.deleteAll(workspaceUserRepository.findByIdWorkspaceId(workspaceId));
            workspaceRepository.deleteById(workspaceId);
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
    }

    @Test
    void appendedDirectGrantTakesEffectAtNextToolCallAndRevocationRestoresDeny() {
        User user = userRepository.save(new User("boundary-grant-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Boundary recalc grant test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Boundary recalc grant test", userId));
        workspaceId = workspace.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId.toString(), userId, WorkspaceRole.OWNER));

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Boundary recalc agent");
        principal.setCreatedByUserId(userId);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();

        addGrant(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, "default", null, null,
                atoms("read", "write"));
        bindPrincipal(workspaceId, atoms("read", "write", "SPAWN_AGENT"));
        Session session = saveAgentSession(workspaceId, userId, "Boundary recalc agent",
                atoms("read", "write", "SPAWN_AGENT"));

        String spawnBody = "{\"params\":{\"arguments\":{\"prompt\":\"boundary recalc\"}}}";
        assertFalse(gateAllowsSpawn(session, spawnBody),
                "I4（仅工具调用边界重算）：主体默认权限集不含 SPAWN_AGENT 时，工具调用边界必须拒绝");

        UUID appended = addGrant(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, "direct",
                "user", UUID.fromString(userId), atoms("SPAWN_AGENT"));
        assertTrue(gateAllowsSpawn(session, spawnBody),
                "I4（追加授权下一工具生效）：追加 direct grant 后的下一次工具调用必须放行");

        grantRepository.deleteById(appended);
        grantIds.remove(appended);
        assertFalse(gateAllowsSpawn(session, spawnBody),
                "I4（追加授权下一工具生效）：撤销该 direct grant 后的下一次工具调用必须恢复拒绝");
    }

    @Test
    void bindingCapChangeTakesEffectAtNextToolCall() {
        User user = userRepository.save(new User("boundary-cap-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Boundary recalc cap test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Boundary recalc cap test", userId));
        workspaceId = workspace.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId.toString(), userId, WorkspaceRole.OWNER));

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Boundary recalc cap agent");
        principal.setCreatedByUserId(userId);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();

        addGrant(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, "default", null, null,
                atoms("read", "write"));
        bindPrincipal(workspaceId, atoms("read"));
        Session session = saveAgentSession(workspaceId, userId, "Boundary recalc cap agent",
                atoms("read", "write"));

        String writeBody = "{\"params\":{\"arguments\":{\"path\":\"src/main.java\"}}}";
        assertFalse(gateAllowsWrite(session, writeBody),
                "I4（驱动者切换下一工具生效）：Workspace binding cap 未含 write 时，工具调用边界必须拒绝");

        setBindingCap(workspaceId, atoms("read", "write"));
        assertTrue(gateAllowsWrite(session, writeBody),
                "I4（驱动者切换下一工具生效）：放宽 workspace_agents.permissions_snapshot 后的下一次工具调用必须放行");

        setBindingCap(workspaceId, atoms("read"));
        assertFalse(gateAllowsWrite(session, writeBody),
                "I4（驱动者切换下一工具生效）：收紧 workspace_agents.permissions_snapshot 后的下一次工具调用必须拒绝");
    }

    @Test
    void evaluationExceptionFailsClosedToDeny() {
        UnitFixture corruptRow = unitFixture();
        AuthorizationGrant corrupt = new AuthorizationGrant();
        corrupt.setId(UUID.randomUUID());
        corrupt.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        corrupt.setSubjectId(corruptRow.principalId());
        corrupt.setSource("default");
        corrupt.setPermissions(objectMapper.getNodeFactory().textNode("not-an-atom-array"));
        when(corruptRow.grantRepository().findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, corruptRow.principalId()))
                .thenReturn(List.of(corrupt));
        assertFalse(corruptRow.service().allows(corruptRow.request()),
                "I4（评估异常 = fail-closed 拒绝）：损坏的 grant 行触发评估异常时必须拒绝而非放行");

        UnitFixture brokenPath = unitFixture();
        doThrow(new IllegalArgumentException("Session principal path is invalid"))
                .when(brokenPath.resolver()).resolveAgent(any(), any(), any());
        assertFalse(brokenPath.service().allows(brokenPath.request()),
                "I4（评估异常 = fail-closed 拒绝）：主体路径解析异常必须 fail-closed 拒绝");
    }

    @Test
    void unexpectedEvaluationRuntimeExceptionNeverAllows() {
        UnitFixture unit = unitFixture();
        when(unit.grantRepository().findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, unit.principalId()))
                .thenThrow(new IllegalStateException("simulated evaluation failure"));

        IllegalStateException thrown = assertThrows(IllegalStateException.class,
                () -> unit.service().allows(unit.request()),
                "I4（评估异常 = fail-closed 拒绝）：未预期的评估异常绝不能被转成放行");
        assertEquals("simulated evaluation failure", thrown.getMessage(),
                "I4（评估异常 = fail-closed 拒绝）：非 IllegalArgumentException 的评估异常必须上抛为错误，"
                        + "工具调用不得被执行");
    }

    @Test
    void singleEvaluationReadsStateOnceWithoutReread() {
        UnitFixture unit = unitFixture();
        AuthorizationGrant initial = grantRow(unit.principalId(), atoms("read"));
        AuthorizationGrant midFlightChange = grantRow(unit.principalId(), atoms("read", "SPAWN_AGENT"));
        AtomicInteger reads = new AtomicInteger();
        when(unit.grantRepository().findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, unit.principalId())).thenAnswer(invocation -> {
                    if (reads.incrementAndGet() == 1) {
                        return List.of(initial);
                    }
                    return List.of(midFlightChange);
                });

        assertFalse(unit.service().allows(unit.request()),
                "I4（评估内不重读）：单次评估必须只使用其开始时读取的快照，"
                        + "不得在评估中重读到更宽的状态");
        assertEquals(1, reads.get(),
                "I4（评估内不重读）：单次评估只读取一次 grant 状态");
        verify(unit.grantRepository(), times(1))
                .findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.AGENT_PRINCIPAL, unit.principalId());
        verify(unit.bindingRepository(), times(1)).findById(any(WorkspaceAgentId.class));
        verify(unit.resolver(), times(1)).resolveAgent(anyString(), anyString(), anyString());
    }

    private record UnitFixture(AuthorizationGrantRepository grantRepository,
                               WorkspaceAgentRepository bindingRepository,
                               GrantPrincipalPathResolver resolver,
                               GrantAuthorizationService service,
                               UUID principalId,
                               PolicyRequest request) {}

    private UnitFixture unitFixture() {
        UUID workspaceId = UUID.randomUUID();
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        UUID principalId = UUID.randomUUID();

        AuthorizationGrantRepository grantRepository = mock(AuthorizationGrantRepository.class);
        AgentPrincipalRepository principalRepository = mock(AgentPrincipalRepository.class);
        WorkspaceAgentRepository bindingRepository = mock(WorkspaceAgentRepository.class);
        GrantPrincipalPathResolver resolver = mock(GrantPrincipalPathResolver.class);
        WorkspaceRepository workspaceRepository = mock(WorkspaceRepository.class);
        WorkspaceUserRepository workspaceUserRepository = mock(WorkspaceUserRepository.class);

        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(principalId);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        when(principalRepository.findById(principalId)).thenReturn(Optional.of(principal));
        when(workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId))
                .thenReturn(Optional.of(new Workspace("unit workspace", userId)));
        when(bindingRepository.findById(any(WorkspaceAgentId.class))).thenReturn(Optional.of(
                new WorkspaceAgent(principalId.toString(), workspaceId.toString(),
                        atoms("read", "write", "SPAWN_AGENT"))));

        Session session = new Session(workspaceId.toString(), userId, "unit session");
        session.setId(UUID.fromString(sessionId));
        session.setAgentPermissionsSnapshot(atoms("read", "write", "SPAWN_AGENT"));
        com.cc01cc.p.xihe.cp.service.SessionReadService.SessionPathView sessionPathView =
                new com.cc01cc.p.xihe.cp.service.SessionReadService.SessionPathView(
                        session.getId(), session.getUserId(), session.getWorkspaceId(),
                        session.getAgentPrincipalId(), session.getSpawnedFromSessionId(),
                        session.getSpawnedFromRunId(), session.getSpawnedAt(), session.getKind(),
                        session.getAgentPermissionsSnapshot());
        when(resolver.resolveAgent(userId, workspaceId.toString(), sessionId))
                .thenReturn(new GrantPrincipalPathResolver.AgentPath(principalId, List.of(sessionPathView)));

        GrantAuthorizationService service = new GrantAuthorizationService(grantRepository,
                principalRepository, bindingRepository, resolver, new GrantIntersectionEvaluator(),
                workspaceRepository, workspaceUserRepository);
        PolicyRequest request = new PolicyRequest("spawn_agent", List.of("SPAWN_AGENT"), List.of("*"),
                ToolShape.STRUCTURED, userId, workspaceId.toString(), sessionId);
        return new UnitFixture(grantRepository, bindingRepository, resolver, service, principalId, request);
    }

    private AuthorizationGrant grantRow(UUID subjectId, ArrayNode permissions) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        grant.setSubjectId(subjectId);
        grant.setSource("default");
        grant.setPermissions(permissions);
        return grant;
    }

    private boolean gateAllowsSpawn(Session session, String body) {
        return policyEngine.allowsByGrant(PolicyContext.EMPTY, "spawn_agent", body,
                session.getId().toString(), userId, workspaceId.toString(), false);
    }

    private boolean gateAllowsWrite(Session session, String body) {
        return policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", body,
                session.getId().toString(), userId, workspaceId.toString(), false);
    }

    private Session saveAgentSession(UUID wsId, String ownerId, String title, ArrayNode cap) {
        Session session = new Session(wsId.toString(), ownerId, title);
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(principalId.toString());
        session.setAgentPermissionsSnapshot(cap);
        Session saved = sessionRepository.save(session);
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
            var atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            permissions.add(atom);
        }
        return permissions;
    }
}
