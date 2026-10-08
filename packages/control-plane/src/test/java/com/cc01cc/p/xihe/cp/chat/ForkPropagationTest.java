package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0407 T2.9 / V10：kind 传播差集成（真实 PostgreSQL），联测 PLAN-0409。
 *
 * <p><b>今天就能断言的</b>：sessions.kind CHECK 语义（V40）、停 spawn 链式停子 /
 * 停 fork 不停 fork 侧（本类经公开 cancel 端点路径）、fork child 终态不聚合父账本
 * （{@code ChatRunTerminalService.lockParentLink} 的 kind 门）、权限祖先路径只沿
 * kind=spawn / fork 为新 root（{@code GrantPrincipalPathResolver} 直连断言，spec §3.2）。
 *
 * <p><b>PLAN-0409 fork 生产路径（已落地，本类不重复断言）</b>：
 * <ul>
 *   <li>fork Session 的生产创建路径为 {@code SessionForkService.fork} →
 *       {@code SessionService.createForkSession}（写入 {@code kind='fork'}），
 *       端到端行为由 {@code SessionForkIntegrationTest} 覆盖；</li>
 *   <li>{@code fork run_id → SET NULL 降级}已由
 *       {@code SessionForkIntegrationTest#forkEndpointCopiesIndependentRowsReplaysAndSurvivesParentDeletion}
 *       覆盖（V4）。</li>
 * </ul>
 */
class ForkPropagationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private ChatRunCancellationService cancellationService;

    @Autowired
    private ChatController chatController;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private SessionService sessionService;

    @Autowired
    private GrantPrincipalPathResolver principalPathResolver;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MessageRepository messageRepository;

    @Autowired
    private BranchPathService branchPathService;

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private SessionForkService sessionForkService;

    @Autowired
    private MessageController messageController;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.McpInvocationRepository mcpInvocationRepository;

    private String userId;
    private String workspaceId;
    private UUID principalId;

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null) {
            SpawnTestSupport.clearForWorkspace(mcpInvocationRepository, jdbcTemplate, workspaceId);
            deleteWorkspaceSessions();
        }
        if (principalId != null && workspaceId != null
                && workspaceAgentRepository.existsById(
                        new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)))) {
            workspaceAgentRepository.deleteById(new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)));
        }
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    "agent_principal", principalId));
            agentPrincipalRepository.deleteById(principalId);
        }
        if (workspaceId != null) {
            workspaceRepository.deleteById(UUID.fromString(workspaceId));
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
        userId = null;
        workspaceId = null;
        principalId = null;
    }

    /**
     * kind 传播差的 schema 基础（V40 / spec §3.2）：{@code ck_sessions_kind} 拒绝
     * 枚举外 kind，{@code ck_sessions_provenance_shape} 拒绝"有 kind 无 provenance"。
     * 正例（合法 spawn/fork/root 行可写入）由 {@code DomainSchemaMigrationTest} 的 V41 升级夹具与
     * {@code SpawnCancelSerializationTest} 的 fork fixture 覆盖；本类补直接写库时的反例缺口。
     */
    @Test
    void sessionsKindCheckRejectsUnknownKindAndProvenancelessDerivedRow() {
        ensureWorkspace();

        DataAccessException invalidKind = assertThrows(DataAccessException.class, () ->
                jdbcTemplate.execute("INSERT INTO sessions (id, workspace_id, user_id, title, "
                        + "spawned_from_session_id, spawned_from_run_id, spawned_at, kind) VALUES ('"
                        + UUID.randomUUID() + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                        + "'::uuid, 'bad-kind', '" + UUID.randomUUID() + "'::uuid, '"
                        + UUID.randomUUID() + "'::uuid, NOW(), 'clone')"));
        assertTrue(messagesContain(invalidKind, "ck_sessions_kind"),
                "an out-of-enum kind must be rejected by ck_sessions_kind: " + invalidKind);

        DataAccessException provenanceless = assertThrows(DataAccessException.class, () ->
                jdbcTemplate.execute("INSERT INTO sessions (id, workspace_id, user_id, title, kind) VALUES ('"
                        + UUID.randomUUID() + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                        + "'::uuid, 'provenanceless-fork', 'fork')"));
        assertTrue(messagesContain(provenanceless, "ck_sessions_provenance_shape"),
                "kind without full provenance must be rejected by ck_sessions_provenance_shape: "
                        + provenanceless);
    }

    /**
     * V10 kind 传播差（公开 cancel 端点路径）：停 spawn root → 活跃 spawn child
     * 链式取消；同一父 Session 下的 fork-side run 不受影响。fork 不跟随是既有
     * 服务级断言（{@code SpawnCancelSerializationTest} :197）在端点链路
     * （ChatController.cancelRun → cancelSerialized → 传播）上的复验 + 组合场景。
     */
    @Test
    void cancelEndpointStopsSpawnChainButLeavesForkSideRunRunning() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"v10 endpoint\"}");
        ChatSubmissionService.SpawnResult child = spawnDirect(parent.parentRunId, parent.toolCallId);
        assertNotNull(child.runId());
        Session fork = forkSession(parent.parentSessionId, parent.parentRunId);
        String forkRunId = saveRun(fork, "running");

        ResponseEntity<Map<String, Object>> response = cancelViaController(parent.parentRunId);
        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertNotNull(response.getBody());
        assertEquals("cancel_accepted", response.getBody().get("status"));

        assertEquals("cancelled", runStatus(parent.parentRunId), "the stopped spawn root reaches terminal");
        assertEquals("cancelled", runStatus(child.runId()),
                "stop spawns chain-cancel their active spawn child (V10 spawn side)");
        assertEquals("running", runStatus(forkRunId),
                "the fork-side run must NOT be stopped by an ancestor cancel (V10 fork side)");
        assertTrue(sessionRepository.findById(fork.getId()).isPresent(), "cancel never deletes sessions");
        assertTrue(sessionRepository.findById(UUID.fromString(child.sessionId())).isPresent(),
                "cancel never deletes sessions");
    }

    /**
     * V10/spec §4 kind 门在终态事务侧的传播差：fork child 的 terminal 不走
     * parent aggregate 路径——即使 live parent 在场且其 item 没有指向该 run 的
     * waiting link（fork 不是 spawn 工具子项，本就不会有），fork 终态照常提交
     * {@code terminal_at}，且不触碰 parent run / parent item。
     * spawn 侧的反向严格性（live parent 无 waiting link → 整笔回滚）已由
     * {@code TerminalTransactionCoreIntegrationTest.liveParentWithoutWaitingLinkRollsBackTerminalTransition}
     * 覆盖，本类不重复。
     */
    @Test
    void forkRunTerminalizesWithoutParentAggregationOrWaitingLink() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"fork terminal\"}");
        Session fork = forkSession(parent.parentSessionId, parent.parentRunId);
        String forkRunId = saveRun(fork, "running");

        ChatRunCancellationService.CancelClaim claim = cancellationService.cancelSerialized(
                forkRunId, fork.getId().toString(), userId, workspaceId, "fork_side_stop");
        assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED, claim.outcome());

        ChatRun forkRun = chatRunRepository.findById(UUID.fromString(forkRunId)).orElseThrow();
        assertEquals("cancelled", forkRun.getStatus(), "the fork child run reaches its own terminal state");
        assertNotNull(forkRun.getTerminalAt(), "fork child terminal commits terminal_at in one transaction");
        assertEquals("running", runStatus(parent.parentRunId),
                "fork terminal must not settle or cancel the parent run");
        assertEquals("active", mcpInvocationRepository.findByRunIdAndToolCallIdAndSource(
                parent.parentRunId, parent.toolCallId, "agent").orElseThrow().getStatus(),
                "fork terminal must not mutate the parent MCP invocation");
        assertTrue(sessionRepository.findById(fork.getId()).isPresent(),
                "cancel never deletes sessions");
    }

    /**
     * spec §3.2 / G3 权限祖先路径差异：spawn child 的 principal path 沿
     * spawned_from 链上溯到 root；fork 的 path 只含自身（fork 是新 root，
     * 不从父链追加权限）。end-to-end allows() 差异已由
     * {@code GrantAuthorizationServiceIntegrationTest}（fork 不继承 :277-281、
     * spawn 链交集 :344-365）覆盖，本类直连断言 resolver 的路径形状机制。
     */
    @Test
    void permissionPathFollowsSpawnChainButStopsAtForkRoot() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"permission path\"}");
        Session spawnChild = derivedSession("resolver spawn child", Session.KIND_SPAWN,
                UUID.fromString(parent.parentSessionId), UUID.fromString(parent.parentRunId));
        Session forkChild = derivedSession("resolver fork child", Session.KIND_FORK,
                UUID.fromString(parent.parentSessionId), UUID.fromString(parent.parentRunId));

        GrantPrincipalPathResolver.AgentPath rootPath = principalPathResolver.resolveAgent(
                userId, workspaceId, parent.parentSessionId);
        GrantPrincipalPathResolver.AgentPath spawnPath = principalPathResolver.resolveAgent(
                userId, workspaceId, spawnChild.getId().toString());
        GrantPrincipalPathResolver.AgentPath forkPath = principalPathResolver.resolveAgent(
                userId, workspaceId, forkChild.getId().toString());

        assertEquals(principalId, rootPath.principalId());
        assertEquals(principalId, spawnPath.principalId());
        assertEquals(principalId, forkPath.principalId());
        assertEquals(List.of(UUID.fromString(parent.parentSessionId)), sessionIds(rootPath),
                "a root Session has exactly itself on its permission path");
        assertEquals(List.of(UUID.fromString(parent.parentSessionId), spawnChild.getId()), sessionIds(spawnPath),
                "spawn permission ancestors follow the kind=spawn chain up to the root (spec §3.2)");
        assertEquals(List.of(forkChild.getId()), sessionIds(forkPath),
                "fork is a new root: no ancestor session joins its permission path (spec §3.2)");
    }

    @Test
    void forkPermissionRootSurvivesSourceSessionAndRunDeletion() {
        ensureWorkspace();
        Session parent = new Session(workspaceId, userId, "Fork root parent");
        parent.setId(UUID.randomUUID());
        parent.setAgentPrincipalId(principalId.toString());
        parent.setAgentPermissionsSnapshot(capNode());
        parent = sessionRepository.saveAndFlush(parent);
        String parentRunId = saveRun(parent, "running");
        Session forkChild = forkSession(parent.getId().toString(), parentRunId);

        sessionService.delete(parent.getId().toString(), userId, workspaceId);

        assertTrue(sessionRepository.findById(parent.getId()).isEmpty());
        GrantPrincipalPathResolver.AgentPath forkPath = principalPathResolver.resolveAgent(
                userId, workspaceId, forkChild.getId().toString());
        assertEquals(List.of(forkChild.getId()), sessionIds(forkPath),
                "a deleted source Session/Run must not invalidate the fork's own permission root");
    }

    /**
     * V7 缺失子句：删除 fork child 侧不得改动 source——本类既有用例只覆盖反向
     * （删 source 后 fork 存活），这里断言 sessions / messages / chat_runs 三表
     * 逐项计数与删除前相等，且 source 的 messages 读取照常返回全部可见行。
     */
    @Test
    void deletingForkChildLeavesSourceUntouched() {
        ensureWorkspace();
        Session parent = new Session(workspaceId, userId, "Fork child delete source");
        parent.setId(UUID.randomUUID());
        parent.setAgentPrincipalId(principalId.toString());
        parent.setAgentPermissionsSnapshot(capNode());
        parent.setModelProvider("openai");
        parent.setModelName("gpt-test");
        parent = sessionRepository.saveAndFlush(parent);
        String sourceId = parent.getId().toString();

        String rootBranchId = branchPathService.ensureRootBranchId(sourceId);
        String runId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, sourceId, userId, workspaceId,
                "fork-child-delete-" + runId, "b".repeat(64), "openai", "gpt-test", "none", "succeeded");
        run.setBranchId(rootBranchId);
        run.setTerminalAt(Instant.now());
        run.setTerminalOutcome("success");
        run = chatRunRepository.saveAndFlush(run);

        Message userMessage = new Message(sourceId, MessageRole.USER, "fork child delete prompt");
        userMessage.setRunId(runId);
        userMessage.setBranchId(rootBranchId);
        userMessage = messageRepository.saveAndFlush(userMessage);
        Message assistantMessage = new Message(sourceId, MessageRole.ASSISTANT, "fork child delete answer");
        assistantMessage.setRunId(runId);
        assistantMessage.setBranchId(rootBranchId);
        assistantMessage = messageRepository.saveAndFlush(assistantMessage);
        run.setUserMessageId(userMessage.getId().toString());
        run.setAssistantMessageId(assistantMessage.getId().toString());
        chatRunRepository.saveAndFlush(run);

        eventStoreService.append(sourceId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "fork child delete prompt")),
                runId, rootBranchId);
        eventStoreService.append(sourceId, workspaceId, userId, "assistant.responded",
                Map.of("message", Map.of("role", "ai", "content", "fork child delete answer")),
                runId, rootBranchId);

        SessionForkService.ForkResult forked = sessionForkService.fork(sourceId, userId, workspaceId,
                rootBranchId, assistantMessage.getId().toString(), "fork-child-delete-key");
        assertFalse(forked.replayed());
        Session child = forked.session();
        assertEquals(Session.KIND_FORK, child.getKind());
        assertEquals(parent.getId(), child.getSpawnedFromSessionId());

        int sessionsBefore = countRows("select count(*) from sessions where id = ?", parent.getId());
        int messagesBefore = countRows("select count(*) from messages where session_id = ?", parent.getId());
        int runsBefore = countRows("select count(*) from chat_runs where session_id = ?", parent.getId());
        assertEquals(1, sessionsBefore);
        assertEquals(2, messagesBefore);
        assertEquals(1, runsBefore);

        sessionService.delete(child.getId().toString(), userId, workspaceId);

        assertTrue(sessionRepository.findById(child.getId()).isEmpty());
        assertEquals(sessionsBefore, countRows("select count(*) from sessions where id = ?", parent.getId()),
                "deleting the fork child must not touch the source Session row");
        assertEquals(messagesBefore, countRows("select count(*) from messages where session_id = ?", parent.getId()),
                "deleting the fork child must not touch source Message rows");
        assertEquals(runsBefore, countRows("select count(*) from chat_runs where session_id = ?", parent.getId()),
                "deleting the fork child must not touch source ChatRun rows");

        ResponseEntity<?> sourceMessages = listMessagesViaController(sourceId, rootBranchId);
        assertEquals(HttpStatus.OK, sourceMessages.getStatusCode());
        assertEquals(2, ((List<?>) sourceMessages.getBody()).size(),
                "the source messages read stays healthy after the child is deleted");
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    private int countRows(String sql, Object id) {
        return jdbcTemplate.queryForObject(sql, Integer.class, id);
    }

    /** 与 {@link #cancelViaController} 同一手法：直连 Controller 需要 SecurityContext + TenantContext。 */
    private ResponseEntity<?> listMessagesViaController(String sessionId, String branchId) {
        com.cc01cc.p.xihe.cp.config.TenantContext.setUserId(userId);
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspaceId(workspaceId);
        org.springframework.security.core.context.SecurityContextHolder.getContext().setAuthentication(
                new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(
                        userId, null,
                        List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority(
                                "ROLE_USER"))));
        try {
            return messageController.listMessages(sessionId, branchId);
        } finally {
            org.springframework.security.core.context.SecurityContextHolder.clearContext();
            com.cc01cc.p.xihe.cp.config.TenantContext.clear();
        }
    }

    /**
     * cancel 的 settle 会 fire-and-forget 排队 checkpoint capture（后台单线程）；
     * 其写入与会话级联删除交叉时 PG 会检出死锁并即刻失败。有界轮询重试等
     * capture 自然收敛，不使用固定 sleep。
     */
    private void deleteWorkspaceSessions() {
        String sql = "DELETE FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?";
        try {
            Awaitility.await().atMost(Duration.ofSeconds(15)).pollInterval(Duration.ofMillis(100))
                    .until(() -> {
                        try {
                            jdbcTemplate.update(sql, workspaceId);
                            return true;
                        } catch (PessimisticLockingFailureException e) {
                            return false;
                        }
                    });
        } catch (org.awaitility.core.ConditionTimeoutException e) {
            throw new AssertionError(
                    "workspace session cleanup did not converge under capture/lock contention", e);
        }
    }

    private record ParentFixture(String parentSessionId, String parentRunId, String toolCallId) {}

    private ParentFixture fixture(String toolName, String argumentsPreview) {
        ensureWorkspace();
        Session parentSession = new Session(workspaceId, userId,
                "Fork propagation parent " + UUID.randomUUID().toString().substring(0, 8));
        parentSession.setId(UUID.randomUUID());
        parentSession.setAgentPrincipalId(principalId.toString());
        parentSession.setAgentPermissionsSnapshot(capNode());
        sessionRepository.saveAndFlush(parentSession);

        String parentRunId = saveRun(parentSession, "running");
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parentSession.getId().toString(), parentRunId, workspaceId, userId,
                toolCallId, toolName, argumentsPreview);
        return new ParentFixture(parentSession.getId().toString(), parentRunId, toolCallId);
    }

    /** This suite isolates kind propagation; spawn admission gates are tested separately. */
    private ChatSubmissionService.SpawnResult spawnDirect(String parentRunId, String toolCallId) {
        ChatSubmissionService.SpawnInvocation invocation =
                submissionService.prepareSpawnInvocation(parentRunId, toolCallId);
        return submissionService.createSpawnFromParent(parentRunId, toolCallId,
                new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null));
    }

    private Session derivedSession(String title, String kind, UUID parentSessionId, UUID parentRunId) {
        Session derived = new Session(workspaceId, userId, title);
        derived.setId(UUID.randomUUID());
        derived.setKind(kind);
        derived.setSpawnedFromSessionId(parentSessionId);
        derived.setSpawnedFromRunId(parentRunId);
        derived.setSpawnedAt(Instant.now());
        derived.setAgentPrincipalId(principalId.toString());
        derived.setAgentPermissionsSnapshot(capNode());
        return sessionRepository.saveAndFlush(derived);
    }

    private Session forkSession(String parentSessionId, String parentRunId) {
        return derivedSession("Fork propagation fork", Session.KIND_FORK,
                UUID.fromString(parentSessionId), UUID.fromString(parentRunId));
    }

    private String saveRun(Session session, String status) {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                runId, session.getId().toString(), userId, workspaceId,
                "fork-propagation-submit-" + runId, "fork-propagation-hash-" + runId,
                "provider", "model", "workspace", status));
        return runId;
    }

    private ResponseEntity<Map<String, Object>> cancelViaController(String runId) {
        com.cc01cc.p.xihe.cp.config.TenantContext.setUserId(userId);
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspaceId(workspaceId);
        // @PreAuthorize 走方法级安全拦截，直接调用 bean 也需要 SecurityContext。
        org.springframework.security.core.context.SecurityContextHolder.getContext().setAuthentication(
                new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(
                        userId, null,
                        List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority(
                                "ROLE_USER"))));
        try {
            return chatController.cancelRun(runId, Map.of("reason", "v10_kind_propagation"));
        } finally {
            org.springframework.security.core.context.SecurityContextHolder.clearContext();
            com.cc01cc.p.xihe.cp.config.TenantContext.clear();
        }
    }

    private void ensureWorkspace() {
        if (userId != null) {
            return;
        }
        User user = userRepository.save(new User("fork-propagation-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Fork propagation test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Fork propagation test", userId));
        workspaceId = workspace.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Fork propagation principal");
        principal.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principalId.toString(), workspaceId, capNode()));
    }

    private com.fasterxml.jackson.databind.node.ArrayNode capNode() {
        com.fasterxml.jackson.databind.node.ArrayNode cap = objectMapper.createArrayNode();
        com.fasterxml.jackson.databind.node.ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", "read");
        cap.add(atom);
        return cap;
    }

    private static List<UUID> sessionIds(GrantPrincipalPathResolver.AgentPath path) {
        return path.sessionPath().stream().map(Session::getId).collect(Collectors.toList());
    }

    private static boolean messagesContain(Throwable failure, String needle) {
        Throwable current = failure;
        int guard = 0;
        while (current != null && guard++ < 32) {
            if (current.getMessage() != null && current.getMessage().contains(needle)) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private String runStatus(String runId) {
        return chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getStatus();
    }
}
