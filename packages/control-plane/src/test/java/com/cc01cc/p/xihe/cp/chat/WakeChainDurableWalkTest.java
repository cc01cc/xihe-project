package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.config.ConfigService;
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
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.support.TestWorkspaceCleanup;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0630 M2 (T2.6): the durable wake edge lands on the run row — real PostgreSQL, real
 * submission state machine.
 *
 * <p>The column contract per trigger source: a {@code chain}/{@code judge} wake run remembers which
 * run woke it ({@code parent_run_id} = the causal parent, written in the same transaction as the run
 * row); a {@code schedule}/user run stays a root (NULL); a {@code spawn} row never writes the wake
 * edge — its parent already lives on {@code waiting_on_run_id}, and writing both would be a second
 * source of truth (D30-01). M3 extends this class with the durable depth walk; the column pins are
 * its fixture.</p>
 */
class WakeChainDurableWalkTest extends AbstractReusableIntegrationTest {

    @Autowired
    private SessionWakeupService sessionWakeupService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

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
    private WakeChainService wakeChainService;

    @Autowired
    private WakeDispatchService wakeDispatchService;

    @Autowired
    private SessionParticipantRepository participantRepository;

    @Autowired
    private ConfigService configService;

    private String userId;
    private String workspaceId;
    private UUID principalId;
    /** Extra principals this test class creates (mention targets) — cleaned up with the fixture. */
    private final List<UUID> extraPrincipalIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        configService.deleteKey("instance", "agent-runtime", "wakeChainMaxDepth", "test", null, null);
        configService.deleteKey("instance", "agent-runtime", "delegationMaxDepthCeiling", "test", null, null);
        if (workspaceId != null) {
            // context_events carries a plain FK to sessions (no cascade): clear it first.
            jdbcTemplate.update("DELETE FROM context_events WHERE session_id IN "
                    + "(SELECT id FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?)", workspaceId);
            TestWorkspaceCleanup.deleteWorkspaceData(jdbcTemplate, workspaceId);
        }
        // After the session delete: woken runs reference the extra principals via the
        // chat_runs.agent_principal_id FK, and the session cascade removes those runs first.
        for (UUID extra : extraPrincipalIds) {
            if (workspaceId != null && workspaceAgentRepository.existsById(
                    new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(extra, UUID.fromString(workspaceId)))) {
                workspaceAgentRepository.deleteById(
                        new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(extra, UUID.fromString(workspaceId)));
            }
            agentPrincipalRepository.deleteById(extra);
        }
        extraPrincipalIds.clear();
        if (principalId != null && workspaceId != null
                && workspaceAgentRepository.existsById(
                        new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(principalId, UUID.fromString(workspaceId)))) {
            workspaceAgentRepository.deleteById(
                    new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(principalId, UUID.fromString(workspaceId)));
        }
        if (principalId != null) {
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

    @Test
    void chainTriggeredRunWritesParentRunId() {
        ensureWorkspace();
        Session session = newSession("chain wake");
        String parentRunId = saveRun(session, "succeeded");

        SessionWakeupService.WakeupResult result = sessionWakeupService.wakeupAs(
                session.getId().toString(), userId, workspaceId, "[chain wake] respond",
                "wake-chain-" + UUID.randomUUID(), principalId, "chain",
                UUID.fromString(parentRunId));

        assertTrue(result.started());
        ChatRun run = chatRunRepository.findById(result.runId()).orElseThrow();
        assertEquals(parentRunId, run.getParentRunId(),
                "chain wake: the durable edge points at the run that woke this one");
        assertEquals("chain", run.getTriggerSource());
    }

    @Test
    void judgeTriggeredRunWritesParentRunId() {
        ensureWorkspace();
        Session session = newSession("judge wake");
        String parentRunId = saveRun(session, "succeeded");

        SessionWakeupService.WakeupResult result = sessionWakeupService.wakeupAs(
                session.getId().toString(), userId, workspaceId, "[judge wake] respond",
                "wake-judge-" + UUID.randomUUID(), principalId, "judge",
                UUID.fromString(parentRunId));

        assertTrue(result.started());
        ChatRun run = chatRunRepository.findById(result.runId()).orElseThrow();
        assertEquals(parentRunId, run.getParentRunId(),
                "judge wake: same causal edge as chain (design §4: {chain, judge} both write it)");
        assertEquals("judge", run.getTriggerSource());
    }

    @Test
    void scheduleTriggeredRunStaysARoot() {
        ensureWorkspace();
        Session session = newSession("schedule wake");

        SessionWakeupService.WakeupResult result = sessionWakeupService.wakeupAs(
                session.getId().toString(), userId, workspaceId, "[schedule wake] respond",
                "wake-schedule-" + UUID.randomUUID(), principalId, "schedule", null);

        assertTrue(result.started());
        ChatRun run = chatRunRepository.findById(result.runId()).orElseThrow();
        assertNull(run.getParentRunId(), "schedule wake: NULL = root (design §4)");
        assertEquals("schedule", run.getTriggerSource());
    }

    @Test
    void userSubmissionStaysARoot() {
        ensureWorkspace();
        Session session = newSession("user root");

        String userRunId = saveRun(session, "running");

        ChatRun run = chatRunRepository.findById(UUID.fromString(userRunId)).orElseThrow();
        assertNull(run.getParentRunId(), "user run: NULL = root");
        assertEquals("user", run.getTriggerSource());
        assertEquals(ChatRun.ORIGIN_USER_SUBMISSION, run.getOrigin());
    }

    @Test
    void spawnRowKeepsParentRunIdNullAndWaitingLink() {
        ensureWorkspace();
        Session session = newSession("spawn carrier");
        String parentRunId = saveRun(session, "succeeded");
        ChatRun spawnRun = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        spawnRun.setOrigin(ChatRun.ORIGIN_SPAWN);
        spawnRun.setWaitingOnRunId(parentRunId);
        chatRunRepository.saveAndFlush(spawnRun);

        ChatRun reloaded = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        assertNull(reloaded.getParentRunId(),
                "spawn rows never write the wake edge — the parent fact lives on waiting_on_run_id (D30-01)");
        assertEquals(parentRunId, reloaded.getWaitingOnRunId());
    }

    // ------------------------------------------------------------------ M3 (T3.4) two readings, two ceilings

    /**
     * T3.4 wake-only reading: with {@code wakeChainMaxDepth=1} the hop out of a depth-1 run refuses
     * with {@code depth_exceeded} and creates no run — spawn depth 0 is inside the delegation
     * ceiling, so this refusal is purely the wake chain's own gate.
     */
    @Test
    void wakeDepthExceededRefusesTheNextLinkWithOneAudit() {
        ensureWorkspace();
        Session session = newSession("wake depth walk");
        SessionParticipant bee = agentParticipant(session, extraPrincipal("Wkbee"), 20);
        SessionParticipant cee = agentParticipant(session, extraPrincipal("Wkcee"), 21);
        String rootRunId = saveRun(session, "succeeded");

        WakeDispatchService.WakeFireResult first = wakeDispatchService.fire(bee.getId(), "chain",
                "wake:chain:" + rootRunId + ":" + bee.getId(), session.getId(), rootRunId);
        assertTrue(first.dispatched(), "the depth-1 hop is admitted before the ceiling tightens");

        configService.putLayer("instance", "agent-runtime",
                Map.of("wakeChainMaxDepth", "1"), "test", null, null);
        int runsBefore = runCount();
        int eventsBefore = chainRefusedEventCount(session.getId().toString());

        wakeChainService.onAssistantContent(session.getId().toString(), first.runId().toString(),
                "@Wkcee 请继续");

        assertEquals(runsBefore, runCount(), "a refused wake hop never creates a run");
        assertEquals(eventsBefore + 1, chainRefusedEventCount(session.getId().toString()),
                "exactly one chain_refused audit for the depth refusal");
        String payload = lastWakeDispatchPayload(session.getId().toString());
        assertTrue(payload.contains("depth_exceeded"), payload);
        // jsonb normalizes spacing in its text form — match the values, not the wire shape.
        assertTrue(payload.contains("\"wakeDepth\": 2"), "the walked depth rides the audit: " + payload);
        assertTrue(payload.contains("\"parentRunId\": \"" + first.runId() + "\""),
                "the durable parent rides the same wake_dispatch event: " + payload);
    }

    /**
     * T3.4 spawn-only reading: a run inside a two-spawn-deep session wakes at wakeDepth 3 (inside
     * the default wake ceiling) but spawnDepth 2; with {@code delegationMaxDepthCeiling=1} the SAME
     * effective limit the spawn gate enforces refuses with {@code delegation_limit_exceeded}.
     */
    @Test
    void spawnDepthExceededRefusesWithTheDelegationLimitReason() {
        ensureWorkspace();
        Session root = newSession("spawn ceiling root");
        String r1 = saveRun(root, "succeeded");
        Session s2 = spawnSessionOf(root, "spawn ceiling s2", UUID.fromString(r1));
        String r2 = saveRun(s2, "running");
        linkSpawnRun(r2, r1);
        Session s3 = spawnSessionOf(s2, "spawn ceiling s3", UUID.fromString(r2));
        String r3 = saveRun(s3, "running");
        linkSpawnRun(r3, r2);
        agentParticipant(s3, extraPrincipal("Wkbee"), 20);

        configService.putLayer("instance", "agent-runtime",
                Map.of("delegationMaxDepthCeiling", "1"), "test", null, null);
        int runsBefore = runCount();

        wakeChainService.onAssistantContent(s3.getId().toString(), r3, "@Wkbee 请继续");

        assertEquals(runsBefore, runCount(), "a refused wake hop never creates a run");
        String payload = lastWakeDispatchPayload(s3.getId().toString());
        assertTrue(payload.contains("delegation_limit_exceeded"),
                "the spawn-depth refusal names the delegation limit: " + payload);
        assertTrue(payload.contains("\"spawnDepth\": 2"),
                "the walked spawn depth rides the audit: " + payload);
        assertFalse(payload.contains("depth_exceeded"),
                "the wake ceiling (3) is not touched — only the spawn reading refuses: " + payload);
    }

    /** T3.4 priority: both readings over their ceilings refuse with the wake-depth reason first. */
    @Test
    void bothCeilingsBreachedWakeDepthReasonWins() {
        ensureWorkspace();
        Session root = newSession("spawn ceiling root");
        String r1 = saveRun(root, "succeeded");
        Session s2 = spawnSessionOf(root, "spawn ceiling s2", UUID.fromString(r1));
        String r2 = saveRun(s2, "running");
        linkSpawnRun(r2, r1);
        Session s3 = spawnSessionOf(s2, "spawn ceiling s3", UUID.fromString(r2));
        String r3 = saveRun(s3, "running");
        linkSpawnRun(r3, r2);
        agentParticipant(s3, extraPrincipal("Wkbee"), 20);

        configService.putLayer("instance", "agent-runtime",
                Map.of("wakeChainMaxDepth", "2", "delegationMaxDepthCeiling", "1"), "test", null, null);
        int runsBefore = runCount();

        wakeChainService.onAssistantContent(s3.getId().toString(), r3, "@Wkbee 请继续");

        assertEquals(runsBefore, runCount(), "a refused wake hop never creates a run");
        String payload = lastWakeDispatchPayload(s3.getId().toString());
        assertTrue(payload.contains("depth_exceeded"), payload);
        assertFalse(payload.contains("delegation_limit_exceeded"),
                "the chain's own ceiling is consulted first (wakeDepth 3 > 2): " + payload);
    }

    // ------------------------------------------------------------------ fixtures

    private void ensureWorkspace() {
        if (userId != null) {
            return;
        }
        User user = userRepository.save(new User("wake-chain-durable-" + UUID.randomUUID() + "@test.com",
                "hash", "Wake chain durable test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Wake chain durable test", userId);
        workspaceId = workspace.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId,
                com.cc01cc.p.xihe.cp.entity.WorkspaceRole.OWNER);
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Wake chain durable principal");
        principal.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId,
                objectMapper.createArrayNode()));
    }

    /** A bound agent session the scheduled-wakeup admission path accepts. */
    private Session newSession(String title) {
        Session session = new Session(workspaceId, userId, title + " " + UUID.randomUUID());
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        ChatBindingTestSupport.bindNewChatConnection(session, providerConnectionRepository,
                apiRequestTemplates, userId);
        Session saved = sessionRepository.saveAndFlush(session);
        bindPrimaryParticipant(saved.getId().toString(), principalId.toString());
        return saved;
    }

    /** A spawn child session: same principal as the parent (design §5.1), V40 provenance set. */
    private Session spawnSessionOf(Session parent, String title, UUID spawnedFromRunId) {
        Session session = new Session(workspaceId, userId, title + " " + UUID.randomUUID());
        session.setId(UUID.randomUUID());
        session.setKind(Session.KIND_SPAWN);
        session.setSpawnedFromSessionId(parent.getId());
        session.setSpawnedFromRunId(spawnedFromRunId);
        session.setSpawnedAt(java.time.Instant.now());
        session.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        ChatBindingTestSupport.bindNewChatConnection(session, providerConnectionRepository,
                apiRequestTemplates, userId);
        Session saved = sessionRepository.saveAndFlush(session);
        bindPrimaryParticipant(saved.getId().toString(), principalId.toString());
        return saved;
    }

    /** Turns a plain saved run into a spawn row: parent on the waiting link, never parent_run_id. */
    private void linkSpawnRun(String runId, String parentRunId) {
        ChatRun run = chatRunRepository.findById(UUID.fromString(runId)).orElseThrow();
        run.setOrigin(ChatRun.ORIGIN_SPAWN);
        run.setWaitingOnRunId(parentRunId);
        chatRunRepository.saveAndFlush(run);
    }

    /** An agent participant whose display name is the principal name (single token, mentionable). */
    private SessionParticipant agentParticipant(Session session, UUID participantPrincipalId, int order) {
        return participantRepository.saveAndFlush(new SessionParticipant(session.getId(), "AGENT",
                participantPrincipalId, "MEMBER", order, "MENTION", "ALWAYS"));
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
        extraPrincipalIds.add(extra.getId());
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(extra.getId().toString(), workspaceId,
                objectMapper.createArrayNode()));
        return extra.getId();
    }

    private int runCount() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_runs WHERE CAST(workspace_id AS VARCHAR) = ?",
                Integer.class, workspaceId);
    }

    private int chainRefusedEventCount(String sessionId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM context_events WHERE CAST(session_id AS VARCHAR) = ? "
                        + "AND event_type = 'wake_dispatch' AND payload::text LIKE '%chain_refused%'",
                Integer.class, sessionId);
    }

    private String lastWakeDispatchPayload(String sessionId) {
        return jdbcTemplate.queryForObject(
                "SELECT payload::text FROM context_events "
                        + "WHERE CAST(session_id AS VARCHAR) = ? AND event_type = 'wake_dispatch' "
                        + "ORDER BY sequence DESC LIMIT 1", String.class, sessionId);
    }

    private String saveRun(Session session, String status) {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                runId, session.getId().toString(), userId, workspaceId,
                "wake-chain-run-" + runId, "wake-chain-hash-" + runId,
                "provider", "model", "workspace", status));
        jdbcTemplate.update("UPDATE chat_runs SET agent_principal_id = CAST(? AS UUID) WHERE id = CAST(? AS UUID)", principalId.toString(), runId);
        return runId;
    }
}
