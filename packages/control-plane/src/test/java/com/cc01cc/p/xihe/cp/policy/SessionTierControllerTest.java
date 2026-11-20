package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.SessionService;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * task-83 / D-1488: the session tier read/write face the UI has been calling since task-107.
 *
 * <p>The controller owns no authorization logic: the read face is {@code requireReadable} and every
 * permission answer comes from {@link SessionPermissionGuard}. These tests pin the six-key contract
 * (a seventh key or a missing one is a violation, not a nicety), the three UI deny reasons, the
 * fail-closed read that must stay a 200, and the fact that a read never takes the audited write
 * path.</p>
 */
class SessionTierControllerTest {

    private static final String USER = "u1";
    private static final String WORKSPACE = "ws1";
    private static final String SESSION = "11111111-1111-1111-1111-111111111111";
    private static final Set<String> CONTRACT_KEYS =
            Set.of("tier", "source", "workspaceTier", "canConfigure", "denyReason", "available");

    private final SessionService sessionService = mock(SessionService.class);
    private final SessionApprovalMode sessionApprovalMode = mock(SessionApprovalMode.class);
    private final SessionPermissionGuard permissionGuard = mock(SessionPermissionGuard.class);
    private final PolicyContextProvider contextProvider = mock(PolicyContextProvider.class);
    private final SessionTierController controller = new SessionTierController(
            sessionService, sessionApprovalMode, permissionGuard, contextProvider);

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    private void tenant() {
        TenantContext.setUserId(USER);
        TenantContext.setWorkspaceId(WORKSPACE);
    }

    private static PolicyContext context(String tier, PolicyLayer layer, String fallback) {
        return new PolicyContext(Map.of(), null, null, null, null, null, tier, layer, fallback);
    }

    private static SessionPermissionGuard.Decision allow() {
        return new SessionPermissionGuard.Decision(true, null, null, "full", false, false, Set.of());
    }

    private static SessionPermissionGuard.Decision deny(String reason) {
        return new SessionPermissionGuard.Decision(false, reason, "workspace", "full", false, false,
                Set.of());
    }

    private static Map<?, ?> body(ResponseEntity<?> response) {
        return (Map<?, ?>) response.getBody();
    }

    private void readable() {
        tenant();
        when(sessionService.requireReadable(SESSION, USER, WORKSPACE)).thenReturn(null);
    }

    // --- 正1: the six-key contract and its vocabularies ---------------------------------------

    @Test
    void getTierReturnsExactlyTheSixContractKeys() {
        readable();
        when(contextProvider.load(USER, WORKSPACE, SESSION))
                .thenReturn(context("workspace", PolicyLayer.SESSION, null));
        when(permissionGuard.preview(USER, WORKSPACE, SESSION, SessionPermissionTier.FULL))
                .thenReturn(allow());

        ResponseEntity<?> response = controller.getTier(SESSION);

        assertEquals(HttpStatus.OK.value(), response.getStatusCode().value());
        Map<?, ?> payload = body(response);
        // Exactly six keys: a seventh key (workspaceTiers, mode, ...) is a contract violation, and
        // a missing one makes the UI's normalizeSessionTierState throw "Invalid session tier
        // response". Set equality pins both directions.
        assertEquals(CONTRACT_KEYS, payload.keySet());
        assertEquals("workspace", payload.get("tier"));
        assertEquals("session", payload.get("source"));
        assertNull(payload.get("workspaceTier"));
        assertEquals(true, payload.get("canConfigure"));
        assertNull(payload.get("denyReason"));
        assertEquals(List.of("view", "workspace", "full"), payload.get("available"));
        // Ordering matters to humans reading the JSON, not to the UI: it follows the UI type.
        assertEquals(List.of("tier", "source", "workspaceTier", "canConfigure", "denyReason",
                "available"), List.copyOf(((LinkedHashMap<?, ?>) payload).keySet()));
    }

    @Test
    void inheritedWorkspaceTierReportsTheWorkspaceSource() {
        readable();
        when(contextProvider.load(USER, WORKSPACE, SESSION))
                .thenReturn(context("full", PolicyLayer.WORKSPACE, null));
        when(permissionGuard.preview(USER, WORKSPACE, SESSION, SessionPermissionTier.FULL))
                .thenReturn(deny(SessionPermissionGuard.REASON_NO_CAPABILITY));

        ResponseEntity<?> response = controller.getTier(SESSION);

        Map<?, ?> payload = body(response);
        assertEquals("full", payload.get("tier"));
        assertEquals("workspace", payload.get("source"));
        // 反2 at read time: an atom-less caller still sees the tier but cannot pick one.
        assertEquals(false, payload.get("canConfigure"));
        assertEquals("no-atom", payload.get("denyReason"));
    }

