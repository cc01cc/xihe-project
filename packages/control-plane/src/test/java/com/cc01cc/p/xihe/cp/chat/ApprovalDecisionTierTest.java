package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0328 M1 batch 4b — decision tiers, rejection feedback and session propagation
 * (spec/approval.md §14, decisions #23/#25).
 */
class ApprovalDecisionTierTest {

    private final ChatApprovalRepository approvals = mock(ChatApprovalRepository.class);
    private final ChatRunRepository runs = mock(ChatRunRepository.class);
    private final ApprovalAgentClient agent = mock(ApprovalAgentClient.class);
    private final OperationService operationService = mock(OperationService.class);
    private final ApprovalGrantWriter grantWriter = mock(ApprovalGrantWriter.class);
    private final AuditLogger audit = mock(AuditLogger.class);
    private final ApprovalService service = new ApprovalService(approvals, runs, agent, new ObjectMapper(),
            operationService, grantWriter, audit);

    private static final String TEST_RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String TEST_REQUEST_ID = "22222222-2222-2222-2222-222222222222";
    private static final String TEST_USER = "33333333-3333-3333-3333-333333333333";
    private static final String TEST_WORKSPACE = "44444444-4444-4444-4444-444444444444";
    private static final String TEST_SESSION = "55555555-5555-5555-5555-555555555555";

    private static final ApprovalGrantWriter.RulePlan SESSION_PLAN = new ApprovalGrantWriter.RulePlan(
            "session", "session", "write_file", "write", "*", PolicyEffect.ALLOW);
    private static final ApprovalGrantWriter.RulePlan WORKSPACE_PLAN = new ApprovalGrantWriter.RulePlan(
            "saved", "workspace", "write_file", "write", "*", PolicyEffect.ALLOW);
    private static final ApprovalGrantWriter.RulePlan DENY_PLAN = new ApprovalGrantWriter.RulePlan(
            "reject_always", "workspace", "write_file", "write", "*", PolicyEffect.DENY);

    private ChatApproval pendingRow(String requestId, String tool, Instant expiresAt) {
        return new ChatApproval(requestId, TEST_RUN_ID, TEST_SESSION, TEST_USER, TEST_WORKSPACE,
                tool, "Execute " + tool, "preview", "pending", expiresAt, null, "require_approval");
    }

    private void claimPrimary() {
        when(approvals.markDispatching(eq(UUID.fromString(TEST_REQUEST_ID)), anyBoolean(), any(Instant.class)))
                .thenReturn(1);
        when(approvals.markDecided(eq(UUID.fromString(TEST_REQUEST_ID)), any(), any(), any(Instant.class)))
                .thenReturn(1);
    }

    private void noOtherPending() {
        when(approvals.findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
                TEST_SESSION, TEST_USER, TEST_WORKSPACE, List.of("pending"))).thenReturn(List.of());
    }

    @Test
    void onceApprovalGrantsNothingAndDoesNotPropagate() {
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60))));
        claimPrimary();
        when(agent.respond(TEST_REQUEST_ID, true, "once", null))
                .thenReturn(Map.of("status", "accepted"));

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.once());

        assertEquals("accepted", response.get("status"));
        assertEquals("once", response.get("decision"));
        assertEquals(0, response.get("propagated"));
        verifyNoInteractions(grantWriter);
        verify(agent).respond(TEST_REQUEST_ID, true, "once", null);
        verify(operationService).resolveApprovalItem(TEST_REQUEST_ID, true);
    }

    @Test
    void sessionTierCommitsL4RuleAndReportsIt() {
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60))));
        claimPrimary();
        noOtherPending();
        when(grantWriter.prepare(any(), eq("write_file"), eq(TEST_USER), eq(TEST_WORKSPACE)))
                .thenReturn(SESSION_PLAN);
        when(agent.respond(TEST_REQUEST_ID, true, "session", null)).thenReturn(Map.of("status", "accepted"));

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.SESSION, null, null, null, null));

        assertEquals("session", response.get("decision"));
        assertEquals(0, response.get("propagated"));
        @SuppressWarnings("unchecked")
        Map<String, Object> rule = (Map<String, Object>) response.get("rule");
        assertEquals("session", rule.get("layer"));
        assertEquals("write", rule.get("actionClass"));
        assertEquals("allow", rule.get("effect"));
        verify(grantWriter).commit(SESSION_PLAN, TEST_SESSION, TEST_USER, TEST_WORKSPACE);
        verify(agent).respond(TEST_REQUEST_ID, true, "session", null);
    }

    @Test
    void sessionTierReleasesOnlyPendingRowsTheNewRulesetAllows() {
        String releasedId = "66666666-6666-6666-6666-666666666666";
        String keptId = "77777777-7777-7777-7777-777777777777";
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60))));
        claimPrimary();
        when(grantWriter.prepare(any(), any(), any(), any())).thenReturn(SESSION_PLAN);
        when(agent.respond(TEST_REQUEST_ID, true, "session", null)).thenReturn(Map.of("status", "accepted"));
        when(approvals.findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
                TEST_SESSION, TEST_USER, TEST_WORKSPACE, List.of("pending")))
                .thenReturn(List.of(
                        pendingRow(releasedId, "write_file", Instant.now().plusSeconds(60)),
                        pendingRow(keptId, "execute_command", Instant.now().plusSeconds(60))));
        PolicyContext context = PolicyContext.EMPTY;
        when(grantWriter.loadContext(TEST_USER, TEST_WORKSPACE, TEST_SESSION)).thenReturn(context);
        when(grantWriter.wouldAllow("write_file", context, TEST_SESSION)).thenReturn(true);
        when(grantWriter.wouldAllow("execute_command", context, TEST_SESSION)).thenReturn(false);
        when(approvals.markDispatching(eq(UUID.fromString(releasedId)), eq(true), any(Instant.class))).thenReturn(1);
        when(approvals.markDecided(eq(UUID.fromString(releasedId)), eq("approved"), any(), any(Instant.class)))
                .thenReturn(1);

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.SESSION, null, null, null, null));

        assertEquals(1, response.get("propagated"));
        verify(grantWriter).loadContext(TEST_USER, TEST_WORKSPACE, TEST_SESSION);
        verify(grantWriter).wouldAllow("write_file", context, TEST_SESSION);
        verify(grantWriter).wouldAllow("execute_command", context, TEST_SESSION);
        verify(agent).respond(releasedId, true, "propagated_allow", null);
        verify(operationService).resolveApprovalItem(releasedId, true);
        verify(approvals, never()).markDispatching(eq(UUID.fromString(keptId)), anyBoolean(), any(Instant.class));
        verify(agent, never()).respond(eq(keptId), anyBoolean(), any(), any());
    }

    @Test
    void propagationEvaluatesEveryRowAgainstOneLoadedContext() {
        String firstId = "61111111-1111-1111-1111-111111111111";
        String secondId = "62222222-2222-2222-2222-222222222222";
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60))));
        claimPrimary();
        when(grantWriter.prepare(any(), any(), any(), any())).thenReturn(SESSION_PLAN);
        when(agent.respond(TEST_REQUEST_ID, true, "session", null)).thenReturn(Map.of("status", "accepted"));
        when(approvals.findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
                TEST_SESSION, TEST_USER, TEST_WORKSPACE, List.of("pending")))
                .thenReturn(List.of(
                        pendingRow(firstId, "write_file", Instant.now().plusSeconds(60)),
                        pendingRow(secondId, "write_file", Instant.now().plusSeconds(60))));
        PolicyContext context = PolicyContext.EMPTY;
        when(grantWriter.loadContext(TEST_USER, TEST_WORKSPACE, TEST_SESSION)).thenReturn(context);
        when(grantWriter.wouldAllow("write_file", context, TEST_SESSION)).thenReturn(true);
        when(approvals.markDispatching(eq(UUID.fromString(firstId)), eq(true), any(Instant.class))).thenReturn(1);
        when(approvals.markDispatching(eq(UUID.fromString(secondId)), eq(true), any(Instant.class))).thenReturn(1);

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.SESSION, null, null, null, null));

        assertEquals(2, response.get("propagated"));
        verify(grantWriter, times(1)).loadContext(TEST_USER, TEST_WORKSPACE, TEST_SESSION);
        verify(grantWriter, times(2)).wouldAllow("write_file", context, TEST_SESSION);
    }

    @Test
    void propagationStopsAtTwentyAttemptsAndSkipsTheRest() {
        int rowCount = 25;
        List<ChatApproval> rows = new ArrayList<>();
        List<String> rowIds = new ArrayList<>();
        for (int i = 0; i < rowCount; i++) {
            String rowId = String.format("70000000-0000-0000-0000-%012d", i);
            rowIds.add(rowId);
            rows.add(pendingRow(rowId, "write_file", Instant.now().plusSeconds(60)));
        }
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60))));
        claimPrimary();
        when(grantWriter.prepare(any(), any(), any(), any())).thenReturn(SESSION_PLAN);
        when(agent.respond(TEST_REQUEST_ID, true, "session", null)).thenReturn(Map.of("status", "accepted"));
        when(approvals.findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
                TEST_SESSION, TEST_USER, TEST_WORKSPACE, List.of("pending"))).thenReturn(rows);
        PolicyContext context = PolicyContext.EMPTY;
        when(grantWriter.loadContext(TEST_USER, TEST_WORKSPACE, TEST_SESSION)).thenReturn(context);
        when(grantWriter.wouldAllow(anyString(), eq(context), anyString())).thenReturn(true);
        when(approvals.markDispatching(any(), anyBoolean(), any(Instant.class))).thenReturn(1);

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.SESSION, null, null, null, null));

        assertEquals(20, response.get("propagated"));
        verify(agent, times(20)).respond(anyString(), eq(true), eq("propagated_allow"), any());
        verify(agent, never()).respond(eq(rowIds.get(20)), anyBoolean(), any(), any());
        verify(agent, never()).respond(eq(rowIds.get(24)), anyBoolean(), any(), any());
        verify(approvals, never()).markDispatching(eq(UUID.fromString(rowIds.get(20))), anyBoolean(), any(Instant.class));
        verify(grantWriter, times(1)).loadContext(TEST_USER, TEST_WORKSPACE, TEST_SESSION);
    }

    @Test
    void savedTierCommitsPersistentWorkspaceRule() {
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60))));
        claimPrimary();
        noOtherPending();
        when(grantWriter.prepare(any(), any(), any(), any())).thenReturn(WORKSPACE_PLAN);
        when(agent.respond(TEST_REQUEST_ID, true, "saved", null)).thenReturn(Map.of("status", "accepted"));

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.SAVED, null, "workspace", null, null));

        assertEquals("saved", response.get("decision"));
        verify(grantWriter).commit(WORKSPACE_PLAN, TEST_SESSION, TEST_USER, TEST_WORKSPACE);
    }

    @Test
    void rejectCarriesFeedbackAndRejectsSameSessionPending() {
        String otherId = "88888888-8888-8888-8888-888888888888";
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60))));
        claimPrimary();
        when(agent.respond(TEST_REQUEST_ID, false, "reject", "请改用追加写入"))
                .thenReturn(Map.of("status", "accepted"));
        when(approvals.findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
                TEST_SESSION, TEST_USER, TEST_WORKSPACE, List.of("pending")))
                .thenReturn(List.of(pendingRow(otherId, "execute_command", Instant.now().plusSeconds(60))));
        when(approvals.markDispatching(eq(UUID.fromString(otherId)), eq(false), any(Instant.class))).thenReturn(1);
        when(approvals.markDecided(eq(UUID.fromString(otherId)), eq("rejected"), any(), any(Instant.class))).thenReturn(1);

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.reject("请改用追加写入"));

        assertEquals(false, response.get("approved"));
        assertEquals(1, response.get("propagated"));
        verify(agent).respond(TEST_REQUEST_ID, false, "reject", "请改用追加写入");
        verify(agent).respond(otherId, false, "propagated_reject", null);
        verify(operationService).resolveApprovalItem(otherId, false);
        verifyNoInteractions(grantWriter);
    }

    @Test
    void rejectAlwaysCommitsDenyRuleBeforeResponding() {
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60))));
        claimPrimary();
        noOtherPending();
        when(grantWriter.prepare(any(), any(), any(), any())).thenReturn(DENY_PLAN);
        when(agent.respond(TEST_REQUEST_ID, false, "reject_always", null)).thenReturn(Map.of("status", "accepted"));

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.REJECT_ALWAYS, null, null, null, null));

        assertEquals("reject_always", response.get("decision"));
        verify(grantWriter).commit(DENY_PLAN, TEST_SESSION, TEST_USER, TEST_WORKSPACE);
        verify(agent).respond(TEST_REQUEST_ID, false, "reject_always", null);
    }

    @Test
    void unclassifiedToolRefusalLeavesTheRowPending() {
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "third_party_tool", Instant.now().plusSeconds(60))));
        when(grantWriter.prepare(any(), any(), any(), any())).thenThrow(new CpApiException(
                org.springframework.http.HttpStatus.CONFLICT, "TOOL_UNCLASSIFIED", "Tool is not classified"));

        CpApiException error = assertThrows(CpApiException.class, () -> service.decide(
                TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.SAVED, null, null, null, null)));

        assertEquals("TOOL_UNCLASSIFIED", error.getCode());
        verify(approvals, never()).markDispatching(any(), anyBoolean(), any(Instant.class));
        verify(agent, never()).respond(any(), anyBoolean(), any(), any());
        verify(operationService, never()).resolveApprovalItem(any(), anyBoolean());
    }

    @Test
    void ruleWriteFailureMarksDispatchUnknownAndStaysRetryable() {
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60))));
        claimPrimary();
        when(grantWriter.prepare(any(), any(), any(), any())).thenReturn(SESSION_PLAN);
        org.mockito.Mockito.doThrow(new IllegalStateException("db down"))
                .when(grantWriter).commit(any(), any(), any(), any());

        CpApiException error = assertThrows(CpApiException.class, () -> service.decide(
                TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.SESSION, null, null, null, null)));

        assertEquals("POLICY_RULE_WRITE_FAILED", error.getCode());
        verify(approvals).markDispatchUnknown(eq(UUID.fromString(TEST_REQUEST_ID)),
                eq("POLICY_RULE_WRITE_FAILED"), any(Instant.class));
        verify(agent, never()).respond(any(), anyBoolean(), any(), any());
        verify(approvals, never()).markDecided(any(), any(), any(), any(Instant.class));
    }

    @Test
    void forbiddenRuleWriteRethrowsTheDomainErrorAndKeepsTheRowRetryable() {
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID)))
                .thenReturn(Optional.of(pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60))));
        claimPrimary();
        when(grantWriter.prepare(any(), any(), any(), any())).thenReturn(SESSION_PLAN);
        org.mockito.Mockito.doThrow(new CpApiException(
                        org.springframework.http.HttpStatus.FORBIDDEN, "FORBIDDEN", "workspace OWNER required"))
                .when(grantWriter).commit(any(), any(), any(), any());

        CpApiException error = assertThrows(CpApiException.class, () -> service.decide(
                TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.SESSION, null, null, null, null)));

        assertEquals(403, error.getStatus().value());
        assertEquals("FORBIDDEN", error.getCode());
        verify(approvals).markDispatchUnknown(eq(UUID.fromString(TEST_REQUEST_ID)),
                eq("FORBIDDEN"), any(Instant.class));
        verify(agent, never()).respond(any(), anyBoolean(), any(), any());
    }

    @Test
    void idempotentRepeatDoesNotReGrantOrRePropagate() {
        ChatApproval approvedRow = pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60));
        approvedRow.setState("approved");
        approvedRow.setApproved(true);
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(approvedRow));

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.SAVED, null, null, null, null));

        assertEquals("accepted", response.get("status"));
        assertEquals("saved", response.get("decision"));
        assertEquals(0, response.get("propagated"));
        verifyNoInteractions(grantWriter);
        verifyNoInteractions(agent);
    }

    @Test
    void conflictingRepeatDecisionIsRejected() {
        ChatApproval approvedRow = pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60));
        approvedRow.setState("approved");
        approvedRow.setApproved(true);
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(approvedRow));

        CpApiException error = assertThrows(CpApiException.class, () -> service.decide(
                TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE, ApprovalDecision.reject(null)));

        assertEquals("APPROVAL_DECISION_CONFLICT", error.getCode());
    }

    @Test
    void terminalRepeatWithADifferentDecisionKindIsRejected() {
        ChatApproval approvedRow = terminalRow("once", true);
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(approvedRow));

        CpApiException error = assertThrows(CpApiException.class, () -> service.decide(
                TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.SESSION, null, null, null, null)));

        assertEquals(409, error.getStatus().value());
        assertEquals("APPROVAL_DECISION_CONFLICT", error.getCode());
        assertTrue(error.getMessage().contains("different decision kind"), error.getMessage());
        verifyNoInteractions(grantWriter);
        verifyNoInteractions(agent);
    }

    @Test
    void terminalRepeatOfAPersistentDenyIsNotSilentlyDropped() {
        ChatApproval rejectedRow = terminalRow("reject_always", false);
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(rejectedRow));

        CpApiException error = assertThrows(CpApiException.class, () -> service.decide(
                TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE, ApprovalDecision.reject(null)));

        assertEquals("APPROVAL_DECISION_CONFLICT", error.getCode());
        verifyNoInteractions(grantWriter);
    }

    @Test
    void terminalRepeatOfTheSameKindEchoesTheRecordedKind() {
        ChatApproval rejectedRow = terminalRow("reject_always", false);
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(rejectedRow));

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.of(ApprovalDecision.Kind.REJECT_ALWAYS, null, null, null, null));

        assertEquals("accepted", response.get("status"));
        assertEquals("reject_always", response.get("decision"));
        assertEquals(false, response.get("approved"));
        assertEquals(0, response.get("propagated"));
        verifyNoInteractions(grantWriter);
        verifyNoInteractions(agent);
    }

    @Test
    void legacyTerminalRowWithoutDecisionKindStillMatchesTheBoolean() {
        ChatApproval legacyRow = terminalRow(null, true);
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(legacyRow));

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE,
                ApprovalDecision.once());

        assertEquals("accepted", response.get("status"));
        assertEquals("once", response.get("decision"));
        verifyNoInteractions(grantWriter);
        verifyNoInteractions(agent);
    }

    private ChatApproval terminalRow(String decisionKind, boolean approved) {
        ChatApproval row = pendingRow(TEST_REQUEST_ID, "write_file", Instant.now().plusSeconds(60));
        row.setState(approved ? "approved" : "rejected");
        row.setApproved(approved);
        row.setDecisionKind(decisionKind);
        return row;
    }

    @Test
    void pendingSummariesGroupLiveRowsBySessionWithOldestFirst() {
        Instant older = Instant.now().minusSeconds(120);
        Instant newer = Instant.now().minusSeconds(60);
        ChatApproval first = mock(ChatApproval.class);
        when(first.getSessionId()).thenReturn("session-a");
        when(first.getExpiresAt()).thenReturn(Instant.now().plusSeconds(300));
        when(first.getCreatedAt()).thenReturn(older);
        ChatApproval second = mock(ChatApproval.class);
        when(second.getSessionId()).thenReturn("session-a");
        when(second.getExpiresAt()).thenReturn(Instant.now().plusSeconds(300));
        when(second.getCreatedAt()).thenReturn(newer);
        ChatApproval expired = mock(ChatApproval.class);
        when(expired.getSessionId()).thenReturn("session-b");
        when(expired.getExpiresAt()).thenReturn(Instant.now().minusSeconds(1));
        when(expired.getCreatedAt()).thenReturn(older);
        when(approvals.findByUserIdAndWorkspaceIdAndStateInAndExpiresAtAfterOrderByCreatedAtAsc(
                eq(TEST_USER), eq(TEST_WORKSPACE), eq(List.of("pending")), any(Instant.class)))
                .thenReturn(List.of(first, second, expired));

        List<Map<String, Object>> summaries = service.pendingSummaries(TEST_USER, TEST_WORKSPACE);

        assertEquals(1, summaries.size());
        assertEquals("session-a", summaries.get(0).get("sessionId"));
        assertEquals(TEST_WORKSPACE, summaries.get(0).get("workspaceId"));
        assertEquals(2, summaries.get(0).get("count"));
        assertEquals(older, summaries.get(0).get("oldestRequestedAt"));
        assertTrue(!summaries.get(0).containsKey("details") && !summaries.get(0).containsKey("tool"));
    }

    @Test
    void legacyBooleanDecisionMapsToOnceAndReject() {
        assertTrue(ApprovalDecision.fromApproved(true).kind() == ApprovalDecision.Kind.ONCE);
        assertTrue(ApprovalDecision.fromApproved(false).kind() == ApprovalDecision.Kind.REJECT);
    }
}
