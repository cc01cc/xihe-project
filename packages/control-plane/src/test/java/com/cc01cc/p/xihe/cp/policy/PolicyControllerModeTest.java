package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.SessionService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/** PLAN-0328 M1: session-mode ownership gate — requireCurrent must precede any mode read/write. */
class PolicyControllerModeTest {

    private final PolicyRuleService ruleService = mock(PolicyRuleService.class);
    private final ToolFaceService faceService = mock(ToolFaceService.class);
    private final SessionPolicyState sessionState = mock(SessionPolicyState.class);
    private final SessionApprovalMode sessionApprovalMode = mock(SessionApprovalMode.class);
    private final SessionService sessionService = mock(SessionService.class);
    private final RequesterAuthority requesterAuthority = mock(RequesterAuthority.class);
    private final PolicyController controller = new PolicyController(
            ruleService, faceService, sessionState, sessionApprovalMode, sessionService, requesterAuthority);

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void getModeChecksSessionOwnership() {
        TenantContext.setUserId("u1");
        TenantContext.setWorkspaceId("ws1");
        when(sessionState.snapshot("s1"))
                .thenReturn(Optional.of(new SessionPolicyState.Entry(List.of(), Instant.now())));
        when(sessionApprovalMode.modeOf("s1")).thenReturn(Optional.of("auto"));

        ResponseEntity<?> response = controller.getMode("s1");

        // BL-299: GET /policy/mode is the read face — it uses requireReadable (owner or invited
        // HUMAN), while setMode below keeps the owner-only requireCurrent. The old verification
        // predates BL-299 and was the only stale assertion in this class.
        verify(sessionService).requireReadable("s1", "u1", "ws1");
        assertEquals(200, response.getStatusCode().value());
        assertEquals("auto", ((Map<?, ?>) response.getBody()).get("mode"));
    }

    @Test
    void setModeChecksSessionOwnership() {
        TenantContext.setUserId("u1");
        TenantContext.setWorkspaceId("ws1");

        ResponseEntity<?> response = controller.setMode(Map.of("sessionId", "s1", "mode", "auto"));

        verify(sessionService).requireCurrent("s1", "u1", "ws1");
        verify(sessionApprovalMode).setMode("s1", "auto");
        assertEquals(200, response.getStatusCode().value());
        assertEquals("session", ((Map<?, ?>) response.getBody()).get("scope"));
    }

    @Test
    void modeMapsMissingSessionTo404() {
        TenantContext.setUserId("u1");
        TenantContext.setWorkspaceId("ws1");
        when(sessionService.requireReadable("s1", "u1", "ws1"))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
        when(sessionService.requireCurrent("s1", "u1", "ws1"))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));

        ResponseEntity<?> get = controller.getMode("s1");
        assertEquals(404, get.getStatusCode().value());
        assertEquals("SESSION_NOT_FOUND", ((Map<?, ?>) get.getBody()).get("code"));

        ResponseEntity<?> set = controller.setMode(Map.of("sessionId", "s1", "mode", "yolo"));
        assertEquals(404, set.getStatusCode().value());
        assertEquals("SESSION_NOT_FOUND", ((Map<?, ?>) set.getBody()).get("code"));
    }

    @Test
    void modeRequiresWorkspaceContext() {
        TenantContext.setUserId("u1");

        // BL-181: missing workspace context is a conflict with the account state (409), never 401 —
        // the caller is authenticated, and a 401 makes the UI force a logout.
        ResponseEntity<?> get = controller.getMode("s1");
        assertEquals(409, get.getStatusCode().value());
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", ((Map<?, ?>) get.getBody()).get("code"));

        ResponseEntity<?> set = controller.setMode(Map.of("sessionId", "s1", "mode", "yolo"));
        assertEquals(409, set.getStatusCode().value());
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", ((Map<?, ?>) set.getBody()).get("code"));

        verify(sessionService, never()).requireCurrent(any(), any(), any());
    }

    @Test
    void listFacesUsesTenantContextAndExistingRouteService() {
        TenantContext.setUserId("u1");
        TenantContext.setWorkspaceId("ws1");
        List<ToolFaceService.FaceView> expected = List.of(
                new ToolFaceService.FaceView(null, "builtin", null, "read_file", "read", "structured"));
        when(faceService.list("workspace", "u1", "ws1", false)).thenReturn(expected);

        ResponseEntity<?> response = controller.listFaces("workspace");

        assertEquals(200, response.getStatusCode().value());
        assertSame(expected, response.getBody());
        verify(faceService).list("workspace", "u1", "ws1", false);
    }

    @Test
    void listFacesMapsServiceValidationErrors() {
        when(faceService.list("invalid", null, null, false))
                .thenThrow(new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "bad scope"));

        ResponseEntity<?> response = controller.listFaces("invalid");

        assertEquals(400, response.getStatusCode().value());
        assertEquals("INVALID_REQUEST", ((Map<?, ?>) response.getBody()).get("code"));
    }

    /**
     * PLAN-0651 M3 T3.3 + D-165 (Lead ruling 2026-11-05): A13's admin flag is the N9
     * {@code MANAGE_WORKSPACE_POLICY} atom (instance-scope evaluation), NOT {@code MANAGE_ROLES}
     * (that shared atom also gates role/binding administration and is deliberately not granted to
     * ADMIN). This pins that the resolved flag is what the service receives.
     */
    @Test
    void listFacesPassesTheInstancePolicyAtomAsTheAdminFlag() {
        when(requesterAuthority.holdsActionAtom(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY))
                .thenReturn(true);
        List<ToolFaceService.FaceView> expected = List.of(
                new ToolFaceService.FaceView(null, "builtin", null, "read_file", "read", "structured"));
        when(faceService.list("workspace", null, null, true)).thenReturn(expected);

        ResponseEntity<?> response = controller.listFaces("workspace");

        assertEquals(200, response.getStatusCode().value());
        assertSame(expected, response.getBody());
        verify(faceService).list("workspace", null, null, true);
    }
}
