package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0630 M2 (T2.8 + T2.9): the shared chain walk on the real paths — real PostgreSQL.
 *
 * <p>Two things can only be proven here:</p>
 * <ol>
 *   <li><b>ancestor_missing is one determination on both paths.</b> After the root session is
 *       physically deleted, a spawn attempt from the orphaned child is refused with
 *       {@code reason=ancestor_missing} (one {@code agent_spawn_refused} audit row), and a wake hop
 *       from the orphaned child run is refused with the same reason (one {@code wake_dispatch}
 *       {@code chain_refused} event) — both through {@link DelegationChainWalker}, neither treating
 *       the orphan as a depth-0 root.</li>
 *   <li><b>Concurrent hops from one parent run serialize.</b> Two threads firing the same chain hop
 *       meet at a {@link CyclicBarrier}; the parent run row lock makes one admit exactly one child
 *       run and the other refuse with {@code chain_refused} — the design §2.2 scenario-3 regression
 *       (two concurrent hops both passing the gate).</li>
 * </ol>
 */
class DelegationChainWalkIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private AgentSpawnExecutionService spawnService;

    @Autowired
    private SessionService sessionService;

    @Autowired
    private WakeDispatchService wakeDispatchService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private SessionParticipantRepository participantRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private McpInvocationRepository mcpInvocationRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository providerConnectionRepository;

    @Autowired
    private ApiRequestTemplateService apiRequestTemplates;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ConfigService configService;

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private SessionParticipantService participantService;

    @Autowired
    private DelegationBudgetService delegationBudgetService;

    private String userId;
    private String workspaceId;
    private UUID principalId;
    /** A second agent principal so a woken participant never collides with the session PRIMARY. */
    private UUID wokenPrincipalId;
    /** A third principal: a mention target that never appears on the walked path (T3.6). */
    private UUID restartTargetPrincipalId;

    @AfterEach
    void cleanFixtures() {
        configService.deleteKey("instance", "agent-runtime", "wakeChainMaxDepth", "test", null, null);
        if (workspaceId != null) {
            SpawnTestSupport.clearForWorkspace(mcpInvocationRepository, jdbcTemplate, workspaceId);
            // context_events carries a plain FK to sessions (no cascade): clear it first, otherwise
            // the session delete fails and masks the real assertion of the next test.
            jdbcTemplate.update("DELETE FROM context_events WHERE session_id IN "
                    + "(SELECT id FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?)", workspaceId);
            jdbcTemplate.update("DELETE FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
        }
        if (principalId != null && workspaceId != null
                && workspaceAgentRepository.existsById(
                        new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(principalId, UUID.fromString(workspaceId)))) {
            workspaceAgentRepository.deleteById(
                    new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(principalId, UUID.fromString(workspaceId)));
        }
        if (wokenPrincipalId != null && workspaceId != null
                && workspaceAgentRepository.existsById(
                        new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(wokenPrincipalId, UUID.fromString(workspaceId)))) {
            workspaceAgentRepository.deleteById(
                    new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(wokenPrincipalId, UUID.fromString(workspaceId)));
        }
        if (principalId != null) {
            agentPrincipalRepository.deleteById(principalId);
        }
        if (wokenPrincipalId != null) {
            agentPrincipalRepository.deleteById(wokenPrincipalId);
        }
        if (restartTargetPrincipalId != null && workspaceId != null
                && workspaceAgentRepository.existsById(
                        new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(restartTargetPrincipalId,
                                UUID.fromString(workspaceId)))) {
            workspaceAgentRepository.deleteById(
                    new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(restartTargetPrincipalId,
                            UUID.fromString(workspaceId)));
        }
        if (restartTargetPrincipalId != null) {
            agentPrincipalRepository.deleteById(restartTargetPrincipalId);
            restartTargetPrincipalId = null;
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
        wokenPrincipalId = null;
    }

    // ------------------------------------------------------------------ T2.8

    @Test
    void deletingTheRootSessionRefusesSpawnAndWakeEachWithOneAncestorMissingAudit() {
        ensureWorkspace();
        ParentFixture parent = spawnFixture();
        ChatSubmissionService.SpawnResult child = spawnDirect(parent);
        ChatRun childRun = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        assertNull(childRun.getParentRunId(), "spawn rows never write the wake edge (D30-01)");
        assertEquals(parent.parentRunId(), childRun.getWaitingOnRunId());

        // The ancestor disappears: session deletion cascades its runs (SessionBranchRepository).
        sessionService.delete(parent.parentSessionId(), userId, workspaceId);
        assertNull(sessionRepository.findById(UUID.fromString(parent.parentSessionId())).orElse(null));

        // --- spawn path: the orphaned child may not spawn, audited once.
        String secondToolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                child.sessionId(), child.runId(), workspaceId, userId,
                secondToolCallId, "spawn_agent", "{\"prompt\":\"orphan\"}");
        ChatSubmissionService.SpawnInvocation invocation =
                submissionService.prepareSpawnInvocation(child.runId(), secondToolCallId);
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();
        int auditsBefore = refusedAuditCount();

        DelegationRefusedException refused = assertThrows(DelegationRefusedException.class,
                () -> spawnService.execute(invocation,
                        new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null)));

        assertEquals("DELEGATION_POLICY_INVALID", refused.getCode());
        assertTrue(refused.auditDetail().contains("\"reason\":\"ancestor_missing\""),
                "the shared determination names ancestor_missing: " + refused.auditDetail());
        assertEquals(sessionsBefore, sessionCount(), "a refusal creates no child Session");
        assertEquals(runsBefore, runCount(), "a refusal creates no child ChatRun");
        assertEquals(auditsBefore + 1, refusedAuditCount(),
                "exactly one agent_spawn_refused row for the orphaned spawn");
        String spawnAudit = jdbcTemplate.queryForObject(
                "SELECT details FROM audit_logs WHERE action = 'agent_spawn_refused' "
                        + "ORDER BY created_at DESC LIMIT 1", String.class);
        assertTrue(spawnAudit.contains("ancestor_missing"), "the audit names the reason: " + spawnAudit);

        // --- wake path: the orphaned child run may not wake anyone, audited once.
        SessionParticipant participant = agentParticipant(UUID.fromString(child.sessionId()));
        String round = "wake:chain:" + child.runId() + ":" + participant.getId();
        int eventsBefore = chainRefusedEventCount(child.sessionId());
        int runsBeforeWake = runCount();

        WakeDispatchService.WakeFireResult wake = wakeDispatchService.fire(
                participant.getId(), "chain", round, UUID.fromString(child.sessionId()), child.runId());

        assertFalse(wake.dispatched(), "a broken chain never creates a wake run");
        assertEquals("chain_refused", wake.outcome());
        assertEquals(runsBeforeWake, runCount(), "no wake run for the orphaned chain");
        assertEquals(eventsBefore + 1, chainRefusedEventCount(child.sessionId()),
                "exactly one wake_dispatch chain_refused event for the orphaned wake");
        String wakeAudit = jdbcTemplate.queryForObject(
                "SELECT payload::text FROM context_events "
                        + "WHERE CAST(session_id AS VARCHAR) = ? AND event_type = 'wake_dispatch' "
                        + "ORDER BY sequence DESC LIMIT 1", String.class, child.sessionId());
        // jsonb normalizes key order and spacing in its text form — match the values, not the wire shape.
        assertTrue(wakeAudit.contains("chain_refused"), wakeAudit);
        assertTrue(wakeAudit.contains("ancestor_missing"), "the same refusal reason as the spawn path: " + wakeAudit);
    }

    // ------------------------------------------------------------------ T2.9

    @Test
    void concurrentHopsFromTheSameParentRunAdmitExactlyOneChild() throws Exception {
        ensureWorkspace();
        Session session = agentSession("chain concurrency");
        SessionParticipant participant = agentParticipant(session.getId());
        String parentRunId = saveRun(session, "succeeded");
        String round = "wake:chain:" + parentRunId + ":" + participant.getId();

        CyclicBarrier barrier = new CyclicBarrier(2);
        AtomicReference<WakeDispatchService.WakeFireResult> first = new AtomicReference<>();
        AtomicReference<WakeDispatchService.WakeFireResult> second = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread t1 = hopThread(barrier, first, failure, participant.getId(), round,
                session.getId(), parentRunId);
        Thread t2 = hopThread(barrier, second, failure, participant.getId(), round,
                session.getId(), parentRunId);
        t1.start();
        t2.start();
        t1.join(30_000);
        t2.join(30_000);
        assertFalse(t1.isAlive() || t2.isAlive(), "both hops must settle");
        assertNull(failure.get(), "no hop threw: " + failure.get());
        assertNotNull(first.get());
        assertNotNull(second.get());

        assertTrue(first.get().dispatched() != second.get().dispatched(),
                "exactly one of the two concurrent hops is admitted");
        WakeDispatchService.WakeFireResult refused =
                first.get().dispatched() ? second.get() : first.get();
        assertEquals("chain_refused", refused.outcome(),
                "the serialized second hop is refused, not silently replayed");

        Integer children = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_runs WHERE parent_run_id = ?",
                Integer.class, UUID.fromString(parentRunId));
        assertEquals(1, children, "the double-admission created exactly one child run");

        String childRunId = jdbcTemplate.queryForObject(
                "SELECT id FROM chat_runs WHERE parent_run_id = ?",
                String.class, UUID.fromString(parentRunId));
        ChatRun child = chatRunRepository.findById(UUID.fromString(childRunId)).orElseThrow();
        assertEquals(parentRunId, child.getParentRunId(), "the durable wake edge is stamped");
        assertEquals(participant.getPrincipalId(), child.getAgentPrincipalId(),
                "the responder stamped on the run is the answering principal (V92 R1 FK)");
        assertEquals("chain", child.getTriggerSource());
        assertEquals(1, chainRefusedEventCount(session.getId().toString()),
                "exactly one chain_refused audit for the refused twin hop");
    }

    private Thread hopThread(CyclicBarrier barrier,
                             AtomicReference<WakeDispatchService.WakeFireResult> sink,
                             AtomicReference<Throwable> failure, UUID participantId, String round,
                             UUID sessionId, String parentRunId) {
        return new Thread(() -> {
            try {
                barrier.await(30, TimeUnit.SECONDS);
                sink.set(wakeDispatchService.fire(participantId, "chain", round, sessionId, parentRunId));
            } catch (Throwable t) {
                failure.set(t);
            }
        });
    }

    // ------------------------------------------------------------------ T3.6

    /**
     * T3.6 (design §2.2 scenario 1): restart equivalence. The deleted {@code WakeChainRegistry} was
     * the ONLY instance state, so a brand-new {@link WakeChainService} over the same beans and the
     * same database is exactly what a fresh {@code ApplicationContext} wires after a CP restart.
     * The durable depth walk means the new instance refuses the hop the old chain would have
     * refused — the depth never resets to "unknown run = depth 1".
     */
    @Test
    void aFreshServiceInstanceContinuesTheChainWithoutResettingDepth() {
        ensureWorkspace();
        Session session = agentSession("restart equivalence");
        SessionParticipant bee = agentParticipant(session.getId());
        restartTargetPrincipalId = extraPrincipal("Restartcee");
        // order 30: next to the session PRIMARY (10) and the woken participant (20).
        participantRepository.saveAndFlush(new SessionParticipant(session.getId(), "AGENT",
                restartTargetPrincipalId, "MEMBER", 30, "MENTION", "ALWAYS"));
        String rootRunId = saveRun(session, "succeeded");

        WakeDispatchService.WakeFireResult first = wakeDispatchService.fire(bee.getId(), "chain",
                "wake:chain:" + rootRunId + ":" + bee.getId(), session.getId(), rootRunId);
        assertTrue(first.dispatched(), "the depth-1 link commits durably before the 'restart'");

        // Tighten the wake ceiling to 1 AFTER the depth-1 link exists: the next hop would be depth 2.
        configService.putLayer("instance", "agent-runtime",
                Map.of("wakeChainMaxDepth", "1"), "test", null, null);
        try {
            WakeChainService restarted = new WakeChainService(sessionRepository, participantService,
                    wakeDispatchService, eventStoreService, configService, objectMapper,
                    chatRunRepository, delegationBudgetService);

            int runsBefore = runCount();
            restarted.onAssistantContent(session.getId().toString(), first.runId().toString(),
                    "@Restartcee 请继续");

            assertEquals(runsBefore, runCount(),
                    "a restarted instance must not reset the depth and re-admit the hop");
            String payload = jdbcTemplate.queryForObject(
                    "SELECT payload::text FROM context_events "
                            + "WHERE CAST(session_id AS VARCHAR) = ? AND event_type = 'wake_dispatch' "
                            + "ORDER BY sequence DESC LIMIT 1", String.class, session.getId().toString());
            assertTrue(payload.contains("chain_refused"), payload);
            assertTrue(payload.contains("depth_exceeded"),
                    "the durable walk still sees depth 2 after the restart: " + payload);
            // jsonb normalizes spacing in its text form — match the values, not the wire shape.
            assertTrue(payload.contains("\"rootRunId\": \"" + rootRunId + "\""),
                    "the walked root survives the restart: " + payload);
        } finally {
            configService.deleteKey("instance", "agent-runtime", "wakeChainMaxDepth", "test", null, null);
        }
    }

    /** A workspace-bound agent principal with a single-token name so {@code @Name} parses. */
    private UUID extraPrincipal(String name) {
        AgentPrincipal extra = new AgentPrincipal();
        extra.setName(name);
        extra.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        extra.setTemplateSnapshot(snapshot);
        extra = agentPrincipalRepository.saveAndFlush(extra);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(extra.getId().toString(), workspaceId,
                objectMapper.createArrayNode()));
        return extra.getId();
    }

    // ------------------------------------------------------------------ fixtures

    private record ParentFixture(String parentSessionId, String parentRunId, String toolCallId) {}

    /** Root session + active parent run + seeded spawn tool call — the budget IT fixture, reused. */
    private ParentFixture spawnFixture() {
        Session parentSession = agentSession("delegation chain parent");
        String parentRunId = saveRun(parentSession, "running");
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parentSession.getId().toString(), parentRunId, workspaceId, userId,
                toolCallId, "spawn_agent", "{\"prompt\":\"chain\"}");
        return new ParentFixture(parentSession.getId().toString(), parentRunId, toolCallId);
    }

    private ChatSubmissionService.SpawnResult spawnDirect(ParentFixture parent) {
        ChatSubmissionService.SpawnInvocation invocation =
                submissionService.prepareSpawnInvocation(parent.parentRunId(), parent.toolCallId());
        return spawnService.execute(invocation,
                new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null));
    }

    private Session agentSession(String title) {
        Session session = new Session(workspaceId, userId,
                title + " " + UUID.randomUUID().toString().substring(0, 8));
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(principalId.toString());
        session.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        ChatBindingTestSupport.bindNewChatConnection(session, providerConnectionRepository,
                apiRequestTemplates, userId);
        return sessionRepository.saveAndFlush(session);
    }

    private SessionParticipant agentParticipant(UUID sessionId) {
        // order 20: the spawn child already owns its PRIMARY at order 10 (PRIMARY_ORDER_INDEX).
        SessionParticipant participant = new SessionParticipant(sessionId, "AGENT", wokenPrincipalId,
                "MEMBER", 20, "MENTION", "ALWAYS");
        return participantRepository.saveAndFlush(participant);
    }

    private String saveRun(Session session, String status) {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                runId, session.getId().toString(), userId, workspaceId,
                "delegation-chain-run-" + runId, "delegation-chain-hash-" + runId,
                "provider", "model", "workspace", status));
        return runId;
    }

    private void ensureWorkspace() {
        if (userId != null) {
            return;
        }
        User user = userRepository.save(new User("delegation-chain-" + UUID.randomUUID() + "@test.com",
                "hash", "Delegation chain test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Delegation chain test", userId);
        workspaceId = workspace.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId,
                com.cc01cc.p.xihe.cp.entity.WorkspaceRole.OWNER);
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Delegation chain principal");
        principal.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId,
                objectMapper.createArrayNode()));
        AgentPrincipal woken = new AgentPrincipal();
        woken.setName("Delegation chain woken principal");
        woken.setCreatedByUserId(userId);
        var wokenSnapshot = objectMapper.createObjectNode();
        wokenSnapshot.set("permissions", objectMapper.createArrayNode());
        woken.setTemplateSnapshot(wokenSnapshot);
        woken = agentPrincipalRepository.saveAndFlush(woken);
        wokenPrincipalId = woken.getId();
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(wokenPrincipalId.toString(), workspaceId,
                objectMapper.createArrayNode()));
    }

    private int sessionCount() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?",
                Integer.class, workspaceId);
    }

    private int runCount() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_runs WHERE CAST(workspace_id AS VARCHAR) = ?",
                Integer.class, workspaceId);
    }

    private int refusedAuditCount() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_spawn_refused'", Integer.class);
    }

    private int chainRefusedEventCount(String sessionId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM context_events WHERE CAST(session_id AS VARCHAR) = ? "
                        + "AND event_type = 'wake_dispatch' AND payload::text LIKE '%chain_refused%'",
                Integer.class, sessionId);
    }
}
