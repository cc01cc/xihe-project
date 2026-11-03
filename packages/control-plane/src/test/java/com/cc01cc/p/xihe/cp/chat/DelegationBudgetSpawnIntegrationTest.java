package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.PolicyRevision;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
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

import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0630 M1: the delegation budget gate on the real spawn path (real PostgreSQL).
 *
 * <p>Three things can only be proven here, not in a unit test:</p>
 * <ol>
 *   <li><b>INV-8</b> — a replay of the same {@code toolCallId} returns the existing child <em>even
 *       when the budget is full</em>. This is the pin for the gate's position: moving it before the
 *       idempotency replay would refuse retries, and the analysis that put it there would be worth
 *       nothing without an assertion.</li>
 *   <li><b>INV-1/INV-7</b> — a refusal writes no Session, no ChatRun and no participant row, and the
 *       single {@code agent_spawn_refused} audit row survives the rolled-back business transaction
 *       (it is written outside it). The second half is exactly what a restored
 *       {@code @Transactional(readOnly = true)} on the reader would silently break.</li>
 *   <li><b>No transaction poisoning</b> — the gate reads the policy <em>inside</em> the spawn
 *       transaction; after a refusal the next spawn on the same parent must still commit. If the read
 *       were wrapped in a participating readOnly transaction that throws, the parent transaction would
 *       be marked rollback-only and the next spawn would die with
 *       {@code Transaction silently rolled back}.</li>
 * </ol>
 */
class DelegationBudgetSpawnIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private AgentSpawnExecutionService spawnService;

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

    @Autowired
    private ApprovalService approvalService;

    @Autowired
    private ChatApprovalRepository approvalRepository;

    @Autowired
    private PolicyRevision policyRevision;

    private String userId;
    private String workspaceId;
    private UUID principalId;

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null) {
            SpawnTestSupport.clearForWorkspace(mcpInvocationRepository, jdbcTemplate, workspaceId);
            // context_events carries a plain FK to sessions (no cascade): clear it first, otherwise the
            // session delete fails and the failure masks the real assertion of the next test.
            jdbcTemplate.update("DELETE FROM context_events WHERE session_id IN "
                    + "(SELECT id FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?)", workspaceId);
            jdbcTemplate.update("DELETE FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
        }
        if (principalId != null && workspaceId != null
                && workspaceAgentRepository.existsById(
                        new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)))) {
            workspaceAgentRepository.deleteById(new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)));
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

    // --------------------------------------------------------------- INV-8 pin

    @Test
    void replayOfTheSameToolCallWinsEvenWhenTheBudgetIsFull() {
        limitTo("{\"maxCount\":1,\"maxDepth\":3}");
        ParentFixture parent = fixture();

        ChatSubmissionService.SpawnResult first = spawnDirect(parent);
        assertTrue(sessionCount() >= 2, "the first spawn commits its child Session");

        // The child is in flight, so the tree is at maxCount. The retry of the SAME tool call must still
        // return that child: the gate is behind the replay, by design.
        ChatSubmissionService.SpawnResult replay = spawnDirect(parent);
        assertEquals(first.runId(), replay.runId(), "a retry must replay the existing child run");
        assertEquals(first.sessionId(), replay.sessionId(), "and the existing child session");
    }

    // ------------------------------------------- V3: a refusal never burns a grant

    /**
     * PLAN-0630 verify V3 (顺序不变式, second half): the budget gate sits <b>before</b>
     * {@code consumeApprovedGrant}, so a refusal must not burn the user's one-shot approval. The test
     * is built so it goes red if {@code requireWithinBudget} is moved after the consume call: the
     * grant is a genuinely consumable manual-mode one-shot for exactly this invocation (proven at the
     * end), and the refusal is a pure budget refusal ({@code count_exceeded}).
     */
    @Test
    void aBudgetRefusalDoesNotConsumeTheOneShotApproval() {
        limitTo("{\"maxCount\":1,\"maxDepth\":3}");
        ParentFixture parent = fixture();
        spawnDirect(parent); // fills the single slot: the tree is at maxCount

        String secondToolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parent.parentSessionId(), parent.parentRunId(), workspaceId, userId,
                secondToolCallId, "spawn_agent", "{\"prompt\":\"approval\"}");
        UUID grantId = oneShotSpawnGrant(parent, "{\"prompt\":\"approval\"}");
        ChatSubmissionService.SpawnInvocation invocation =
                submissionService.prepareSpawnInvocation(parent.parentRunId(), secondToolCallId);
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();

        DelegationRefusedException refused = assertThrows(DelegationRefusedException.class,
                () -> spawnService.execute(invocation,
                        new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(),
                                grantId.toString(), null)));

        assertEquals("DELEGATION_LIMIT_EXCEEDED", refused.getCode());
        assertTrue(refused.auditDetail().contains("\"reason\":\"count_exceeded\""),
                refused.auditDetail());
        assertEquals(sessionsBefore, sessionCount(), "a refusal creates no child Session");
        assertEquals(runsBefore, runCount(), "a refusal creates no child ChatRun");
        assertNull(grantConsumedAt(grantId),
                "the budget gate is BEFORE consumeApprovedGrant: a refusal must never burn the grant");
        // The NULL above only proves the ordering if the grant was consumable at all — consume it now.
        assertTrue(approvalService.consumeApprovedGrant(grantId.toString(), userId, workspaceId,
                        parent.parentSessionId(), ChatSubmissionService.SPAWN_TOOL_NAME,
                        invocation.authorizationBody()),
                "the refused attempt left the one-shot grant untouched and still usable");
    }

    // ------------------------------------------------- INV-1 + INV-7 (audit)

    @Test
    void refusedSpawnWritesNothingButOneDurableAuditRow() {
        limitTo("{\"maxCount\":1,\"maxDepth\":3}");
        ParentFixture parent = fixture();
        spawnDirect(parent); // fills the single slot

        String secondToolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parent.parentSessionId(), parent.parentRunId(), workspaceId, userId,
                secondToolCallId, "spawn_agent", "{\"prompt\":\"refused\"}");
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();
        int refusedAuditsBefore = refusedAuditCount();

        ChatSubmissionService.SpawnInvocation invocation =
                submissionService.prepareSpawnInvocation(parent.parentRunId(), secondToolCallId);
        DelegationRefusedException refused = assertThrows(DelegationRefusedException.class,
                () -> spawnService.execute(invocation,
                        new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null)));

        assertEquals("DELEGATION_LIMIT_EXCEEDED", refused.getCode());
        assertTrue(refused.auditDetail().contains("\"reason\":\"count_exceeded\""), refused.auditDetail());
        assertEquals(sessionsBefore, sessionCount(), "a refusal creates no child Session");
        assertEquals(runsBefore, runCount(), "a refusal creates no child ChatRun");
        assertEquals(refusedAuditsBefore + 1, refusedAuditCount(),
                "exactly one agent_spawn_refused row must survive the rolled-back business transaction");
        assertEquals(0, jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM chat_runs WHERE idempotency_key = ?", Integer.class, secondToolCallId),
                "no run may survive for the refused tool call");
        String detail = jdbcTemplate.queryForObject(
                "SELECT details FROM audit_logs WHERE action = 'agent_spawn_refused' "
                        + "ORDER BY created_at DESC LIMIT 1", String.class);
        assertTrue(detail.contains("count_exceeded"), "the audit names the reason: " + detail);
        assertTrue(!detail.contains("refused\""), "the audit must not carry the prompt: " + detail);
    }

    // --------------------------------------------- no transaction poisoning

    @Test
    void aRefusalDoesNotPoisonTheNextSpawnTransaction() {
        limitTo("{\"maxDepth\":1}");
        ParentFixture parent = fixture();
        ChatSubmissionService.SpawnResult child = spawnDirect(parent);

        // The child session is depth 1, so a spawn from it would be depth 2 -> refused.
        ParentFixture grandChild = fixtureFrom(child.sessionId(), "{\"prompt\":\"too deep\"}");
        int runsBefore = runCount();
        ChatSubmissionService.SpawnInvocation refusedInvocation =
                submissionService.prepareSpawnInvocation(grandChild.parentRunId(), grandChild.toolCallId());
        assertThrows(DelegationRefusedException.class,
                () -> spawnService.execute(refusedInvocation,
                        new ChatSubmissionService.SpawnAuthorization(
                                refusedInvocation.authorizationBody(), null, null)));
        assertEquals(runsBefore, runCount(), "the refused attempt left no run behind");

        // Relax the policy, then spawn again from the same parent: this proves the earlier refusal (whose
        // exception was caught inside a transaction that read the policy) did not mark anything
        // rollback-only.
        limitTo("{\"maxDepth\":3}");
        ChatSubmissionService.SpawnResult allowed = spawnDirect(grandChild);
        assertEquals(runsBefore + 1, runCount(), "the follow-up spawn commits normally");
        ChatRun committed = chatRunRepository.findById(UUID.fromString(allowed.runId())).orElseThrow();
        assertEquals(grandChild.parentRunId(), committed.getWaitingOnRunId());
    }

    // -------------------------------------------------------------- fixtures

    private record ParentFixture(String parentSessionId, String parentRunId, String toolCallId) {}

    private void limitTo(String policyJson) {
        ensureWorkspace();
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId).orElseThrow();
        try {
            principal.setDelegationPolicy(objectMapper.readTree(policyJson));
        } catch (Exception error) {
            throw new AssertionError("bad policy fixture: " + policyJson, error);
        }
        agentPrincipalRepository.saveAndFlush(principal);
    }

    private ParentFixture fixture() {
        ensureWorkspace();
        Session parentSession = new Session(workspaceId, userId,
                "Delegation budget parent " + UUID.randomUUID().toString().substring(0, 8));
        parentSession.setId(UUID.randomUUID());
        parentSession.setAgentPrincipalId(principalId.toString());
        parentSession.setAgentPermissionsSnapshot(capNode());
        ChatBindingTestSupport.bindNewChatConnection(parentSession, providerConnectionRepository,
                apiRequestTemplates, userId);
        sessionRepository.saveAndFlush(parentSession);
        String parentRunId = saveRun(parentSession);
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parentSession.getId().toString(), parentRunId, workspaceId, userId,
                toolCallId, "spawn_agent", "{\"prompt\":\"budget\"}");
        return new ParentFixture(parentSession.getId().toString(), parentRunId, toolCallId);
    }

    /** A spawn child acting as the parent of the next hop (used for the depth cases). */
    private ParentFixture fixtureFrom(String sessionId, String argumentsPreview) {
        Session session = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        String parentRunId = saveRun(session);
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository, sessionId, parentRunId,
                workspaceId, userId, toolCallId, "spawn_agent", argumentsPreview);
        return new ParentFixture(sessionId, parentRunId, toolCallId);
    }

    private ChatSubmissionService.SpawnResult spawnDirect(ParentFixture parent) {
        ChatSubmissionService.SpawnInvocation invocation =
                submissionService.prepareSpawnInvocation(parent.parentRunId(), parent.toolCallId());
        return spawnService.execute(invocation,
                new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null));
    }

    /**
     * V3 fixture: a live manual-mode one-shot SPAWN_AGENT grant for exactly one invocation. Mirrors the
     * row the CP gate writes — {@code details} is the {@code {tool, arguments}} preview
     * {@code consumeApprovedGrant} matches against — and stamps the decision-time columns
     * (policy revision, sandbox generation, mode, reuse scope) so the grant passes every T1.7 check.
     */
    private UUID oneShotSpawnGrant(ParentFixture parent, String argumentsPreview) {
        UUID grantId = UUID.randomUUID();
        var details = objectMapper.createObjectNode();
        details.put("tool", ChatSubmissionService.SPAWN_TOOL_NAME);
        try {
            details.set("arguments", objectMapper.readTree(argumentsPreview));
        } catch (Exception error) {
            throw new AssertionError("bad grant fixture: " + argumentsPreview, error);
        }
        ChatApproval approval = new ChatApproval(grantId.toString(), parent.parentRunId(),
                parent.parentSessionId(), userId, workspaceId, ChatSubmissionService.SPAWN_TOOL_NAME,
                "Execute " + ChatSubmissionService.SPAWN_TOOL_NAME, details.toString(), "approved",
                Instant.now().plusSeconds(300));
        approval.setApproved(true);
        approval.setDecisionKind("once");
        approval.setReuseScope("once");
        approval.setModeAtGrant("manual");
        approval.setPolicyRevision(policyRevision.current());
        Workspace workspace = workspaceRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        approval.setSandboxGeneration(workspace.getGeneration() == null ? 0 : workspace.getGeneration());
        approvalRepository.saveAndFlush(approval);
        return grantId;
    }

    /** Null = the one-shot approval was never consumed (the V3 assertion). */
    private Timestamp grantConsumedAt(UUID grantId) {
        return jdbcTemplate.queryForObject(
                "SELECT grant_consumed_at FROM approval_requests WHERE request_id = ?",
                Timestamp.class, grantId);
    }

    private String saveRun(Session session) {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                runId, session.getId().toString(), userId, workspaceId,
                "delegation-budget-submit-" + runId, "delegation-budget-hash-" + runId,
                "provider", "model", "workspace", "running"));
        return runId;
    }

    private void ensureWorkspace() {
        if (userId != null) {
            return;
        }
        User user = userRepository.save(new User("delegation-budget-" + UUID.randomUUID() + "@test.com",
                "hash", "Delegation budget test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Delegation budget test", userId);
        workspaceId = workspace.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId, WorkspaceRole.OWNER);
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Delegation budget principal");
        principal.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId, capNode()));
    }

    private com.fasterxml.jackson.databind.node.ArrayNode capNode() {
        var cap = objectMapper.createArrayNode();
        var atom = objectMapper.createObjectNode();
        atom.put("actionClass", "read");
        cap.add(atom);
        return cap;
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
}
