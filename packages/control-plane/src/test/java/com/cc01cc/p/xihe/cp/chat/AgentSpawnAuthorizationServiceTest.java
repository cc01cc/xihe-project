package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
    private static final String PRINCIPAL_ID = "77777777-7777-7777-7777-777777777777";
    private static final String UNIT_RESOURCE = "agent-unit:root/team";

    private PolicyEngine policy;
    private ApprovalService approvals;
    private SseEmitterManager sse;
    private AuditLogger audit;
    private DelegationBudgetService delegationBudget;
    private OrgUnitMemberRepository orgUnitMembers;
    private OrgUnitReadRepository orgUnits;
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
        orgUnitMembers = mock(OrgUnitMemberRepository.class);
        orgUnits = mock(OrgUnitReadRepository.class);
        service = new AgentSpawnAuthorizationService(policy, approvals, sse, audit, delegationBudget,
                new RequesterAuthority(mock(AuthorizationGrantRepository.class),
                        mock(GrantIntersectionEvaluator.class), mock(AuthzContext.class),
                        com.cc01cc.p.xihe.cp.policy.OrgUnitGrantsTestFixture.withoutRows()),
                orgUnitMembers, orgUnits);

        String runId = "11111111-1111-1111-1111-111111111111";
        String toolCallId = "33333333-3333-3333-3333-333333333333";
        String sessionId = "55555555-5555-5555-5555-555555555555";
        invocation = new ChatSubmissionService.SpawnInvocation(runId, toolCallId, sessionId,
                UUID.randomUUID(), "user-1", WORKSPACE_ID, PRINCIPAL_ID, "canonical-body");

        when(policy.loadContext(any(), any(), any())).thenReturn(PolicyContext.EMPTY);
        // task-969 / D-1942: the agent arm asks for the spawn face PLUS `action:clone` and the
        // caller's own `agent-unit:` subtree. Model "the caller holds both" at the policy seam:
        // the 9-argument overload allows only when both buckets carry their atom. A fixture that
        // (like the old ones) only held SPAWN_AGENT therefore reads as denied, exactly as the
        // real grant path decides.
        when(policy.allowsByGrant(any(PolicyContext.class), anyString(), anyString(), anyString(),
                anyString(), anyString(), any(boolean.class), any(), any()))
                .thenAnswer(call -> {
                    List<String> resources = call.getArgument(7);
                    List<String> actions = call.getArgument(8);
                    return actions.contains(ToolFaceRegistry.ACTION_CLONE)
                            && resources.contains(UNIT_RESOURCE);
                });
        // Deliberately permissive on the old overloads: a gate that regressed to them would
        // pass every case below, so a green run cannot come from the wrong signature.
        when(policy.allowsByGrant(any(PolicyContext.class), anyString(), anyString(), anyString(),
                anyString(), anyString(), any(boolean.class))).thenReturn(true);
        when(policy.allowsByGrant(any(PolicyContext.class), anyString(), anyString(), anyString(),
                anyString(), anyString(), any(boolean.class), any())).thenReturn(true);
        UUID unitId = UUID.randomUUID();
        when(orgUnitMembers.findUnitOf("agent_principal", UUID.fromString(PRINCIPAL_ID)))
                .thenReturn(Optional.of(unitId));
        when(orgUnits.findUnit(unitId)).thenReturn(Optional.of(
                new OrgUnitReadRepository.UnitRow(unitId, null, "team", null, "root.team", 1)));
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
    void grantDenialLogsTheCanonicalActionAtomDeniedLine() {
        // PLAN-0651 T1.5 (proposal B): the spawn-face grant denial joins the canonical
        // action_atom_denied stream — atom=SPAWN_AGENT, the denied caller's channel subject.
        when(policy.allowsByGrant(any(PolicyContext.class), anyString(), anyString(), anyString(),
                anyString(), anyString(), any(boolean.class), any(), any())).thenReturn(false);

        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        ch.qos.logback.classic.Logger policyLogger = (ch.qos.logback.classic.Logger)
                org.slf4j.LoggerFactory.getLogger(
                        com.cc01cc.p.xihe.cp.policy.RequesterAuthority.class);
        policyLogger.addAppender(appender);
        try {
            var thrown = assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                    () -> service.authorize(invocation, null));
            assertEquals("FORBIDDEN", thrown.getCode());
        } finally {
            policyLogger.detachAppender(appender);
        }

        ch.qos.logback.classic.spi.ILoggingEvent event = appender.list.stream()
                .filter(candidate -> candidate.getFormattedMessage()
                        .contains("event=action_atom_denied"))
                .findFirst().orElse(null);
        assertNotNull(event, "the spawn-face denial must log action_atom_denied");
        String line = event.getFormattedMessage();
        assertTrue(line.contains("atom=action:SPAWN_AGENT"), line);
        assertTrue(line.contains("workspaceId=" + WORKSPACE_ID), line);
        // The invocation's agent principal is a real UUID in this fixture (the spawn hierarchy
        // needs one), so the deny stream names it rather than masking to '-'.
        assertTrue(line.contains("subject=" + PRINCIPAL_ID), line);
        assertTrue(line.contains("source=none"), line);
        verify(delegationBudget, never()).precheckBeforeApproval(any(), any(), any());
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
        ArgumentCaptor<List<String>> actions = ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<List<String>> resources = ArgumentCaptor.forClass(List.class);
        verify(policy).allowsByGrant(any(PolicyContext.class),
                eq(ChatSubmissionService.SPAWN_TOOL_NAME), eq(invocation.authorizationBody()),
                eq(invocation.parentSessionId()), eq(invocation.userId()),
                eq(invocation.workspaceId()), eq(false), resources.capture(), actions.capture());
        assertEquals(List.of(ToolFaceRegistry.ACTION_CLONE), actions.getValue(),
                "the permitted self-spawn must have been evaluated with action:clone");
        assertEquals(List.of(UNIT_RESOURCE), resources.getValue(),
                "the permitted self-spawn must have carried the caller's agent-unit subtree");
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

    @Test
    void selfSpawnHoldingOnlySpawnAgentButNotCloneIsDenied() {
        // task-969 / D-1942 positive coverage: the caller holds SPAWN_AGENT but not action:clone.
        // The old 7/8-arg overloads stay permissive on purpose; the denials must come from the
        // clone-evaluating 9-arg request, which here reports the missing AND-ed atom.
        when(policy.allowsByGrant(any(PolicyContext.class), anyString(), anyString(), anyString(),
                anyString(), anyString(), any(boolean.class), any(), any())).thenReturn(false);

        com.cc01cc.p.xihe.cp.config.CpApiException thrown = assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> service.authorize(invocation, "grant-1"));

        assertEquals("FORBIDDEN", thrown.getCode());
        assertEquals("An explicit SPAWN_AGENT grant is required", thrown.getMessage());
        verify(delegationBudget, never()).precheckBeforeApproval(any(), any(), any());
        verify(approvals, never()).recordGatePending(any(), any(), any(), any(), any(), any(), any());
    }
}
