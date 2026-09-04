package com.cc01cc.p.xihe.cp.mcp;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;

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
    private McpServerRepository mcpServerRepository;
    private McpToolAliasRepository aliasRepository;
    private WorkspaceService workspaceService;
    private SessionRepository sessionRepository;
    private McpProxyController controller;

    @BeforeEach
    void setUp() {
        requestRewriter = mock(RequestRewriter.class);
        policyEngine = mock(PolicyEngine.class);
        auditLogger = mock(AuditLogger.class);
        objectMapper = new ObjectMapper();
        sseEmitterManager = mock(SseEmitterManager.class);
        configRepo = mock(ConfigJpaRepository.class);
        mcpServerRepository = mock(McpServerRepository.class);
        aliasRepository = mock(McpToolAliasRepository.class);
        workspaceService = mock(WorkspaceService.class);
        sessionRepository = mock(SessionRepository.class);

        controller = new McpProxyController(
                requestRewriter, policyEngine,
                auditLogger, objectMapper, sseEmitterManager, configRepo,
                mcpServerRepository, aliasRepository,
                workspaceService, sessionRepository
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

    // PLAN-242 M2: three-way split — table-backed serverIds take the remote
    // path, unknown ids fall back to the stdio path. No live Runtime here, so
    // both assert the deterministic unreachable-Runtime failure per branch.
    @Test
    @SuppressWarnings("unchecked")
    void forwardToRuntime_remoteServer_usesRemotePath() throws Exception {
        com.cc01cc.p.xihe.cp.entity.McpServer server =
                new com.cc01cc.p.xihe.cp.entity.McpServer("ws-1", "deepwiki", "https://mcp.deepwiki.com/mcp");
        server.setId("deepwiki");
        server.setEnabled(true);
        when(mcpServerRepository.findById("deepwiki")).thenReturn(java.util.Optional.of(server));

        Object access = accessContext("ws-1", "u-1");
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1,\"params\":{}}";
        org.springframework.http.ResponseEntity<String> resp =
                (org.springframework.http.ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                        controller, "forwardToRuntime", "ws-1", "deepwiki", body,
                        new org.springframework.http.HttpHeaders(), "sess-1", access);
        assertNotNull(resp);
        assertTrue(resp.getBody().contains("REMOTE_MCP_UNAVAILABLE"),
                "table-backed serverId must take the remote branch, got: " + resp.getBody());
    }

    @Test
    @SuppressWarnings("unchecked")
    void forwardToRuntime_unknownServer_fallsBackToStdioPath() throws Exception {
        when(mcpServerRepository.findById("ghost")).thenReturn(java.util.Optional.empty());

        Object access = accessContext("ws-1", "u-1");
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1,\"params\":{}}";
        org.springframework.http.ResponseEntity<String> resp =
                (org.springframework.http.ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                        controller, "forwardToRuntime", "ws-1", "ghost", body,
                        new org.springframework.http.HttpHeaders(), "sess-1", access);
        assertNotNull(resp);
        assertTrue(resp.getBody().contains("RUNTIME_UNAVAILABLE"),
                "unknown serverId must fall back to the stdio branch, got: " + resp.getBody());
    }

    private static Object accessContext(String wsId, String userId) throws Exception {
        Class<?> accessClass = Class.forName(
                "com.cc01cc.p.xihe.cp.mcp.McpProxyController$AccessContext");
        var constructor = accessClass.getDeclaredConstructor(
                String.class, String.class, String.class, String.class);
        constructor.setAccessible(true);
        return constructor.newInstance(wsId, userId, null, null);
    }

    @Test
    void verifySessionId_rejectsEmptyString() {
        String wsId = (String) ReflectionTestUtils.invokeMethod(controller, "verifySessionId", "");
        assertNull(wsId);
    }

}
