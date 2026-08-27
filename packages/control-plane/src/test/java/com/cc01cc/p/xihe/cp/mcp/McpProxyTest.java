package com.cc01cc.p.xihe.cp.mcp;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class McpProxyTest {

    private RequestRewriter requestRewriter;
    private PolicyEngine policyEngine;
    private AuditLogger auditLogger;
    private ObjectMapper objectMapper;
    private SseEmitterManager sseEmitterManager;
    private ConfigJpaRepository configRepo;
    private McpProxyController controller;

    @BeforeEach
    void setUp() {
        requestRewriter = mock(RequestRewriter.class);
        policyEngine = mock(PolicyEngine.class);
        auditLogger = mock(AuditLogger.class);
        objectMapper = new ObjectMapper();
        sseEmitterManager = mock(SseEmitterManager.class);
        configRepo = mock(ConfigJpaRepository.class);

        controller = new McpProxyController(
                requestRewriter, policyEngine,
                auditLogger, objectMapper, sseEmitterManager, configRepo
        );
        ReflectionTestUtils.setField(controller, "runtimeBaseUrl", "http://localhost:9091");

        when(policyEngine.evaluate(anyString(), anyString(), anyString()))
                .thenReturn(PolicyEngine.PolicyDecision.allow());
    }

    @Test
    void extractMethod_parsesJsonRpcMethod() {
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{},\"id\":1}";
        String method = (String) ReflectionTestUtils.invokeMethod(controller, "extractMethod", body);
        assertEquals("tools/call", method);
    }

    @Test
    void extractMethod_returnsEmptyForInvalidJson() {
        String method = (String) ReflectionTestUtils.invokeMethod(controller, "extractMethod", "invalid");
        assertEquals("", method);
    }

    @Test
    void extractToolName_parsesFromToolsCall() {
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"read_file\"},\"id\":1}";
        String name = (String) ReflectionTestUtils.invokeMethod(controller, "extractToolName", body);
        assertEquals("read_file", name);
    }

    @Test
    void extractToolName_returnsNullForNonToolsCall() {
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"initialize\",\"params\":{},\"id\":1}";
        String name = (String) ReflectionTestUtils.invokeMethod(controller, "extractToolName", body);
        assertNull(name);
    }

    @Test
    void extractSessionId_doesNotReuseBearerToken() {
        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.set("Authorization", "Bearer test-token-123");
        String sessionId = (String) ReflectionTestUtils.invokeMethod(controller, "extractSessionId", headers);
        assertTrue(sessionId.startsWith("default-"));
    }

    @Test
    void policyDecision_allow_returnsCorrectResult() {
        PolicyEngine.PolicyDecision decision = PolicyEngine.PolicyDecision.allow();
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.ALLOW, decision.getResult());
    }

    @Test
    void policyDecision_deny_returnsCorrectResult() {
        PolicyEngine.PolicyDecision decision = PolicyEngine.PolicyDecision.deny("not allowed");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.DENY, decision.getResult());
        assertEquals("not allowed", decision.getReason());
    }

    @Test
    void signSessionId_producesValidSignature() {
        String signed = (String) ReflectionTestUtils.invokeMethod(controller, "signSessionId", "ws-1", "jwt-token");
        assertNotNull(signed);
        assertTrue(signed.contains("."), "HMAC-signed session-id must contain '.' separator");
        String[] parts = signed.split("\\.");
        assertEquals(2, parts.length);
        assertFalse(parts[0].isEmpty());
        assertFalse(parts[1].isEmpty());
    }

    @Test
    void signThenVerify_roundTrip_returnsWsId() {
        String signed = (String) ReflectionTestUtils.invokeMethod(controller, "signSessionId", "ws-42", "auth-token");
        String wsId = (String) ReflectionTestUtils.invokeMethod(controller, "verifySessionId", signed);
        assertEquals("ws-42", wsId);
    }

    @Test
    void verifySessionId_rejectsTamperedPayload() throws Exception {
        String signed = (String) ReflectionTestUtils.invokeMethod(controller, "signSessionId", "ws-1", "token");
        // Tamper: replace payload with re-encoded "ws-2:token:0" but keep old signature
        String[] parts = signed.split("\\.");
        String tamperedPayload = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString("ws-2:token:0".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String tampered = tamperedPayload + "." + parts[1];
        String wsId = (String) ReflectionTestUtils.invokeMethod(controller, "verifySessionId", tampered);
        assertNull(wsId, "Tampered session-id must be rejected");
    }

    @Test
    void verifySessionId_rejectsInvalidFormat() {
        String wsId = (String) ReflectionTestUtils.invokeMethod(controller, "verifySessionId", "no-dot-separator");
        assertNull(wsId);
    }

    @Test
    void verifySessionId_rejectsEmptyString() {
        String wsId = (String) ReflectionTestUtils.invokeMethod(controller, "verifySessionId", "");
        assertNull(wsId);
    }

    @Test
    void extractWorkspaceId_prefersSignedSessionId() {
        String signed = (String) ReflectionTestUtils.invokeMethod(controller, "signSessionId", "ws-signed", "token");
        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.set("mcp-session-id", signed);
        headers.set("X-Workspace-Id", "ws-header-fallback");

        String wsId = (String) ReflectionTestUtils.invokeMethod(controller, "extractWorkspaceId", headers, "session");
        assertEquals("ws-signed", wsId, "Signed session-id must take precedence over header");
    }

    @Test
    void extractWorkspaceId_fallsBackToHeaderWhenNoSignature() {
        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.set("X-Workspace-Id", "ws-header");

        String wsId = (String) ReflectionTestUtils.invokeMethod(controller, "extractWorkspaceId", headers, "session");
        assertEquals("ws-header", wsId);
    }
}
