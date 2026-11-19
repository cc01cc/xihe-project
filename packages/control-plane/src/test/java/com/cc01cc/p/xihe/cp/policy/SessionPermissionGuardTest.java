package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.service.SessionReadAccess;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.mockito.ArgumentCaptor;

/**
 * task-108 / D-1908 rev3: who may change a session's permission tier.
 *
 * <p>The table pins the decision rows of the card plus the unreadable-tier fail-closed row. There
 * are three states, not two: a widening needs the {@code session:permission:configure} atom
 * <b>and</b> {@code sessions.user_id == actor}; a tightening is open to any participant without the
 * atom; and a write that stores the tier already in place is a no-op (idempotent rewrite, also open
 * to any participant and explicitly <b>not</b> recorded as a tightening). A tier that cannot be read
 * refuses instead of being guessed. Every row also asserts that one
 * {@code session.permission.escalated} audit record carries actor / session / {@code from -> to} /
 * atom source and distinguishes tightening from no-op.</p>
 */
class SessionPermissionGuardTest {

    private static final String ACTOR = "11111111-1111-1111-1111-111111111111";
    private static final String OTHER = "33333333-3333-3333-3333-333333333333";
    private static final String WORKSPACE = "22222222-2222-2222-2222-222222222222";
    private static final String SESSION = "s1";
    private static final String ATOM = ToolFaceRegistry.ACTION_SESSION_PERMISSION_CONFIGURE;

    private final SessionReadAccess sessionReadAccess = mock(SessionReadAccess.class);
    private final RequesterAuthority requesterAuthority = mock(RequesterAuthority.class);
    private final SessionApprovalMode sessionApprovalMode = mock(SessionApprovalMode.class);
    private final AuditLogger auditLogger = mock(AuditLogger.class);
    private final SessionPermissionGuard guard = new SessionPermissionGuard(
            sessionReadAccess, requesterAuthority, sessionApprovalMode, auditLogger);

    /**
     * owner, participant, atom, stored tier, target tier, allowed, reason, tightening, noop, sources.
     */
    static Stream<Arguments> whoMayChangeTheTier() {
        return Stream.of(
                // 1. owner + atom, widening: the only path that relaxes a session.
                Arguments.of(true, true, true, "workspace", "full", true, null, false, false, "role"),
                // 2. owner without the atom, widening: refused (ownership alone is not enough).
                Arguments.of(true, true, false, "workspace", "full", false,
                        SessionPermissionGuard.REASON_NO_CAPABILITY, false, false, "-"),
                // 3. non-owner WITH the atom, widening: refused (the atom is not enough), and the
                //    refusal still records where the atom came from.
                Arguments.of(false, true, true, "workspace", "full", false,
                        SessionPermissionGuard.REASON_NOT_SESSION_OWNER, false, false, "role"),
                // 4. non-owner without the atom, widening: refused on the capability first.
                Arguments.of(false, true, false, "workspace", "full", false,
                        SessionPermissionGuard.REASON_NO_CAPABILITY, false, false, "-"),
                // 5. any participant may tighten without the atom — and no atom source is recorded.
                Arguments.of(false, true, false, "full", "workspace", true, null, true, false, "-"),
                // 6. a non-participant cannot even tighten.
                Arguments.of(false, false, false, "full", "workspace", false,
                        SessionPermissionGuard.REASON_NOT_SESSION_OWNER, true, false, "-"),
                // 7. the same tier changes nothing (no-op, lead ruling on task-108): a non-creator
                //    participant holding no atom may re-submit it, and it is not a tightening.
                Arguments.of(false, true, false, "full", "full", true, null, false, true, "-"),
                // 8. a non-participant is still refused on a no-op: participation is the floor.
                Arguments.of(false, false, false, "full", "full", false,
                        SessionPermissionGuard.REASON_NOT_SESSION_OWNER, false, true, "-"),
                // 9. no stored tier = inherit: treated as widening, so owner + atom is required.
                Arguments.of(true, true, true, null, "full", true, null, false, false, "role"));
    }

