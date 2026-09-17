package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.PolicyRevisionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0328 T1.7 counter fix on the real PostgreSQL schema: rule/face mutations (including a
 * tightening delete of a non-newest rule) advance the durable revision, so a grant that was valid
 * before the delete is rejected at consume time.
 */
class PolicyRevisionCounterIntegrationTest extends AbstractIntegrationTest {

    private static final String WORKSPACE_LAYER = "workspace";
    private static final String INVOCATION_BODY = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
            + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"a.txt\"}},\"id\":1}";
    private static final String APPROVED_DETAILS =
            "{\"tool\":\"write_file\",\"arguments\":{\"path\":\"a.txt\"}}";

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private ChatApprovalRepository approvalRepository;

    @Autowired
    private PolicyRuleService ruleService;

    @Autowired
    private ToolFaceService toolFaceService;

    @Autowired
    private PolicyRevision policyRevision;

    @Autowired
    private PolicyRevisionRepository policyRevisionRepository;

    @Autowired
    private PolicyEngine policyEngine;

    @Autowired
    private ApprovalService approvalService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;

    @BeforeEach
    void setUpIdentity() {
        String email = "policy-rev-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "PolicyRevisionTest");
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        assertNotNull(response.getBody());

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow();
        workspaceId = workspace.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        TenantContext.setWorkspaceRole("OWNER");

        Session session = new Session(workspaceId, userId, "Policy revision counter");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();

        runId = UUID.randomUUID().toString();
        chatRunRepository.save(new ChatRun(runId, sessionId, userId, workspaceId,
                "policy-rev-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "workspace", "running"));
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void v21CounterRowIsSeededByFlywayAndSingleValued() {
        Integer applied = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '21' AND success = true",
                Integer.class);
        assertEquals(1, applied);
        Integer rows = jdbcTemplate.queryForObject("SELECT count(*) FROM policy_revision", Integer.class);
        assertEquals(1, rows);
        assertTrue(policyRevisionRepository.currentSeq((short) 1).isPresent());
        assertNotEquals(PolicyRevision.ABSENT, policyRevision.current());
    }

    @Test
    void deletingANonNewestRuleAdvancesTheRevision() {
        long initial = policyRevision.current();

        PolicyRuleService.RuleView older = ruleService.create(WORKSPACE_LAYER, userId, workspaceId, false,
                new PolicyRuleService.RuleInput("write", "*", "allow", 0, false));
        ruleService.create(WORKSPACE_LAYER, userId, workspaceId, false,
                new PolicyRuleService.RuleInput("exec", "*", "deny", 0, false));
        long afterCreates = policyRevision.current();
        assertEquals(initial + 2, afterCreates);

        ruleService.delete(older.id(), WORKSPACE_LAYER, userId, workspaceId, false);

        assertEquals(afterCreates + 1, policyRevision.current(),
                "deleting a rule that is not the newest row must still advance the durable revision");
    }

    @Test
    void toolFaceUpsertAdvancesTheRevision() {
        long before = policyRevision.current();

        toolFaceService.upsert(WORKSPACE_LAYER, userId, workspaceId, false,
                new ToolFaceService.FaceInput("mcp__revision__tool", "network", "opaque"));

        assertEquals(before + 1, policyRevision.current());
    }

    @Test
    void tightenedDeleteInvalidatesAPreviouslyValidGrantAtConsume() {
        PolicyRuleService.RuleView shadowingAllow = ruleService.create(WORKSPACE_LAYER, userId, workspaceId,
                false, new PolicyRuleService.RuleInput("write", "*", "allow", 0, false));
        ruleService.create(WORKSPACE_LAYER, userId, workspaceId, false,
                new PolicyRuleService.RuleInput("exec", "*", "deny", 0, false));
        assertEquals(PolicyEffect.ALLOW, policyEngine.evaluateVerdict(
                        "write_file", "", sessionId, null, userId, workspaceId).effect(),
                "the workspace ALLOW shadows the builtin ASK before the delete");

        long grantRevision = policyRevision.current();
        String consumedBefore = UUID.randomUUID().toString();
        approvedGrant(consumedBefore, grantRevision);
        assertTrue(approvalService.consumeApprovedGrant(consumedBefore, userId, workspaceId, sessionId,
                        "write_file", INVOCATION_BODY),
                "the same fixture must be consumable while the captured revision is current");

        String stale = UUID.randomUUID().toString();
        approvedGrant(stale, grantRevision);

        ruleService.delete(shadowingAllow.id(), WORKSPACE_LAYER, userId, workspaceId, false);

        assertEquals(PolicyEffect.ASK, policyEngine.evaluateVerdict(
                        "write_file", "", sessionId, null, userId, workspaceId).effect(),
                "removing the older ALLOW tightens the verdict back to the builtin ASK");
        assertFalse(approvalService.consumeApprovedGrant(stale, userId, workspaceId, sessionId,
                        "write_file", INVOCATION_BODY),
                "the tightening delete must invalidate the grant that was valid before it");
        assertNull(approvalRepository.findById(UUID.fromString(stale)).orElseThrow().getGrantConsumedAt());

        String fresh = UUID.randomUUID().toString();
        approvedGrant(fresh, policyRevision.current());
        assertTrue(approvalService.consumeApprovedGrant(fresh, userId, workspaceId, sessionId,
                        "write_file", INVOCATION_BODY),
                "a grant captured after the delete remains consumable (rejection was revision-specific)");
    }

    @Test
    void revisionIsStableAcrossASimulatedRestart() {
        long durable = policyRevision.current();

        // A fresh component instance has no in-process cache: it must read the same persisted seq.
        PolicyRevision restarted = new PolicyRevision(policyRevisionRepository, new PolicyVersion());

        assertEquals(durable, restarted.current());
    }

    private ChatApproval approvedGrant(String requestId, long revision) {
        ChatApproval approval = new ChatApproval(
                requestId,
                runId,
                sessionId,
                userId,
                workspaceId,
                "write_file",
                "Execute write_file",
                APPROVED_DETAILS,
                "approved",
                Instant.now().plusSeconds(300));
        approval.setApproved(true);
        approval.setPolicyRevision(revision);
        Integer generation = workspaceRepository.findById(UUID.fromString(workspaceId))
                .map(Workspace::getGeneration)
                .map(value -> value == null ? 0 : value)
                .orElseThrow();
        approval.setSandboxGeneration(generation);
        approval.setReuseScope("once");
        return approvalRepository.save(approval);
    }
}