    @Test
    void nonOwnerCallerGetsNotOwnerAsTheDenyReason() {
        readable();
        when(contextProvider.load(USER, WORKSPACE, SESSION))
                .thenReturn(context("view", PolicyLayer.SESSION, null));
        when(permissionGuard.preview(USER, WORKSPACE, SESSION, SessionPermissionTier.FULL))
                .thenReturn(deny(SessionPermissionGuard.REASON_NOT_SESSION_OWNER));

        Map<?, ?> payload = body(controller.getTier(SESSION));

        assertEquals(false, payload.get("canConfigure"));
        assertEquals("not-owner", payload.get("denyReason"));
        // The tier itself is still readable: denyReason only governs the write control.
        assertEquals("view", payload.get("tier"));
    }

    // --- 正2: the write path reuses the guard and lets the service derive the mode ------------

    @Test
    void patchTierWritesTheTierAndReturnsTheSixKeyState() {
        tenant();
        when(permissionGuard.authorize(USER, WORKSPACE, SESSION, "workspace")).thenReturn(allow());
        when(contextProvider.load(USER, WORKSPACE, SESSION))
                .thenReturn(context("workspace", PolicyLayer.SESSION, null));
        when(permissionGuard.preview(USER, WORKSPACE, SESSION, SessionPermissionTier.FULL))
                .thenReturn(allow());

        ResponseEntity<?> response = controller.setTier(SESSION, Map.of("tier", "workspace"));

        assertEquals(HttpStatus.OK.value(), response.getStatusCode().value());
        assertEquals(CONTRACT_KEYS, body(response).keySet());
        assertEquals("workspace", body(response).get("tier"));
        assertEquals("session", body(response).get("source"));
        // The controller never writes approval_mode itself: SessionApprovalMode.setTier derives it
        // (view/workspace -> manual, full -> auto) so the two columns cannot drift.
        verify(sessionApprovalMode).setTier(SESSION, "workspace");
        verify(sessionApprovalMode, never()).setMode(anyString(), anyString());
    }

    // --- 反1/反2/反3: the refusals and the fail-closed read ---------------------------------

    @Test
    void refusingANonOwnerWideningIsA403CarryingTheUiDenyReason() {
        tenant();
        when(permissionGuard.authorize(USER, WORKSPACE, SESSION, "full"))
                .thenReturn(deny(SessionPermissionGuard.REASON_NOT_SESSION_OWNER));

        ResponseEntity<?> response = controller.setTier(SESSION, Map.of("tier", "full"));

        assertEquals(HttpStatus.FORBIDDEN.value(), response.getStatusCode().value());
        Map<?, ?> payload = body(response);
        // The contract code stays the guard's code; denyReason is the UI's vocabulary.
        assertEquals(SessionPermissionGuard.REASON_NOT_SESSION_OWNER, payload.get("code"));
        assertEquals("not-owner", payload.get("denyReason"));
        verify(sessionApprovalMode, never()).setTier(anyString(), anyString());
    }

    @Test
    void refusingAWideningWithoutTheAtomIsA403NoAtom() {
        tenant();
        when(permissionGuard.authorize(USER, WORKSPACE, SESSION, "full"))
                .thenReturn(deny(SessionPermissionGuard.REASON_NO_CAPABILITY));

        ResponseEntity<?> response = controller.setTier(SESSION, Map.of("tier", "full"));

        assertEquals(HttpStatus.FORBIDDEN.value(), response.getStatusCode().value());
        assertEquals("no-atom", body(response).get("denyReason"));
        verify(sessionApprovalMode, never()).setTier(anyString(), anyString());
    }

    @Test
    void unreadableTierStillAnswers200WithTheFailClosedTierAndViewerDenyReason() {
        readable();
        // DbPolicyContextProvider's fail-closed shape: forced view, INSTANCE layer, fallback marker.
        when(contextProvider.load(USER, WORKSPACE, SESSION)).thenReturn(context("view",
                PolicyLayer.INSTANCE, SessionPermissionTier.FALLBACK_SESSION_READ_FAILED));
        // A probe over an unreadable tier refuses (fail-closed) — it must not blow up the read face.
        when(permissionGuard.preview(USER, WORKSPACE, SESSION, SessionPermissionTier.FULL))
                .thenThrow(new IllegalStateException("session tier unreadable"));

        ResponseEntity<?> response = controller.getTier(SESSION);

        assertEquals(HttpStatus.OK.value(), response.getStatusCode().value());
        assertEquals(CONTRACT_KEYS, body(response).keySet());
        assertEquals("view", body(response).get("tier"));
        // No layer supplied this value: a forced tier must not be attributed to the workspace.
        assertEquals("none", body(response).get("source"));
        assertEquals(false, body(response).get("canConfigure"));
        assertEquals("viewer", body(response).get("denyReason"));
    }

    @Test
    void aReadNeverTakesTheAuditedWritePath() {
        readable();
        when(contextProvider.load(USER, WORKSPACE, SESSION))
                .thenReturn(context("workspace", PolicyLayer.SESSION, null));
        when(permissionGuard.preview(USER, WORKSPACE, SESSION, SessionPermissionTier.FULL))
                .thenReturn(allow());

        controller.getTier(SESSION);

        // GET answers "could this caller widen?" through preview, which writes no audit record;
        // the write path (one session.permission.escalated row per call) is only for PATCH.
        verify(permissionGuard, never()).authorize(any(), any(), any(), any());
        verify(permissionGuard).preview(USER, WORKSPACE, SESSION, SessionPermissionTier.FULL);
    }