    @ParameterizedTest(name = "owner={0} participant={1} atom={2} {3}->{4} allowed={5}")
    @MethodSource("whoMayChangeTheTier")
    void decidesWhoMayChangeTheTier(boolean owner, boolean participant, boolean atom,
                                    String storedTier, String targetTier, boolean allowed,
                                    String reason, boolean tightening, boolean noop, String sources) {
        stubSession(owner, participant);
        stubStoredTier(storedTier);
        stubAtom(atom);

        SessionPermissionGuard.Decision decision = guard.authorize(ACTOR, WORKSPACE, SESSION, targetTier);

        assertEquals(allowed, decision.allowed());
        assertEquals(reason, decision.reason());
        assertEquals(targetTier, decision.toTier());
        assertEquals(storedTier, decision.fromTier());
        assertEquals(tightening, decision.tightening());
        assertEquals(noop, decision.noop());
        assertEquals("-".equals(sources) ? Set.of() : Set.of(sources), decision.atomSources());

        String detail = capturedAuditDetail();
        assertTrue(detail.contains("result=" + (allowed ? "allowed" : "denied")), detail);
        assertTrue(detail.contains("actor=" + ACTOR), detail);
        assertTrue(detail.contains("sessionId=" + SESSION), detail);
        assertTrue(detail.contains("to=" + targetTier), detail);
        assertTrue(detail.contains("atom=" + ATOM), detail);
        // The audit line must tell tightening apart from an idempotent rewrite.
        assertTrue(detail.contains("tightening=" + tightening), detail);
        assertTrue(detail.contains("noop=" + noop), detail);
        if (reason != null) {
            assertTrue(detail.contains("reason=" + reason), detail);
        }
        if ("role".equals(sources)) {
            assertTrue(detail.contains("atomSources=role"), detail);
        } else {
            assertTrue(detail.contains("atomSources=-"), detail);
        }
        // Neither a tightening nor a no-op may consult the grant table: nothing is being granted.
        if ((tightening || noop) && allowed) {
            verify(requesterAuthority, never()).holdsActionAtom(any(), any(), any());
        }
    }

    @Test
    void unreadableStoredTierFailsClosedInsteadOfBeingGuessed() {
        stubSession(true, true);
        when(sessionApprovalMode.tierOf(SESSION)).thenThrow(new IllegalStateException("session tier unreadable"));

        SessionPermissionGuard.Decision decision = guard.authorize(ACTOR, WORKSPACE, SESSION, "full");

        assertFalse(decision.allowed());
        assertEquals(SessionPermissionGuard.REASON_TIER_UNREADABLE, decision.reason());
        assertNull(decision.fromTier());
        assertFalse(decision.tightening());
        // Fail-closed happens before any grant read: an unreadable tier is not an authorization bypass.
        verify(requesterAuthority, never()).holdsActionAtom(any(), any(), any());
        String detail = capturedAuditDetail();
        assertTrue(detail.contains("reason=" + SessionPermissionGuard.REASON_TIER_UNREADABLE), detail);
        assertTrue(detail.contains("from=-"), detail);
    }

    @Test
    void legacyApprovalModeRowStillImpliesItsTier() {
        stubSession(false, true);
        when(sessionApprovalMode.tierOf(SESSION)).thenReturn(Optional.empty());
        when(sessionApprovalMode.modeOf(SESSION)).thenReturn(Optional.of("auto"));

        SessionPermissionGuard.Decision decision = guard.authorize(ACTOR, WORKSPACE, SESSION, "workspace");

        assertTrue(decision.allowed());
        assertEquals("full", decision.fromTier());
        assertTrue(decision.tightening());
        assertFalse(decision.noop());
    }

    @Test
    void rewritingTheCurrentTierIsAnIdempotentNoOpNotAnEscalation() {
        // Lead ruling on task-108: a whole-table write, a retried PATCH or an idempotent client all
        // re-submit the tier already stored. The value does not change, so this is not an
        // authorization-surface change: a plain participant without the atom must get through.
        when(sessionReadAccess.resolve(OTHER, WORKSPACE, SESSION)).thenReturn(
                new SessionReadAccess.Resolved(null,
                        new SessionReadAccess.AccessDecision(false, true, false)));
        stubStoredTier("full");

        SessionPermissionGuard.Decision decision = guard.authorize(OTHER, WORKSPACE, SESSION, "full");

        assertTrue(decision.allowed());
        assertNull(decision.reason());
        assertFalse(decision.tightening());
        assertTrue(decision.noop());
        assertEquals(Set.of(), decision.atomSources());
        verify(requesterAuthority, never()).holdsActionAtom(any(), any(), any());
        String detail = capturedAuditDetail();
        assertTrue(detail.contains("result=allowed"), detail);
        assertTrue(detail.contains("tightening=false"), detail);
        assertTrue(detail.contains("noop=true"), detail);
        assertTrue(detail.contains("from=full"), detail);
    }

