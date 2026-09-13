package com.cc01cc.p.xihe.cp.mcp;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy;
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
    private McpStdioServerRepository stdioServerRepository;
    private McpServerRepository mcpServerRepository;
    private McpToolAliasRepository aliasRepository;
    private WorkspaceService workspaceService;
    private SessionRepository sessionRepository;
    private OperationService operationService;
    private McpProxyController controller;
    private org.springframework.mock.env.MockEnvironment environment;

    @BeforeEach
    void setUp() {
        requestRewriter = mock(RequestRewriter.class);
        policyEngine = mock(PolicyEngine.class);
        auditLogger = mock(AuditLogger.class);
        approvalService = mock(ApprovalService.class);
        objectMapper = new ObjectMapper();
        sseEmitterManager = mock(SseEmitterManager.class);
        stdioServerRepository = mock(McpStdioServerRepository.class);
        mcpServerRepository = mock(McpServerRepository.class);
        aliasRepository = mock(McpToolAliasRepository.class);
        workspaceService = mock(WorkspaceService.class);
        sessionRepository = mock(SessionRepository.class);
        operationService = mock(OperationService.class);
        environment = new org.springframework.mock.env.MockEnvironment();

        controller = new McpProxyController(
                requestRewriter, policyEngine,
                auditLogger, approvalService, objectMapper, sseEmitterManager, stdioServerRepository,
                mcpServerRepository, aliasRepository,
                workspaceService, sessionRepository, operationService,
                mock(com.cc01cc.p.xihe.cp.config.ConfigService.class),
                new com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy(),
                environment
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
            when(stdioServerRepository.findByWorkspaceIdOrderByNameAsc(TEST_WS_UUID))
                    .thenReturn(java.util.List.of());
            when(aliasRepository.findByWorkspaceId(java.util.UUID.fromString(TEST_WS_UUID))).thenReturn(java.util.List.of());
            when(aliasRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

            Object access = accessContext(TEST_WS_UUID, "u-1");
            String listBody = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":2,\"params\":{}}";
            org.springframework.http.ResponseEntity<String> listResp =
                    (org.springframework.http.ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                            controller, "handleToolsList", TEST_WS_UUID, listBody,
                            new org.springframework.http.HttpHeaders(), "sess-1", access);
            assertNotNull(listResp);
            assertTrue(listResp.getBody().contains("fake_echo"),
                    "merged list must contain the remote tool");
            // 无会话世代：合并响应必须回显调用方 id，并携带 modern 结果必填字段，
            // 否则客户端按「未知/迟到 id」丢弃该响应并永久等待（T2.4④ 实测根因）。
            assertTrue(listResp.getBody().contains("\"id\":2"),
                    "merged list must echo the caller's JSON-RPC id, got: " + listResp.getBody());
            assertTrue(listResp.getBody().contains("\"resultType\":\"complete\""),
                    "modern result must carry resultType, got: " + listResp.getBody());
            assertTrue(listResp.getBody().contains("\"cacheScope\":\"private\""),
                    "modern result must carry cacheScope, got: " + listResp.getBody());
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

    // ── PLAN-0308 M1 T1.9：per-call 生产方（run payload + 入站头采纳/剥离） ──────────

    @SuppressWarnings("unchecked")
    private void seedToolCache(String tool, String serverId) {
        Map<String, Map<String, String>> cache =
                (Map<String, Map<String, String>>) ReflectionTestUtils.getField(controller, "toolServerCache");
        Map<String, Instant> timestamps =
                (Map<String, Instant>) ReflectionTestUtils.getField(controller, "cacheTimestamps");
        cache.put(TEST_WS_UUID, new ConcurrentHashMap<>(Map.of(tool, serverId)));
        timestamps.put(TEST_WS_UUID, Instant.now());
    }

    @Test
    @SuppressWarnings("unchecked")
    void toolTimeoutPayload_perCallOverridesConfigAndShipsRawValues() {
        com.cc01cc.p.xihe.cp.entity.McpServer server =
                new com.cc01cc.p.xihe.cp.entity.McpServer(TEST_WS_UUID, "deepwiki", "https://mcp.deepwiki.com/mcp");
        server.setId(java.util.UUID.nameUUIDFromBytes("deepwiki".getBytes()));
        server.setEnabled(true);
        server.setToolTimeoutS(15);
        when(mcpServerRepository.findById(server.getId())).thenReturn(java.util.Optional.of(server));
        seedToolCache("fake_echo", server.getId().toString());

        Map<String, Object> payload = controller.toolTimeoutPayload(
                TEST_WS_UUID, "u-1", Map.of("fake_echo", 25, "execute_command", 25));

        Map<String, Object> waits = (Map<String, Object>) payload.get("toolWaits");
        Map<String, Object> origins = (Map<String, Object>) payload.get("toolWaitOrigins");
        // 映射内的工具：per-call 压制 config（15 → 25），Agent 等待 = 25 + 4。
        assertEquals(29L, ((Number) waits.get("fake_echo")).longValue());
        assertEquals("per-call", origins.get("fake_echo"));
        // 映射外的工具（冷缓存 / 系统工具）：per-call 条目仍显式下发，不落回系统工具统一值。
        assertEquals(29L, ((Number) waits.get("execute_command")).longValue());
        assertEquals("per-call", origins.get("execute_command"));
        // 原始 per-call 值随 payload 下发，供 Agent 随工具调用附带入站头。
        assertEquals(25, ((Number) ((Map<String, Object>) payload.get("toolTimeouts"))
                .get("execute_command")).intValue());
    }

    @Test
    @SuppressWarnings("unchecked")
    void toolTimeoutPayload_withoutPerCallOmitsRawKey() {
        com.cc01cc.p.xihe.cp.entity.McpServer server =
                new com.cc01cc.p.xihe.cp.entity.McpServer(TEST_WS_UUID, "deepwiki", "https://mcp.deepwiki.com/mcp");
        server.setId(java.util.UUID.nameUUIDFromBytes("deepwiki".getBytes()));
        server.setEnabled(true);
        server.setToolTimeoutS(15);
        when(mcpServerRepository.findById(server.getId())).thenReturn(java.util.Optional.of(server));
        seedToolCache("fake_echo", server.getId().toString());

        Map<String, Object> payload = controller.toolTimeoutPayload(TEST_WS_UUID, "u-1", Map.of());

        Map<String, Object> waits = (Map<String, Object>) payload.get("toolWaits");
        Map<String, Object> origins = (Map<String, Object>) payload.get("toolWaitOrigins");
        assertEquals(19L, ((Number) waits.get("fake_echo")).longValue());
        assertEquals("config", origins.get("fake_echo"));
        assertFalse(payload.containsKey("toolTimeouts"));
        assertEquals("full", payload.get("budgetCoverage"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void toolTimeoutPayload_oversizedLegacyConfigFallsBackToDefault() {
        // T3.1：数据库预算与 per-call 同顶 30s；旧上限时代的 90s 配置不再生效，
        // 告警后回落代码默认（30s），而不是静默截断成 30 再署名 config=90。
        com.cc01cc.p.xihe.cp.entity.McpServer server =
                new com.cc01cc.p.xihe.cp.entity.McpServer(TEST_WS_UUID, "deepwiki", "https://mcp.deepwiki.com/mcp");
        server.setId(java.util.UUID.nameUUIDFromBytes("deepwiki".getBytes()));
        server.setEnabled(true);
        server.setToolTimeoutS(90);
        when(mcpServerRepository.findById(server.getId())).thenReturn(java.util.Optional.of(server));
        seedToolCache("fake_echo", server.getId().toString());

        Map<String, Object> payload = controller.toolTimeoutPayload(TEST_WS_UUID, "u-1", Map.of());

        // 无有效配置行 → 不下发 per-tool 条目，Agent 回落系统工具统一值（预算默认 30 + 4）。
        assertEquals(34L, ((Number) payload.get("systemToolWait")).longValue());
        Object waitsRaw = payload.get("toolWaits");
        Map<String, Object> waits = waitsRaw == null
                ? Map.of() : (Map<String, Object>) waitsRaw;
        assertFalse(waits.containsKey("fake_echo"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void handleToolsCall_perCallHeaderAdoptedAndUpstreamTimeoutHeadersStripped() throws Exception {
        when(requestRewriter.rewrite(anyString(), anyString(), anyString()))
                .thenAnswer(inv -> inv.getArgument(1));
        seedToolCache("read_file", "__system__");

        final String[] outboundTimeout = new String[1];
        final String[] outboundOrigin = new String[1];
        final String[] leakedPerCall = new String[1];
        final String[] outboundItemId = new String[1];
        final String[] outboundRunId = new String[1];
        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        stub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp", exchange -> {
            outboundTimeout[0] = exchange.getRequestHeaders().getFirst("X-Xihe-Tool-Timeout-S");
            outboundOrigin[0] = exchange.getRequestHeaders().getFirst("X-Xihe-Tool-Timeout-Origin");
            leakedPerCall[0] = exchange.getRequestHeaders().getFirst("X-Xihe-Tool-Timeout-Per-Call");
            outboundItemId[0] = exchange.getRequestHeaders().getFirst("X-Operation-Item-Id");
            outboundRunId[0] = exchange.getRequestHeaders().getFirst("X-Chat-Run-Id");
            byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[]},\"id\":3}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        stub.start();
        try {
            ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                    "http://127.0.0.1:" + stub.getAddress().getPort());
            String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                    + "\"params\":{\"name\":\"read_file\",\"arguments\":{}},\"id\":3}";
            HttpHeaders headers = new HttpHeaders();
            headers.set("X-Chat-Run-Id", TEST_WS_UUID);
            headers.set("X-Operation-Item-Id", "call-abc-123");
            headers.set("X-Xihe-Tool-Timeout-Per-Call", "25");
            // 上游伪造的出站头必须被剥离，只认 CP 自己的计算（信任边界 spec S2.2 规则 5）。
            headers.set("X-Xihe-Tool-Timeout-S", "9999");
            headers.set("X-Xihe-Tool-Timeout-Origin", "config");

            ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                    controller, "handleToolsCall", TEST_WS_UUID, body, headers, "sess-1",
                    accessContext(TEST_WS_UUID, "u-1"));

            assertEquals(HttpStatus.OK, response.getStatusCode());
            assertEquals("25", outboundTimeout[0]);
            assertEquals("per-call", outboundOrigin[0]);
            assertNull(leakedPerCall[0], "入站 per-call 头不得透传给 Runtime");
            // 关联键透传：Runtime 用同一 toolCallId 打日志（spec S5.1 规则 1）。
            assertEquals("call-abc-123", outboundItemId[0]);
            assertEquals(TEST_WS_UUID, outboundRunId[0]);
        } finally {
            stub.stop(0);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void handleToolsCall_rejectsInvalidPerCallHeaderWithoutForwarding() throws Exception {
        when(requestRewriter.rewrite(anyString(), anyString(), anyString()))
                .thenAnswer(inv -> inv.getArgument(1));
        seedToolCache("read_file", "__system__");
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"read_file\",\"arguments\":{}},\"id\":4}";
        Object access = accessContext(TEST_WS_UUID, "u-1");

        for (String bad : new String[] {"abc", "0", "-5", "31", "601", "12.5"}) {
            HttpHeaders headers = new HttpHeaders();
            headers.set("X-Chat-Run-Id", TEST_WS_UUID);
            headers.set("X-Xihe-Tool-Timeout-Per-Call", bad);
            ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                    controller, "handleToolsCall", TEST_WS_UUID, body, headers, "sess-1", access);

            assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(), "value " + bad);
            assertTrue(response.getBody().contains("INVALID_REQUEST"), "value " + bad);
        }
    }

    // ── PLAN-0308 T3.4②（决策 #31）：输出上限授权 → 出站头 ───────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void handleToolsCall_setsOutputLimitHeaderFromConfigAndStripsUpstream() throws Exception {
        when(requestRewriter.rewrite(anyString(), anyString(), anyString()))
                .thenAnswer(inv -> inv.getArgument(1));
        seedToolCache("read_file", "__system__");
        com.cc01cc.p.xihe.cp.config.ConfigService configService =
                (com.cc01cc.p.xihe.cp.config.ConfigService) ReflectionTestUtils.getField(
                        controller, "configService");
        when(configService.resolve(
                eq(com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy.SYSTEM_TOOL_DOMAIN),
                eq(com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy.OUTPUT_LIMIT_KEY),
                any(), any()))
                .thenReturn("8192");

        final String[] outboundLimit = new String[1];
        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        stub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp", exchange -> {
            outboundLimit[0] = exchange.getRequestHeaders().getFirst("X-Xihe-Tool-Output-Limit");
            byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[]},\"id\":6}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        stub.start();
        try {
            ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                    "http://127.0.0.1:" + stub.getAddress().getPort());
            String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                    + "\"params\":{\"name\":\"read_file\",\"arguments\":{}},\"id\":6}";
            HttpHeaders headers = new HttpHeaders();
            headers.set("X-Chat-Run-Id", TEST_WS_UUID);
            // 上游伪造的同名头必须被剥离，只认 CP 的配置值（信任边界）。
            headers.set("X-Xihe-Tool-Output-Limit", "1");

            ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                    controller, "handleToolsCall", TEST_WS_UUID, body, headers, "sess-1",
                    accessContext(TEST_WS_UUID, "u-1"));

            assertEquals(HttpStatus.OK, response.getStatusCode());
            assertEquals("8192", outboundLimit[0]);
        } finally {
            stub.stop(0);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void handleToolsCall_omitsOutputLimitHeaderWhenUnconfigured() throws Exception {
        when(requestRewriter.rewrite(anyString(), anyString(), anyString()))
                .thenAnswer(inv -> inv.getArgument(1));
        seedToolCache("read_file", "__system__");

        final String[] outboundLimit = new String[1];
        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        stub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp", exchange -> {
            // 记录"头是否存在过"（null 表示未下发）
            outboundLimit[0] = exchange.getRequestHeaders().getFirst("X-Xihe-Tool-Output-Limit");
            byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[]},\"id\":7}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        stub.start();
        try {
            ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                    "http://127.0.0.1:" + stub.getAddress().getPort());
            HttpHeaders headers = new HttpHeaders();
            headers.set("X-Chat-Run-Id", TEST_WS_UUID);
            // 未配置但上游带了一个值：仍应被剥离（未授权不得下发）
            headers.set("X-Xihe-Tool-Output-Limit", "1");

            ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                    controller, "handleToolsCall", TEST_WS_UUID,
                    "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"read_file\",\"arguments\":{}},\"id\":7}",
                    headers, "sess-1", accessContext(TEST_WS_UUID, "u-1"));

            assertEquals(HttpStatus.OK, response.getStatusCode());
            assertNull(outboundLimit[0], "未配置时不得下发输出上限头");
        } finally {
            stub.stop(0);
        }
    }

    // ── PLAN-0308 M1（spec S1/S2 三条判断 + S5.1 关联键）：CP 本跳 ENV / 透传 ──────────

    @Test
    void cpForwardWait_usesDerivedValueWithoutEnv() {
        ToolTimeoutPolicy.ToolWaits waits = new ToolTimeoutPolicy()
                .resolve(null, 20);
        McpProxyController.ForwardWait wait = (McpProxyController.ForwardWait)
                ReflectionTestUtils.invokeMethod(controller, "forwardWaitFor", waits, null);

        assertEquals(22L, wait.seconds());
        assertEquals("cp", wait.source());
        assertEquals("config", wait.valueOrigin());
        assertNull(wait.overriddenValue());
    }

    @Test
    void cpForwardWait_envExplicitBeatsDerivedValue() {
        environment.setProperty("xihe.mcp.forward-timeout-s", "25");
        ReflectionTestUtils.setField(controller, "forwardTimeoutS", 25L);
        ToolTimeoutPolicy.ToolWaits waits = new ToolTimeoutPolicy()
                .resolve(null, 20);

        McpProxyController.ForwardWait wait = (McpProxyController.ForwardWait)
                ReflectionTestUtils.invokeMethod(controller, "forwardWaitFor", waits, null);

        assertEquals(25L, wait.seconds());
        assertEquals("env", wait.source());
        assertEquals(22L, wait.overriddenValue(), "派生值被 ENV 压制并署名");
    }

    @Test
    void cpForwardWait_perCallSuppressesEnv() {
        environment.setProperty("xihe.mcp.forward-timeout-s", "25");
        ReflectionTestUtils.setField(controller, "forwardTimeoutS", 25L);
        ToolTimeoutPolicy.ToolWaits waits = new ToolTimeoutPolicy()
                .resolve(28, 20);

        McpProxyController.ForwardWait wait = (McpProxyController.ForwardWait)
                ReflectionTestUtils.invokeMethod(controller, "forwardWaitFor", waits, 28L);

        assertEquals(30L, wait.seconds());
        assertEquals("cp", wait.source());
        assertEquals("per-call", wait.valueOrigin());
        assertEquals(25L, wait.overriddenValue(), "per-call 最高：本跳 ENV 被压制并署名");
    }

    @Test
    @SuppressWarnings("unchecked")
    void handleToolsCall_stdioPathCarriesBudgetHeader() throws Exception {        when(requestRewriter.rewrite(anyString(), anyString(), anyString()))
                .thenAnswer(inv -> inv.getArgument(1));
        seedToolCache("stdio_tool", "some-stdio-server");

        final String[] outboundTimeout = new String[1];
        final String[] outboundOrigin = new String[1];
        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        stub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp/stdio/some-stdio-server",
                exchange -> {
                    outboundTimeout[0] = exchange.getRequestHeaders().getFirst("X-Xihe-Tool-Timeout-S");
                    outboundOrigin[0] = exchange.getRequestHeaders().getFirst("X-Xihe-Tool-Timeout-Origin");
                    byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[]},\"id\":5}"
                            .getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(200, response.length);
                    exchange.getResponseBody().write(response);
                    exchange.close();
                });
        stub.start();
        try {
            ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                    "http://127.0.0.1:" + stub.getAddress().getPort());
            String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                    + "\"params\":{\"name\":\"stdio_tool\",\"arguments\":{}},\"id\":5}";
            HttpHeaders headers = new HttpHeaders();
            headers.set("X-Chat-Run-Id", TEST_WS_UUID);

            ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                    controller, "handleToolsCall", TEST_WS_UUID, body, headers, "sess-1",
                    accessContext(TEST_WS_UUID, "u-1"));

            assertEquals(HttpStatus.OK, response.getStatusCode());
            // 无 per-call、无配置 → 预算默认 30，出站 = 预算（Runtime 界）。
            assertEquals("30", outboundTimeout[0]);
            assertEquals("config", outboundOrigin[0]);
        } finally {
            stub.stop(0);
        }
    }

}
