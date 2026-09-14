package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.SessionService;
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
    private final SessionService sessionService = mock(SessionService.class);
    private final PolicyController controller = new PolicyController(
            ruleService, faceService, sessionState, sessionService);

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void getModeChecksSessionOwnership() {
        TenantContext.setUserId("u1");
        TenantContext.setWorkspaceId("ws1");
        when(sessionState.modeOf("s1")).thenReturn(Optional.of("bypass"));
        when(sessionState.rulesOf("s1")).thenReturn(List.of());

        ResponseEntity<?> response = controller.getMode("s1");

        verify(sessionService).requireCurrent("s1", "u1", "ws1");
        assertEquals(200, response.getStatusCode().value());
        assertEquals("bypass", ((Map<?, ?>) response.getBody()).get("mode"));
    }

    @Test
    void setModeChecksSessionOwnership() {
        TenantContext.setUserId("u1");
        TenantContext.setWorkspaceId("ws1");

        ResponseEntity<?> response = controller.setMode(Map.of("sessionId", "s1", "mode", "bypass"));

        verify(sessionService).requireCurrent("s1", "u1", "ws1");
        verify(sessionState).setMode("s1", "bypass");
        assertEquals(200, response.getStatusCode().value());
        assertEquals("session", ((Map<?, ?>) response.getBody()).get("scope"));
    }

    @Test
    void modeMapsMissingSessionTo404() {
        TenantContext.setUserId("u1");
        TenantContext.setWorkspaceId("ws1");
        when(sessionService.requireCurrent("s1", "u1", "ws1"))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));

        ResponseEntity<?> get = controller.getMode("s1");
        assertEquals(404, get.getStatusCode().value());
        assertEquals("SESSION_NOT_FOUND", ((Map<?, ?>) get.getBody()).get("code"));

        ResponseEntity<?> set = controller.setMode(Map.of("sessionId", "s1", "mode", "default"));
        assertEquals(404, set.getStatusCode().value());
        assertEquals("SESSION_NOT_FOUND", ((Map<?, ?>) set.getBody()).get("code"));
    }

    @Test
    void modeRequiresWorkspaceContext() {
        TenantContext.setUserId("u1");

        ResponseEntity<?> get = controller.getMode("s1");
        assertEquals(401, get.getStatusCode().value());
        assertEquals("AUTHORIZATION_REQUIRED", ((Map<?, ?>) get.getBody()).get("code"));

        ResponseEntity<?> set = controller.setMode(Map.of("sessionId", "s1", "mode", "default"));
        assertEquals(401, set.getStatusCode().value());
        assertEquals("AUTHORIZATION_REQUIRED", ((Map<?, ?>) set.getBody()).get("code"));

        verify(sessionService, never()).requireCurrent(any(), any(), any());
    }
}