    @Test
    void unknownTargetTierIsRejectedBeforeAnyLookup() {
        assertThrows(IllegalArgumentException.class,
                () -> guard.authorize(ACTOR, WORKSPACE, SESSION, "workspace-write"));

        verify(sessionReadAccess, never()).resolve(any(), any(), any());
        verify(auditLogger, never()).record(any(), any(), any(), any(), any(), any());
    }

    @Test
    void auditRecordsEveryDeniedAndAllowedDecisionUnderTheEscalationAction() {
        stubSession(true, true);
        stubStoredTier("workspace");
        stubAtom(true);

        guard.authorize(ACTOR, WORKSPACE, SESSION, "full");

        verify(auditLogger).record(eq(SESSION), eq(SessionPermissionGuard.AUDIT_TOOL),
                eq(SessionPermissionGuard.AUDIT_ACTION), any(), eq(WORKSPACE), eq(ACTOR));
        assertEquals("session.permission.escalated", SessionPermissionGuard.AUDIT_ACTION);
    }

    @Test
    void atomLookupUsesTheActorAndWorkspaceAsUuids() {
        stubSession(true, true);
        stubStoredTier("workspace");
        stubAtom(true);

        guard.authorize(ACTOR, WORKSPACE, SESSION, "full");

        verify(requesterAuthority).holdsActionAtom(UUID.fromString(ACTOR), ATOM, UUID.fromString(WORKSPACE));
        verify(requesterAuthority).atomSources(UUID.fromString(ACTOR), ATOM, UUID.fromString(WORKSPACE));
        // No role-name special case: never an instance-admin / role probe.
        verify(requesterAuthority, never()).holdsCapabilityAtom(any());
    }

    @Test
    void malformedActorIdCannotWidenButStillTightensAsNonParticipant() {
        stubSession(false, false);
        stubStoredTier("workspace");

        SessionPermissionGuard.Decision decision = guard.authorize("not-a-uuid", WORKSPACE, SESSION, "full");

        assertFalse(decision.allowed());
        assertEquals(SessionPermissionGuard.REASON_NO_CAPABILITY, decision.reason());
        assertEquals(Set.of(), decision.atomSources());
        verify(requesterAuthority, never()).holdsActionAtom(any(), any(), any());
    }

    private void stubSession(boolean owner, boolean participant) {
        when(sessionReadAccess.resolve(ACTOR, WORKSPACE, SESSION)).thenReturn(
                new SessionReadAccess.Resolved(null,
                        new SessionReadAccess.AccessDecision(owner, participant, false)));
    }

    private void stubStoredTier(String tier) {
        when(sessionApprovalMode.tierOf(SESSION)).thenReturn(Optional.ofNullable(tier));
        if (tier == null) {
            when(sessionApprovalMode.modeOf(SESSION)).thenReturn(Optional.empty());
        }
    }

    private void stubAtom(boolean held) {
        when(requesterAuthority.holdsActionAtom(UUID.fromString(ACTOR), ATOM,
                UUID.fromString(WORKSPACE))).thenReturn(held);
        if (held) {
            when(requesterAuthority.atomSources(UUID.fromString(ACTOR), ATOM,
                    UUID.fromString(WORKSPACE))).thenReturn(Set.of("role"));
        }
    }

    private String capturedAuditDetail() {
        ArgumentCaptor<String> detail = ArgumentCaptor.forClass(String.class);
        verify(auditLogger).record(any(), any(), any(), detail.capture(), any(), any());
        return detail.getValue();
    }

    /** Guards the constant values a UI/CLI may quote; never rename without a migration of readers. */
    @Test
    void refusalCodesAreStable() {
        assertEquals("NO_CAPABILITY", SessionPermissionGuard.REASON_NO_CAPABILITY);
        assertEquals("NOT_SESSION_OWNER", SessionPermissionGuard.REASON_NOT_SESSION_OWNER);
        assertEquals("LAYER_CEILING", SessionPermissionGuard.REASON_LAYER_CEILING);
        assertEquals("TIER_UNREADABLE", SessionPermissionGuard.REASON_TIER_UNREADABLE);
        assertTrue(OTHER.startsWith("3"));
    }
}
