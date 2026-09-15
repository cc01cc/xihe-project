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
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
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
 * PLAN-0328 M1 batch 4b + T1.7 — grant materialization guardrails (classification authority,
 * layers, shape-gated reuse tiers, exact session fingerprint, idempotent duplicate rule).
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

    private void face(String tool, String actionClass, ToolShape shape) {
        when(policyEngine.faceOf(tool, USER, WORKSPACE))
                .thenReturn(new ToolFaceRegistry.Face(actionClass, shape));
    }

    @Test
    void unclassifiedToolCannotBeGranted() {
        face("third_party_tool", PolicyLayer.UNCLASSIFIED_ACTION, ToolShape.OPAQUE);

        CpApiException error = assertThrows(CpApiException.class, () -> writer.prepare(
                ApprovalDecision.of(ApprovalDecision.Kind.SAVED, null, null, null, null),
                "third_party_tool", USER, WORKSPACE));

        assertEquals("TOOL_UNCLASSIFIED", error.getCode());
        assertEquals(409, error.getStatus().value());
    }

    @Test
    void actionClassOverrideThatDiffersFromTheRegistryIsRejected() {
        face("write_file", "write", ToolShape.STRUCTURED);

        CpApiException error = assertThrows(CpApiException.class, () -> writer.prepare(
                ApprovalDecision.of(ApprovalDecision.Kind.SAVED, null, null, "exec", "*"),
                "write_file", USER, WORKSPACE));

        assertEquals("INVALID_REQUEST", error.getCode());
    }

    @Test
    void sessionPlanTargetsL4Allow() {
        face("write_file", "write", ToolShape.STRUCTURED);

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
        face("write_file", "write", ToolShape.STRUCTURED);

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
    void deleteFacedToolsOnlyAllowOnce() {
        face("delete_file", "delete", ToolShape.STRUCTURED);

        for (ApprovalDecision.Kind kind : new ApprovalDecision.Kind[]{
                ApprovalDecision.Kind.SESSION, ApprovalDecision.Kind.SAVED}) {
            CpApiException error = assertThrows(CpApiException.class, () -> writer.prepare(
                    ApprovalDecision.of(kind, null, null, null, null), "delete_file", USER, WORKSPACE));
            assertEquals("REUSE_NOT_ALLOWED_FOR_SHAPE", error.getCode());
            assertEquals(400, error.getStatus().value());
        }
    }

    @Test
    void interpreterAllowsSessionButNotSaved() {
        face("execute_command", "exec", ToolShape.INTERPRETER);

        ApprovalGrantWriter.RulePlan plan = writer.prepare(
                ApprovalDecision.of(ApprovalDecision.Kind.SESSION, null, null, null, null),
                "execute_command", USER, WORKSPACE);
        assertEquals("session", plan.layer());

        CpApiException error = assertThrows(CpApiException.class, () -> writer.prepare(
                ApprovalDecision.of(ApprovalDecision.Kind.SAVED, null, null, null, null),
                "execute_command", USER, WORKSPACE));
        assertEquals("REUSE_NOT_ALLOWED_FOR_SHAPE", error.getCode());
        assertEquals(400, error.getStatus().value());
    }

    @Test
    void opaqueFacedToolsRejectEveryReuseTierButKeepRejectAlways() {
        face("third_party_tool", "external", ToolShape.OPAQUE);

        for (ApprovalDecision.Kind kind : new ApprovalDecision.Kind[]{
                ApprovalDecision.Kind.SESSION, ApprovalDecision.Kind.SAVED}) {
            CpApiException error = assertThrows(CpApiException.class, () -> writer.prepare(
                    ApprovalDecision.of(kind, null, null, null, null), "third_party_tool", USER, WORKSPACE));
            assertEquals("REUSE_NOT_ALLOWED_FOR_SHAPE", error.getCode());
        }
        // A persistent deny only narrows: it is never shape-gated.
        assertEquals(PolicyEffect.DENY, writer.prepare(
                ApprovalDecision.of(ApprovalDecision.Kind.REJECT_ALWAYS, null, null, null, null),
                "third_party_tool", USER, WORKSPACE).effect());
    }

    @Test
    void sessionCommitRecordsTheExactInvocationFingerprint() {
        ApprovalGrantWriter.RulePlan plan = new ApprovalGrantWriter.RulePlan(
                "session", "session", "write_file", "write", "*", PolicyEffect.ALLOW);
        ApprovalGrantWriter.GrantContext context = new ApprovalGrantWriter.GrantContext(
                "write_file", "abc123", "default", 42L, 3);

        writer.commit(plan, SESSION, USER, WORKSPACE, context);

        ArgumentCaptor<SessionPolicyState.Grant> grant = ArgumentCaptor.forClass(SessionPolicyState.Grant.class);
        verify(sessionState).addGrant(eq(SESSION), grant.capture());
        assertEquals("sha256:abc123", grant.getValue().argumentsHash());
        assertEquals("write_file", grant.getValue().tool());
        assertEquals("default", grant.getValue().modeAtGrant());
        assertEquals(42L, grant.getValue().policyRevision());
        assertEquals(3, grant.getValue().sandboxGeneration());
        verify(ruleService, never()).create(any(), any(), any(), anyBoolean(), any());
        verify(sessionState, never()).addRule(any(), any());
        verify(audit).record(eq(SESSION), eq("write_file"), eq("policy_grant_session"), any());
    }

    @Test
    void sessionCommitWithoutBindingFailsClosed() {
        ApprovalGrantWriter.RulePlan plan = new ApprovalGrantWriter.RulePlan(
                "session", "session", "write_file", "write", "*", PolicyEffect.ALLOW);

        writer.commit(plan, SESSION, USER, WORKSPACE, null);

        verify(sessionState, never()).addGrant(any(), any());
        verify(audit).record(eq(SESSION), eq("write_file"), eq("policy_grant_session_unavailable"), any());
    }

    @Test
    void persistentCommitWritesThroughTheRuleService() {
        ApprovalGrantWriter.RulePlan plan = new ApprovalGrantWriter.RulePlan(
                "saved", "workspace", "write_file", "write", "notes/*", PolicyEffect.ALLOW);

        writer.commit(plan, SESSION, USER, WORKSPACE, null);

        ArgumentCaptor<PolicyRuleService.RuleInput> input =
                ArgumentCaptor.forClass(PolicyRuleService.RuleInput.class);
        verify(ruleService).create(eq("workspace"), eq(USER), eq(WORKSPACE), eq(false), input.capture());
        assertEquals("write", input.getValue().actionClass());
        assertEquals("notes/*", input.getValue().resource());
        assertEquals("allow", input.getValue().effect());
        verify(sessionState, never()).addRule(any(), any());
        verify(sessionState, never()).addGrant(any(), any());
    }

    @Test
    void duplicatePersistentRuleIsAnIdempotentSuccess() {
        when(ruleService.create(any(), any(), any(), anyBoolean(), any()))
                .thenThrow(new org.springframework.dao.DataIntegrityViolationException("uq_policy_rules_scope"));
        ApprovalGrantWriter.RulePlan plan = new ApprovalGrantWriter.RulePlan(
                "saved", "workspace", "write_file", "write", "*", PolicyEffect.ALLOW);

        writer.commit(plan, SESSION, USER, WORKSPACE, null);

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
