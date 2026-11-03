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
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
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
 * PLAN-0630 T5.8 (design D30-10): timeout does NOT propagate along the spawn edge.
 *
 * <p>Cancellation propagates along spawn (no fork); a parent run reaching its timeout terminal
 * state must leave every spawned child session's run untouched. Two things are pinned here on
 * the real PostgreSQL paths, with the {@link DelegationChainWalkIntegrationTest} fixture:
 * <ol>
 *   <li><b>Timeout non-propagation.</b> The parent run converges through the real relay-timeout
 *       terminal write ({@code AGENT_TIMEOUT} → {@code ambiguous}, the exact path of
 *       {@code ChatController}'s {@code HttpTimeoutException} handler) and the spawned child run
 *       stays in flight — same status, waiting link intact, no terminal write, session alive.</li>
 *   <li><b>Cancel propagation is still alive (the contrast).</b> An explicit
 *       {@link ChatRunCancellationService#cancelSerialized} on the same parent shape chain-cancels
 *       the child run — proving the child edge IS reachable by propagation and only the timeout
 *       terminal is exempt.</li>
 * </ol>
 */
class DelegationTimeoutPropagationIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private ChatRunCancellationService cancellationService;

    @Autowired
    private ChatRunTerminalService terminalService;

    @Autowired
    private SessionRepository sessionRepository;

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

    private String userId;
    private String workspaceId;
    private UUID principalId;

    @AfterEach
    void cleanFixtures() {
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
                        new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(principalId,
                                UUID.fromString(workspaceId)))) {
            workspaceAgentRepository.deleteById(
                    new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(principalId,
                            UUID.fromString(workspaceId)));
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

    // ------------------------------------------------------------------ T5.8a

    @Test
    void parentRunTimeoutLeavesSpawnedChildRunInFlight() {
        ensureWorkspace();
        ParentFixture parent = spawnFixture();
        ChatSubmissionService.SpawnResult child = spawnDirect(parent);
        // Fixture: the spawned child has progressed to an actively running state. A status
        // fixture write is enough — the propagation pin is about what the parent terminal
        // does NOT touch, not about how the child got here.
        ChatRun childRun = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        childRun.setStatus("running");
        chatRunRepository.saveAndFlush(childRun);
        assertEquals(parent.parentRunId(), childRun.getWaitingOnRunId());

        // The real relay-timeout terminal: AGENT_TIMEOUT → ambiguous (ChatController's
        // HttpTimeoutException path). This is a plain terminal write on the parent run row —
        // design D30-10 says it must NOT fan a cancellation into the spawn subtree.
        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                new ChatRunTerminalService.TerminalRequest(
                        parent.parentRunId(),
                        ChatRunRepository.ACTIVE_LEASE_STATUSES,
                        "ambiguous", "ambiguous", "AGENT_TIMEOUT",
                        "Agent request timed out after 30 seconds",
                        0, 0, ChatRunTerminalService.TerminalSource.STREAM, null));
        assertTrue(result.committed(), "the parent run must commit its timeout terminal: " + result);
        assertEquals("ambiguous", runStatus(parent.parentRunId()));

        ChatRun childAfter = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        assertEquals("running", childAfter.getStatus(),
                "the parent timeout terminal must not propagate a cancel into the spawned child run "
                        + "(design D30-10: timeout does not propagate)");
        assertNull(childAfter.getTerminalAt(), "no terminal write reached the child run");
        assertEquals(parent.parentRunId(), childAfter.getWaitingOnRunId(),
                "the child's waiting link survives untouched — nothing settled or claimed it");
        assertTrue(sessionRepository.findById(UUID.fromString(child.sessionId())).isPresent(),
                "timeout never deletes or disturbs the child session");
    }

    // ------------------------------------------------------------------ T5.8b

    /**
     * The contrast pin: the identical fixture, cancelled explicitly, still chain-cancels the
     * spawn child. The timeout exemption above is therefore a real propagation difference, not
     * a dead edge — the spawn subtree IS reachable by propagation.
     */
    @Test
    void explicitParentCancelStillPropagatesToSpawnedChildRun() {
        ensureWorkspace();
        ParentFixture parent = spawnFixture();
        ChatSubmissionService.SpawnResult child = spawnDirect(parent);
        ChatRun childRun = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        childRun.setStatus("running");
        chatRunRepository.saveAndFlush(childRun);

        ChatRunCancellationService.CancelClaim claim = cancellationService.cancelSerialized(
                parent.parentRunId(), parent.parentSessionId, userId, workspaceId, "user_request");

        assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED, claim.outcome());
        assertEquals("cancelled", runStatus(parent.parentRunId()), "the stopped root reaches terminal");
        assertEquals("cancelled", runStatus(child.runId()),
                "explicit cancel still chain-cancels the active spawn child (D30-10 contrast)");
        assertTrue(sessionRepository.findById(UUID.fromString(child.sessionId())).isPresent(),
                "cancel never deletes sessions");
    }

    // ------------------------------------------------------------------ fixtures

    private record ParentFixture(String parentSessionId, String parentRunId, String toolCallId) {}

    /** Root agent session + active parent run + seeded spawn tool call — the chain-walk fixture. */
    private ParentFixture spawnFixture() {
        Session parentSession = new Session(workspaceId, userId,
                "delegation timeout parent " + UUID.randomUUID().toString().substring(0, 8));
        parentSession.setId(UUID.randomUUID());
        parentSession.setAgentPrincipalId(principalId.toString());
        parentSession.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        ChatBindingTestSupport.bindNewChatConnection(parentSession, providerConnectionRepository,
                apiRequestTemplates, userId);
        sessionRepository.saveAndFlush(parentSession);
        String parentRunId = saveRun(parentSession, "running");
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parentSession.getId().toString(), parentRunId, workspaceId, userId,
                toolCallId, "spawn_agent", "{\"prompt\":\"timeout\"}");
        return new ParentFixture(parentSession.getId().toString(), parentRunId, toolCallId);
    }

    /**
     * Durable spawn edge only — same reason as {@link ForkPropagationTest}: the suite pins
     * propagation semantics, so the child run must stay exactly where the fixture put it.
     * {@code AgentSpawnExecutionService.execute} would also dispatch a live chat relay thread,
     * whose Agent-unreachable failure could terminalize the child and race the assertions.
     */
    private ChatSubmissionService.SpawnResult spawnDirect(ParentFixture parent) {
        ChatSubmissionService.SpawnInvocation invocation =
                submissionService.prepareSpawnInvocation(parent.parentRunId(), parent.toolCallId());
        return submissionService.createSpawnFromParent(parent.parentRunId(), parent.toolCallId,
                new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null));
    }

    private String saveRun(Session session, String status) {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                runId, session.getId().toString(), userId, workspaceId,
                "delegation-timeout-run-" + runId, "delegation-timeout-hash-" + runId,
                "provider", "model", "workspace", status));
        return runId;
    }

    private void ensureWorkspace() {
        if (userId != null) {
            return;
        }
        User user = userRepository.save(new User("delegation-timeout-" + UUID.randomUUID() + "@test.com",
                "hash", "Delegation timeout test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Delegation timeout test", userId);
        workspaceId = workspace.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId,
                com.cc01cc.p.xihe.cp.entity.WorkspaceRole.OWNER);
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Delegation timeout principal");
        principal.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId,
                objectMapper.createArrayNode()));
    }

    private String runStatus(String runId) {
        return chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getStatus();
    }
}
