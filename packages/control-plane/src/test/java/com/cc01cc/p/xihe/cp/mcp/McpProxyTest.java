package com.cc01cc.p.xihe.cp.mcp;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class McpProxyTest {

    static final String TEST_WS_UUID = "66666666-6666-6666-6666-666666666666";

    private RequestRewriter requestRewriter;
    private PolicyEngine policyEngine;
    private AuditLogger auditLogger;
    private ApprovalService approvalService;
    private ObjectMapper objectMapper;
    private SseEmitterManager sseEmitterManager;
    private ConfigJpaRepository configRepo;
    private McpServerRepository mcpServerRepository;
    private McpToolAliasRepository aliasRepository;
    private WorkspaceService workspaceService;
    private SessionRepository sessionRepository;
    private OperationService operationService;
    private McpProxyController controller;

    @BeforeEach
    void setUp() {
        requestRewriter = mock(RequestRewriter.class);
        policyEngine = mock(PolicyEngine.class);
        auditLogger = mock(AuditLogger.class);
        approvalService = mock(ApprovalService.class);
        objectMapper = new ObjectMapper();
        sseEmitterManager = mock(SseEmitterManager.class);
        configRepo = mock(ConfigJpaRepository.class);
        mcpServerRepository = mock(McpServerRepository.class);
        aliasRepository = mock(McpToolAliasRepository.class);
        workspaceService = mock(WorkspaceService.class);
        sessionRepository = mock(SessionRepository.class);
        operationService = mock(OperationService.class);

        controller = new McpProxyController(
                requestRewriter, policyEngine,
                auditLogger, approvalService, objectMapper, sseEmitterManager, configRepo,
                mcpServerRepository, aliasRepository,
                workspaceService, sessionRepository, operationService
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
                new com.cc01cc.p.xihe.cp.entity.McpServer(TEST_WS_UUID, "deepwiki", "https://mcp.deepwiki.com/mcp");
        server.setId(java.util.UUID.nameUUIDFromBytes("deepwiki".getBytes()));
        server.setEnabled(true);
        when(mcpServerRepository.findById(server.getId())).thenReturn(java.util.Optional.of(server));

        Object access = accessContext(TEST_WS_UUID, "u-1");
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1,\"params\":{}}";
        org.springframework.http.ResponseEntity<String> resp =
                (org.springframework.http.ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                        controller, "forwardToRuntime", TEST_WS_UUID, java.util.UUID.nameUUIDFromBytes("deepwiki".getBytes()).toString(), body,
                        new org.springframework.http.HttpHeaders(), "sess-1", access);
        assertNotNull(resp);
        assertTrue(resp.getBody().contains("REMOTE_MCP_UNAVAILABLE"),
                "table-backed serverId must take the remote branch, got: " + resp.getBody());
    }

    @Test
    @SuppressWarnings("unchecked")
    void forwardToRuntime_unknownServer_fallsBackToStdioPath() throws Exception {
        when(mcpServerRepository.findById(java.util.UUID.nameUUIDFromBytes("ghost".getBytes()))).thenReturn(java.util.Optional.empty());

        Object access = accessContext(TEST_WS_UUID, "u-1");
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1,\"params\":{}}";
        org.springframework.http.ResponseEntity<String> resp =
                (org.springframework.http.ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                        controller, "forwardToRuntime", TEST_WS_UUID, "ghost", body,
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

    // PLAN-242 M2.5 (CP 侧 Fake 门): tools/list 合并 remote 工具并落别名，
    // tools/call 按别名以后端名直达 Fake。Runtime 由 JDK 内置 HttpServer 桩承担。
    @Test
    @SuppressWarnings("unchecked")
    void handleToolsList_mergesRemoteToolsAndCallReachesFake() throws Exception {
        when(requestRewriter.rewrite(anyString(), anyString(), anyString()))
                .thenAnswer(inv -> inv.getArgument(1));

        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        stub.createContext("/internal/v1/runtime/remote-mcp/" + TEST_WS_UUID + "/"
                + java.util.UUID.nameUUIDFromBytes("deepwiki".getBytes()) + "/call", exchange -> {
            String req = new String(exchange.getRequestBody().readAllBytes(),
                    java.nio.charset.StandardCharsets.UTF_8);
            String resp = req.contains("\"listTools\":true")
                    ? "{\"tools\":[{\"name\":\"fake_echo\",\"description\":\"Echo\",\"inputSchema\":{\"type\":\"object\"}}]}"
                    : "{\"content\":[{\"type\":\"text\",\"text\":\"wire-ok\"}]}";
            byte[] bytes = resp.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        stub.start();
        try {
            ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                    "http://127.0.0.1:" + stub.getAddress().getPort());

            com.cc01cc.p.xihe.cp.entity.McpServer server =
                    new com.cc01cc.p.xihe.cp.entity.McpServer(
                            TEST_WS_UUID, "deepwiki", "https://mcp.deepwiki.com/mcp");
            server.setId(java.util.UUID.nameUUIDFromBytes("deepwiki".getBytes()));
            server.setEnabled(true);
            server.setAuthMode("no-auth");
            when(mcpServerRepository.findByWorkspaceIdAndEnabledTrue(TEST_WS_UUID))
                    .thenReturn(java.util.List.of(server));
            when(mcpServerRepository.findById(server.getId()))
                    .thenReturn(java.util.Optional.of(server));
            when(configRepo.findByEnvironmentAndLayerAndDomainAndConfigKey(
                    TEST_WS_UUID, "workspace", "mcp", "mcpServers"))
                    .thenReturn(java.util.Optional.empty());
            when(aliasRepository.findByWorkspaceId(java.util.UUID.fromString(TEST_WS_UUID))).thenReturn(java.util.List.of());
            when(aliasRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

            Object access = accessContext(TEST_WS_UUID, "u-1");
            String listBody = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1,\"params\":{}}";
            org.springframework.http.ResponseEntity<String> listResp =
                    (org.springframework.http.ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                            controller, "handleToolsList", TEST_WS_UUID, listBody,
                            new org.springframework.http.HttpHeaders(), "sess-1", access);
            assertNotNull(listResp);
            assertTrue(listResp.getBody().contains("fake_echo"),
                    "merged list must contain the remote tool");
            org.mockito.Mockito.verify(aliasRepository).save(
                    org.mockito.ArgumentMatchers.argThat(a ->
                            "fake_echo".equals(
                                    ((com.cc01cc.p.xihe.cp.entity.McpToolAlias) a).getIssuedName())));

            String callBody = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                    + "\"params\":{\"name\":\"fake_echo\",\"arguments\":{}},\"id\":2}";
            org.springframework.http.ResponseEntity<String> callResp =
                    (org.springframework.http.ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                            controller, "handleToolsCall", TEST_WS_UUID, callBody,
                            new org.springframework.http.HttpHeaders(), "sess-1", access);
            assertNotNull(callResp);
            assertTrue(callResp.getBody().contains("wire-ok"),
                    "remote call must reach Fake, got: " + callResp.getBody());
        } finally {
            stub.stop(0);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void handleToolsCall_requireApproval_failsClosedBeforeRuntimeForward() throws Exception {
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{}},\"id\":7}";
        when(requestRewriter.rewrite(anyString(), eq(body), anyString())).thenReturn(body);
        when(policyEngine.evaluate(eq("write_file"), eq(body), eq("sess-1")))
                .thenReturn(PolicyEngine.PolicyDecision.requireApproval("mutation requires approval"));

        Map<String, Map<String, String>> cache =
                (Map<String, Map<String, String>>) ReflectionTestUtils.getField(controller, "toolServerCache");
        Map<String, Instant> timestamps =
                (Map<String, Instant>) ReflectionTestUtils.getField(controller, "cacheTimestamps");
        cache.put(TEST_WS_UUID, new ConcurrentHashMap<>(Map.of("write_file", "__system__")));
        timestamps.put(TEST_WS_UUID, Instant.now());

        Object access = accessContext(TEST_WS_UUID, "u-1");
        // PLAN-292 fix-up: PLAN-290 B2 lets user-direct calls (no agent headers)
        // bypass the approval gate, so an EMPTY header set no longer 409s. This
        // test guards the Agent path — it must carry the run header like the
        // real Agent does (mcp_client ApprovalMCPInterceptor).
        HttpHeaders agentHeaders = new HttpHeaders();
        agentHeaders.set("X-Chat-Run-Id", TEST_WS_UUID);
        ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                controller, "handleToolsCall", TEST_WS_UUID, body,
                agentHeaders, "sess-1", access);

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertTrue(response.getBody().contains("\"code\":\"APPROVAL_REQUIRED\""));
        verify(sseEmitterManager).send(eq("sess-1"), eq("tool_exec_approval_required"), any());
        verifyNoInteractions(mcpServerRepository);
    }

    @Test
    @SuppressWarnings("unchecked")
    void handleToolsCall_userDirectWorkspaceMutation_bypassesApprovalGate() throws Exception {
        // PLAN-290 B2 / Decision 17: a workspace user mutation without any agent
        // headers is UI-confirmed, not Agent-gated — the gate must let it pass
        // (ledger records user_direct_allow); no APPROVAL_REQUIRED 409.
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{}},\"id\":9}";
        when(requestRewriter.rewrite(anyString(), eq(body), anyString())).thenReturn(body);
        when(policyEngine.evaluate(eq("write_file"), eq(body), eq("sess-1")))
                .thenReturn(PolicyEngine.PolicyDecision.requireApproval("mutation requires approval"));

        Map<String, Map<String, String>> cache =
                (Map<String, Map<String, String>>) ReflectionTestUtils.getField(controller, "toolServerCache");
        Map<String, Instant> timestamps =
                (Map<String, Instant>) ReflectionTestUtils.getField(controller, "cacheTimestamps");
        cache.put(TEST_WS_UUID, new ConcurrentHashMap<>(Map.of("write_file", "__system__")));
        timestamps.put(TEST_WS_UUID, Instant.now());

        Object access = accessContext(TEST_WS_UUID, "u-1");
        ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                controller, "handleToolsCall", TEST_WS_UUID, body,
                new HttpHeaders(), "sess-1", access);

        assertNotEquals(HttpStatus.CONFLICT, response.getStatusCode(),
                "user-direct workspace mutation must not be blocked by the approval gate");
        verify(auditLogger).record(eq("sess-1"), eq("write_file"), eq("user_direct_allow"), any());
    }

    @Test
    @SuppressWarnings("unchecked")
    void handleToolsCall_matchingApprovalGrant_forwardsToRuntimeOnce() throws Exception {
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{}},\"id\":8}";
        when(requestRewriter.rewrite(anyString(), eq(body), anyString())).thenReturn(body);
        when(policyEngine.evaluate(eq("write_file"), eq(body), eq("sess-1")))
                .thenReturn(PolicyEngine.PolicyDecision.requireApproval("mutation requires approval"));
        when(approvalService.consumeApprovedGrant(
                eq("grant-1"), eq("u-1"), eq(TEST_WS_UUID), eq("sess-1"), eq("write_file"), eq(body)))
                .thenReturn(true);
        OperationItem item = new OperationItem();
        item.setId(java.util.UUID.randomUUID());
        item.setStatus("pending");
        OperationAttempt attempt = new OperationAttempt();
        attempt.setId(java.util.UUID.randomUUID());
        when(operationService.appendItem(any(), any(), any(), anyString(), anyString(), anyString(), any(), any(), any()))
                .thenReturn(item);
        when(operationService.startAttempt(any(), anyString(), any(), anyString(), any()))
                .thenReturn(attempt);

        Map<String, Map<String, String>> cache =
                (Map<String, Map<String, String>>) ReflectionTestUtils.getField(controller, "toolServerCache");
        Map<String, Instant> timestamps =
                (Map<String, Instant>) ReflectionTestUtils.getField(controller, "cacheTimestamps");
        cache.put(TEST_WS_UUID, new ConcurrentHashMap<>(Map.of("write_file", "__system__")));
        timestamps.put(TEST_WS_UUID, Instant.now());

        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        stub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp", exchange -> {
            byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[]},\"id\":8}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        stub.start();
        try {
            ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                    "http://127.0.0.1:" + stub.getAddress().getPort());
            Object access = accessContext(TEST_WS_UUID, "u-1");
            HttpHeaders headers = new HttpHeaders();
            headers.set("X-Xihe-Approval-Request-Id", "grant-1");
            headers.set("X-Operation-Id", java.util.UUID.randomUUID().toString());
            headers.set("X-Operation-Item-Id", java.util.UUID.randomUUID().toString());
            ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                    controller, "handleToolsCall", TEST_WS_UUID, body, headers, "sess-1", access);

            assertEquals(HttpStatus.OK, response.getStatusCode());
            verify(approvalService).consumeApprovedGrant(
                    "grant-1", "u-1", TEST_WS_UUID, "sess-1", "write_file", body);
            verify(operationService).finishAttempt(attempt.getId(), "succeeded", 200, null, null, null);
        } finally {
            stub.stop(0);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void forwardToRuntime_transportFailureRecordsUnknownAttemptAndAmbiguousItem() throws Exception {
        OperationItem item = new OperationItem();
        item.setId(java.util.UUID.randomUUID());
        item.setStatus("pending");
        OperationAttempt attempt = new OperationAttempt();
        attempt.setId(java.util.UUID.randomUUID());
        when(operationService.appendItem(any(), any(), any(), anyString(), anyString(), anyString(), any(), any(), any()))
                .thenReturn(item);
        when(operationService.startAttempt(any(), anyString(), any(), anyString(), any()))
                .thenReturn(attempt);
        when(operationService.findItemByApprovalRequestId(null)).thenReturn(null);

        ReflectionTestUtils.setField(controller, "runtimeBaseUrl", "http://127.0.0.1:1");
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Operation-Id", java.util.UUID.randomUUID().toString());
        headers.set("X-Operation-Item-Id", java.util.UUID.randomUUID().toString());
        headers.set("X-Request-Id", java.util.UUID.randomUUID().toString());
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{}},\"id\":9}";

        ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                controller, "forwardToRuntime", TEST_WS_UUID, null, body, headers, "sess-1",
                accessContext(TEST_WS_UUID, "u-1"));

        assertEquals(HttpStatus.BAD_GATEWAY, response.getStatusCode());
        verify(operationService).finishAttempt(attempt.getId(), "unknown", 502,
                "MCP_FORWARD_UNKNOWN", null, null);
        verify(operationService).transitionItem(item.getId(), "ambiguous", null, null, null,
                "MCP_FORWARD_UNKNOWN");
    }

    @Test
    void verifySessionId_rejectsEmptyString() {
        String wsId = (String) ReflectionTestUtils.invokeMethod(controller, "verifySessionId", "");
        assertNull(wsId);
    }

}
