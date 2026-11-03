package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
class WakeChainDurableWalkTest extends AbstractIntegrationTest {

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

    private String userId;
    private String workspaceId;
    private UUID principalId;

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null) {
            // context_events carries a plain FK to sessions (no cascade): clear it first.
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
        session.setAgentPrincipalId(principalId.toString());
        session.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        ChatBindingTestSupport.bindNewChatConnection(session, providerConnectionRepository,
                apiRequestTemplates, userId);
        return sessionRepository.saveAndFlush(session);
    }

    private String saveRun(Session session, String status) {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                runId, session.getId().toString(), userId, workspaceId,
                "wake-chain-run-" + runId, "wake-chain-hash-" + runId,
                "provider", "model", "workspace", status));
        return runId;
    }
}
