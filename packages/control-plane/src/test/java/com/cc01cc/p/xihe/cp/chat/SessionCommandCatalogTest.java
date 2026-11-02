package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import org.junit.jupiter.api.Test;

import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0635 M3 (D35-02 ruling A): registry availability is decided on the server, reusing the
 * ordinary policy engine through an existing tool face as a carrier.
 *
 * <p>Two availability states are pinned here (available / not available) for both built-in
 * commands, plus the four reasons the UI must render instead of hiding a command.
 */
class SessionCommandCatalogTest {
    private static final String SESSION = UUID.randomUUID().toString();
    private static final String USER = UUID.randomUUID().toString();
    private static final String WORKSPACE = UUID.randomUUID().toString();

    private final PolicyEngine policy = mock(PolicyEngine.class);
    private final ChatActiveRunRegistry activeRuns = mock(ChatActiveRunRegistry.class);
    private final SessionCommandCatalog catalog = new SessionCommandCatalog(policy, activeRuns);

    private void verdictIs(PolicyEffect effect) {
        when(policy.loadContext(USER, WORKSPACE, SESSION)).thenReturn(PolicyContext.EMPTY);
        when(policy.evaluateVerdict(any(), anyString(), anyString(), eq(SESSION), isNull(), eq(USER), eq(WORKSPACE)))
                .thenReturn(PolicyVerdict.of(effect, null, PolicyLayer.BUILTIN, "manual", "test"));
    }

    private SessionCommandCatalog.CommandView view(List<SessionCommandCatalog.CommandView> views, String name) {
        return views.stream().filter(view -> view.name().equals(name)).findFirst().orElseThrow();
    }

    @Test
    void allowsExportWhenPolicyAllows() {
        verdictIs(PolicyEffect.ALLOW);
        when(activeRuns.activeRunId(SESSION)).thenReturn(null);
        SessionCommandCatalog.CommandView export = view(catalog.list(SESSION, USER, WORKSPACE).commands(), "/export");
        assertEquals("builtin", export.source());
        assertTrue(export.available());
        assertNull(export.reason());
    }

    @Test
    void offersAskingExportButMarksItUnavailableWithAReason() {
        // Ruling A: an ask is never hidden — the user must learn the command exists.
        verdictIs(PolicyEffect.ASK);
        when(activeRuns.activeRunId(SESSION)).thenReturn(null);
        SessionCommandCatalog.CommandView export = view(catalog.list(SESSION, USER, WORKSPACE).commands(), "/export");
        assertFalse(export.available());
        assertEquals("approval_required", export.reason());
    }

    @Test
    void marksExportDeniedWhenPolicyDenies() {
        verdictIs(PolicyEffect.DENY);
        when(activeRuns.activeRunId(SESSION)).thenReturn(null);
        SessionCommandCatalog.CommandView export = view(catalog.list(SESSION, USER, WORKSPACE).commands(), "/export");
        assertFalse(export.available());
        assertEquals("denied", export.reason());
    }

    @Test
    void failsClosedWhenThePolicyContextCannotBeRead() {
        when(policy.loadContext(USER, WORKSPACE, SESSION)).thenThrow(new IllegalStateException("config unavailable"));
        when(activeRuns.activeRunId(SESSION)).thenReturn(null);
        SessionCommandCatalog.CommandView export = view(catalog.list(SESSION, USER, WORKSPACE).commands(), "/export");
        assertFalse(export.available());
        assertEquals("policy_unavailable", export.reason());
    }

    @Test
    void mirrorsCompactPreconditionWhileARunIsActive() {
        verdictIs(PolicyEffect.ALLOW);
        when(activeRuns.activeRunId(SESSION)).thenReturn(UUID.randomUUID().toString());
        SessionCommandCatalog.CommandView compact = view(catalog.list(SESSION, USER, WORKSPACE).commands(), "/compact");
        assertFalse(compact.available());
        assertEquals("branch_locked", compact.reason());
    }

    @Test
    void offersCompactWhenNoRunIsActive() {
        verdictIs(PolicyEffect.ALLOW);
        when(activeRuns.activeRunId(SESSION)).thenReturn(null);
        SessionCommandCatalog.CommandView compact = view(catalog.list(SESSION, USER, WORKSPACE).commands(), "/compact");
        assertTrue(compact.available());
        assertNull(compact.reason());
    }

    @Test
    void registryRowsExposeOnlyTheFourAgreedScalars() {
        // Ruling A: the availability carrier (a borrowed tool-face name) must never travel.
        // Pinning the record shape makes an accidental extra field a visible contract change.
        List<String> components = Arrays.stream(SessionCommandCatalog.CommandView.class.getRecordComponents())
                .map(RecordComponent::getName)
                .toList();
        assertEquals(List.of("name", "source", "available", "reason"), components);
    }

    @Test
    void listsBothBuiltinCommandsInStableOrder() {
        verdictIs(PolicyEffect.ALLOW);
        when(activeRuns.activeRunId(SESSION)).thenReturn(null);
        List<String> names = catalog.list(SESSION, USER, WORKSPACE).commands().stream()
                .map(SessionCommandCatalog.CommandView::name)
                .toList();
        assertEquals(List.of("/export", "/compact"), names);
    }

    @Test
    void compactAvailabilitySharesTheEndpointsSingleSource() {
        // D35-10: /compact carries no policy gate; its availability must mirror the existing
        // endpoint preconditions exactly. The compact endpoint (SessionController#compact,
        // POST /api/v1/sessions/{id}/compact) returns 409 BRANCH_LOCK when
        // `activeRunRegistry.activeRunId(sessionId) != null`; the registry therefore has to read
        // the *same* registry instance and report `branch_locked`. If that precondition ever
        // changes, this test is the tripwire asking for the registry row to change with it.
        verdictIs(PolicyEffect.ALLOW);
        when(activeRuns.activeRunId(SESSION)).thenReturn(UUID.randomUUID().toString());

        SessionCommandCatalog.CommandView compact =
                view(catalog.list(SESSION, USER, WORKSPACE).commands(), "/compact");

        verify(activeRuns).activeRunId(SESSION);
        assertFalse(compact.available());
        // Wire reason `branch_locked` is the snake_case rename of the endpoint's 409
        // `BRANCH_LOCK`; asserted literally on both sides of the pair so a rename in either place
        // surfaces here rather than in a user-visible mismatch.
        assertEquals("branch_locked", compact.reason());
        assertEquals("branch_locked", SessionCommandCatalog.REASON_BRANCH_LOCKED);
    }
}
