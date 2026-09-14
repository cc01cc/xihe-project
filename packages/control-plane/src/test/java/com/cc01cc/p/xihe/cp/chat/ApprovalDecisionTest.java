package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * PLAN-0328 M1 batch 4b — decision body validation (fail-closed, spec §12 "未知选项 → fail-closed").
 */
class ApprovalDecisionTest {

    @Test
    void unknownWireNameIsRejected() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> ApprovalDecision.Kind.fromWire("always"));

        assertEquals("INVALID_REQUEST", error.getCode());
        assertEquals(400, error.getStatus().value());
    }

    @Test
    void wireNameToleratesCaseAndDash() {
        assertEquals(ApprovalDecision.Kind.REJECT_ALWAYS, ApprovalDecision.Kind.fromWire("Reject-Always"));
        assertEquals(ApprovalDecision.Kind.SESSION, ApprovalDecision.Kind.fromWire("SESSION"));
    }

    @Test
    void feedbackIsOnlyValidForRejections() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> ApprovalDecision.of(ApprovalDecision.Kind.ONCE, "nope", null, null, null));

        assertEquals("INVALID_REQUEST", error.getCode());
    }

    @Test
    void layerIsOnlyValidForPersistentKinds() {
        assertThrows(CpApiException.class,
                () -> ApprovalDecision.of(ApprovalDecision.Kind.SESSION, null, "workspace", null, null));
        assertThrows(CpApiException.class,
                () -> ApprovalDecision.of(ApprovalDecision.Kind.ONCE, null, "user", null, null));
    }

    @Test
    void ruleOverrideIsOnlyValidForGrantingKinds() {
        assertThrows(CpApiException.class,
                () -> ApprovalDecision.of(ApprovalDecision.Kind.REJECT, null, null, "write", "*"));
    }

    @Test
    void defaultsTargetWorkspaceLayerAndWholeDomain() {
        ApprovalDecision saved = ApprovalDecision.of(ApprovalDecision.Kind.SAVED, null, null, null, null);

        assertEquals("workspace", saved.effectiveLayer());
        assertEquals("*", saved.effectiveResource());
        assertNull(ApprovalDecision.once().effectiveLayer());
    }

    @Test
    void oversizedFeedbackIsRejected() {
        assertThrows(CpApiException.class, () -> ApprovalDecision.reject("x".repeat(513)));
    }
}
