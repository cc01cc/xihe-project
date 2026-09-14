package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyRule;
import com.cc01cc.p.xihe.cp.policy.PolicyRuleService;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.SessionPolicyState;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0328 M1 batch 4b — grant materialization guardrails (classification authority, layers,
 * idempotent duplicate rule, re-solve evaluation).
 */
class ApprovalGrantWriterTest {

    private final PolicyEngine policyEngine = mock(PolicyEngine.class);
    private final SessionPolicyState sessionState = mock(SessionPolicyState.class);
    private final PolicyRuleService ruleService = mock(PolicyRuleService.class);
    private final AuditLogger audit = mock(AuditLogger.class);
    private final ApprovalGrantWriter writer = new ApprovalGrantWriter(policyEngine, sessionState, ruleService, audit);

    private static final String USER = "user-1";
    private static final String WORKSPACE = "ws-1";
    private static final String SESSION = "sess-1";

    @Test
    void unclassifiedToolCannotBeGranted() {
        when(policyEngine.actionClassOf("third_party_tool", USER, WORKSPACE))
                .thenReturn(PolicyLayer.UNCLASSIFIED_ACTION);

        CpApiException error = assertThrows(CpApiException.class, () -> writer.prepare(
                ApprovalDecision.of(ApprovalDecision.Kind.SAVED, null, null, null, null),
                "third_party_tool", USER, WORKSPACE));

        assertEquals("TOOL_UNCLASSIFIED", error.getCode());
        assertEquals(409, error.getStatus().value());
    }

    @Test
    void actionClassOverrideThatDiffersFromTheRegistryIsRejected() {
        when(policyEngine.actionClassOf("write_file", USER, WORKSPACE)).thenReturn("write");

        CpApiException error = assertThrows(CpApiException.class, () -> writer.prepare(
                ApprovalDecision.of(ApprovalDecision.Kind.SAVED, null, null, "exec", "*"),
                "write_file", USER, WORKSPACE));

        assertEquals("INVALID_REQUEST", error.getCode());
    }

    @Test
    void sessionPlanTargetsL4Allow() {
        when(policyEngine.actionClassOf("write_file", USER, WORKSPACE)).thenReturn("write");

        ApprovalGrantWriter.RulePlan plan = writer.prepare(
                ApprovalDecision.of(ApprovalDecision.Kind.SESSION, null, null, null, "notes/*"),
                "write_file", USER, WORKSPACE);

        assertEquals("session", plan.layer());
        assertEquals("write", plan.actionClass());
        assertEquals("notes/*", plan.resource());
        assertEquals(PolicyEffect.ALLOW, plan.effect());
    }

    @Test
    void savedPlanDefaultsToWorkspaceAndRejectAlwaysFlipsToDeny() {
        when(policyEngine.actionClassOf("write_file", USER, WORKSPACE)).thenReturn("write");

        ApprovalGrantWriter.RulePlan saved = writer.prepare(
                ApprovalDecision.of(ApprovalDecision.Kind.SAVED, null, null, null, null),
                "write_file", USER, WORKSPACE);
        ApprovalGrantWriter.RulePlan denied = writer.prepare(
                ApprovalDecision.of(ApprovalDecision.Kind.REJECT_ALWAYS, null, "user", null, null),
                "write_file", USER, WORKSPACE);

        assertEquals("workspace", saved.layer());
        assertEquals("*", saved.resource());
        assertEquals(PolicyEffect.ALLOW, saved.effect());
        assertEquals("user", denied.layer());
        assertEquals(PolicyEffect.DENY, denied.effect());
    }

    @Test
    void sessionCommitAddsTheInMemoryRule() {
        ApprovalGrantWriter.RulePlan plan = new ApprovalGrantWriter.RulePlan(
                "session", "session", "write_file", "write", "*", PolicyEffect.ALLOW);

        writer.commit(plan, SESSION, USER, WORKSPACE);

        ArgumentCaptor<PolicyRule> rule = ArgumentCaptor.forClass(PolicyRule.class);
        verify(sessionState).addRule(eq(SESSION), rule.capture());
        assertEquals("write", rule.getValue().actionClass());
        assertEquals(PolicyEffect.ALLOW, rule.getValue().effect());
        verify(ruleService, never()).create(any(), any(), any(), anyBoolean(), any());
    }

    @Test
    void persistentCommitWritesThroughTheRuleService() {
        ApprovalGrantWriter.RulePlan plan = new ApprovalGrantWriter.RulePlan(
                "saved", "workspace", "write_file", "write", "notes/*", PolicyEffect.ALLOW);

        writer.commit(plan, SESSION, USER, WORKSPACE);

        ArgumentCaptor<PolicyRuleService.RuleInput> input =
                ArgumentCaptor.forClass(PolicyRuleService.RuleInput.class);
        verify(ruleService).create(eq("workspace"), eq(USER), eq(WORKSPACE), eq(false), input.capture());
        assertEquals("write", input.getValue().actionClass());
        assertEquals("notes/*", input.getValue().resource());
        assertEquals("allow", input.getValue().effect());
        verify(sessionState, never()).addRule(any(), any());
    }

    @Test
    void duplicatePersistentRuleIsAnIdempotentSuccess() {
        when(ruleService.create(any(), any(), any(), anyBoolean(), any()))
                .thenThrow(new org.springframework.dao.DataIntegrityViolationException("uq_policy_rules_scope"));
        ApprovalGrantWriter.RulePlan plan = new ApprovalGrantWriter.RulePlan(
                "saved", "workspace", "write_file", "write", "*", PolicyEffect.ALLOW);

        writer.commit(plan, SESSION, USER, WORKSPACE);

        verify(ruleService).create(eq("workspace"), eq(USER), eq(WORKSPACE), eq(false), any());
    }

    @Test
    void wouldAllowReflectsTheEngineVerdict() {
        when(policyEngine.evaluateVerdict("write_file", "", SESSION, null, USER, WORKSPACE))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.SESSION, null, "allowed"));
        when(policyEngine.evaluateVerdict("execute_command", "", SESSION, null, USER, WORKSPACE))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ASK, null, PolicyLayer.SESSION, null, "ask"));

        assertTrue(writer.wouldAllow("write_file", SESSION, USER, WORKSPACE));
        assertFalse(writer.wouldAllow("execute_command", SESSION, USER, WORKSPACE));
    }
}
