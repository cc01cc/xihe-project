package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0663 M1: the internal spawn gate ({@code /internal/v1/agents/spawn}, shared with the human
 * delegation route) must evaluate the delegation budget <b>before</b> parking an approval request.
 */
class AgentSpawnAuthorizationServiceTest {

    private static final String WORKSPACE_ID = "66666666-6666-6666-6666-666666666666";

    private PolicyEngine policy;
    private ApprovalService approvals;
    private SseEmitterManager sse;
    private AuditLogger audit;
    private DelegationBudgetService delegationBudget;
    private AgentSpawnAuthorizationService service;

    private ChatSubmissionService.SpawnInvocation invocation;
    private DelegationRefusedException refusal;

    @BeforeEach
    void setUp() {
        policy = mock(PolicyEngine.class);
        approvals = mock(ApprovalService.class);
        sse = mock(SseEmitterManager.class);
        audit = mock(AuditLogger.class);
        delegationBudget = mock(DelegationBudgetService.class);
        service = new AgentSpawnAuthorizationService(policy, approvals, sse, audit, delegationBudget);

        String runId = "11111111-1111-1111-1111-111111111111";
        String toolCallId = "33333333-3333-3333-3333-333333333333";
        String sessionId = "55555555-5555-5555-5555-555555555555";
        invocation = new ChatSubmissionService.SpawnInvocation(runId, toolCallId, sessionId,
                UUID.randomUUID(), "user-1", WORKSPACE_ID, "agent-1", "canonical-body");

        when(policy.loadContext(any(), any(), any())).thenReturn(PolicyContext.EMPTY);
        when(policy.allowsByGrant(any(PolicyContext.class), anyString(), anyString(), anyString(),
                anyString(), anyString(), any(boolean.class))).thenReturn(true);
        when(policy.evaluateVerdict(any(PolicyContext.class), anyString(), anyString(), anyString(),
                isNull(), anyString(), anyString()))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ASK, null, PolicyLayer.BUILTIN, "manual", "approval"));
        when(policy.faceOf(any(PolicyContext.class), anyString()))
                .thenReturn(new ToolFaceRegistry.Face("SPAWN_AGENT", ToolShape.STRUCTURED));
        when(approvals.tryReuseSessionGrant(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(false);

        var auditContext = new DelegationRefusedException.DelegationAuditContext(
                "88888888-8888-8888-8888-888888888888", sessionId, runId, toolCallId, "agent-1");
        refusal = DelegationRefusedException.refused("count_exceeded", auditContext,
                DelegationRefusedException.PHASE_PRECHECK, 1, 2, 1, 1);
    }

    @Test
    void overBudgetSpawnIsRefusedWithoutCreatingAnApprovalRequest() {
        org.mockito.Mockito.doThrow(refusal).when(delegationBudget)
                .precheckBeforeApproval(invocation.parentSessionId(), invocation.parentRunId(),
                        invocation.toolCallId());

        DelegationRefusedException thrown = assertThrows(DelegationRefusedException.class,
                () -> service.authorize(invocation, null));

        assertEquals("DELEGATION_LIMIT_EXCEEDED", thrown.getCode());
        assertTrue(thrown.auditDetail().contains("\"phase\":\"precheck\""), thrown.auditDetail());
        // The whole point: no approval row (and therefore no modal) for a spawn that cannot run.
        verify(approvals, never()).recordGatePending(any(), any(), any(), any(), any(), any(), any());
        // Durable audit row carries phase=precheck (INV-7: written outside any transaction).
        ArgumentCaptor<String> detail = ArgumentCaptor.forClass(String.class);
        verify(audit).recordDurableChange(eq("user-1"), eq(WORKSPACE_ID), eq("agent_spawn_refused"),
                eq("chat_session"), eq(invocation.parentSessionId()), detail.capture());
        assertTrue(detail.getValue().contains("\"reason\":\"count_exceeded\""), detail.getValue());
        assertTrue(detail.getValue().contains("\"phase\":\"precheck\""), detail.getValue());
    }

    @Test
    void withinBudgetSpawnStillParksTheApprovalRequest() {
        // No exception from the precheck: the gate proceeds to the normal approval branch.
        var row = new com.cc01cc.p.xihe.cp.entity.ChatApproval(
                UUID.randomUUID().toString(), invocation.parentRunId(), invocation.parentSessionId(),
                "user-1", WORKSPACE_ID, ChatSubmissionService.SPAWN_TOOL_NAME,
                invocation.authorizationBody(), "preview", "pending",
                java.time.Instant.now().plusSeconds(300));
        when(approvals.recordGatePending(any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(java.util.Optional.of(ApprovalService.GateApprovalOutcome.parked(row)));
        when(approvals.livePayload(any())).thenReturn(java.util.Map.of());

        AgentSpawnAuthorizationService.GateResult result = service.authorize(invocation, null);

        assertEquals(false, result.allowed());
        assertEquals(row.getRequestId().toString(), result.approvalRequestId());
        verify(approvals).recordGatePending(eq(invocation.parentSessionId()),
                eq(invocation.parentRunId()), eq("user-1"), eq(WORKSPACE_ID),
                eq(ChatSubmissionService.SPAWN_TOOL_NAME), any(), any());
    }

    @Test
    void aRetryCarryingTheGrantSkipsThePrecheckEntirely() {
        // A post-approval retry must not run the pre-approval gate again: the locked TOCTOU check in
        // createSpawnFromParent is the authority for that phase.
        AgentSpawnAuthorizationService.GateResult result = service.authorize(invocation, "grant-1");

        assertEquals(true, result.allowed());
        assertEquals("grant-1", result.authorization().approvalGrantId());
        verify(delegationBudget, never()).precheckBeforeApproval(any(), any(), any());
    }
}