    // --- 反5: the controller does not authorize on its own ------------------------------------

    @Test
    void theControllerAsksTheGuardInsteadOfDecidingByItself() {
        tenant();
        when(permissionGuard.authorize(USER, WORKSPACE, SESSION, "workspace")).thenReturn(deny(
                SessionPermissionGuard.REASON_NO_CAPABILITY));

        ResponseEntity<?> response = controller.setTier(SESSION, Map.of("tier", "workspace"));

        // A hand-rolled check (workspace role, owner column, requester authority) would have let
        // an owner through here: only the guard's refusal produces this 403.
        assertEquals(HttpStatus.FORBIDDEN.value(), response.getStatusCode().value());
        assertEquals("no-atom", body(response).get("denyReason"));
        verify(permissionGuard).authorize(USER, WORKSPACE, SESSION, "workspace");
        verify(sessionApprovalMode, never()).setTier(anyString(), anyString());
    }

    // --- shape guards ------------------------------------------------------------------------

    @Test
    void anUnknownTierIsA400FromTheGuardNotFromALocalVocabulary() {
        tenant();
        // The controller owns no tier vocabulary: an unknown value must reach the guard, which
        // rejects it (this is the same 400 POST /api/v1/policy/mode produces).
        when(permissionGuard.authorize(USER, WORKSPACE, SESSION, "workspace-write")).thenThrow(
                new IllegalArgumentException("unsupported permission tier: workspace-write"));

        ResponseEntity<?> response = controller.setTier(SESSION, Map.of("tier", "workspace-write"));

        assertEquals(HttpStatus.BAD_REQUEST.value(), response.getStatusCode().value());
        assertEquals("INVALID_REQUEST", body(response).get("code"));
        verify(permissionGuard).authorize(USER, WORKSPACE, SESSION, "workspace-write");
        verify(sessionApprovalMode, never()).setTier(anyString(), anyString());
    }

    @Test
    void aMissingTierIsA400() {
        tenant();

        ResponseEntity<?> response = controller.setTier(SESSION, Map.of());

        assertEquals(HttpStatus.BAD_REQUEST.value(), response.getStatusCode().value());
        assertEquals("INVALID_REQUEST", body(response).get("code"));
        verify(permissionGuard, never()).authorize(any(), any(), any(), any());
    }

    @Test
    void anUnreadableSessionStaysA404OnTheReadFace() {
        tenant();
        when(sessionService.requireReadable(SESSION, USER, WORKSPACE)).thenThrow(
                new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));

        ResponseEntity<?> response = controller.getTier(SESSION);

        assertEquals(HttpStatus.NOT_FOUND.value(), response.getStatusCode().value());
        assertEquals("SESSION_NOT_FOUND", body(response).get("code"));
        verify(permissionGuard, never()).preview(any(), any(), any(), any());
    }

    @Test
    void aMissingWorkspaceContextIsA409OnTheWriteFace() {
        TenantContext.setUserId(USER);

        ResponseEntity<?> response = controller.setTier(SESSION, Map.of("tier", "view"));

        assertEquals(HttpStatus.CONFLICT.value(), response.getStatusCode().value());
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", body(response).get("code"));
        verify(permissionGuard, never()).authorize(any(), any(), any(), any());
    }

    @Test
    void theAvailableSetIsTheWholeVocabularyUntilTask107bLands() {
        readable();
        when(contextProvider.load(USER, WORKSPACE, SESSION))
                .thenReturn(context("view", PolicyLayer.SESSION, null));
        when(permissionGuard.preview(USER, WORKSPACE, SESSION, SessionPermissionTier.FULL))
                .thenReturn(allow());

        Map<?, ?> payload = body(controller.getTier(SESSION));

        // No workspace-layer ceiling exists yet (task-107b owns it), so nothing is filtered out;
        // the guard's own verdict still governs whether the control is usable.
        assertEquals(List.of("view", "workspace", "full"), payload.get("available"));
    }

    @Test
    void denialWithoutAGuardReasonFailsClosedToTheViewerValue() {
        assertNull(SessionTierController.denyReasonOf(allow()));
        assertEquals("no-atom", SessionTierController.denyReasonOf(deny(
                SessionPermissionGuard.REASON_NO_CAPABILITY)));
        assertEquals("not-owner", SessionTierController.denyReasonOf(deny(
                SessionPermissionGuard.REASON_NOT_SESSION_OWNER)));
        assertEquals("viewer", SessionTierController.denyReasonOf(deny(
                SessionPermissionGuard.REASON_TIER_UNREADABLE)));
        // A reason added later must not silently map to "you may configure".
        assertEquals("viewer", SessionTierController.denyReasonOf(deny("SOMETHING_NEW")));
    }
}
