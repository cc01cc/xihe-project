package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.AgentSpawnExecutionService;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * V10 / design #16 (PLAN-0407 G2 Q5): gate order authorization → capability → approval. The
 * existing {@code McpProxyTest#handleToolsCall_grantDenied_doesNotEvaluateApproval} proves an
 * authorization deny never evaluates approval; this class adds the missing other half — the deny
 * also never reaches the capability/execution plane (no Runtime dispatch attempt at all), and it
 * never creates a pending approval row.
 *
 * <p>The Runtime endpoint is a counting stub: zero hits is direct evidence that neither dispatch
 * nor any capability probe was attempted after the deny.</p>
 */
class GrantDenyStopsBeforeDispatchTest {

    static final String TEST_WS_UUID = "66666666-6666-6666-6666-666666666666";

    private RequestRewriter requestRewriter;
    private PolicyEngine policyEngine;
    private AuditLogger auditLogger;
    private ApprovalService approvalService;
    private SseEmitterManager sseEmitterManager;
    private McpProxyController controller;
    private McpToolTimeoutService toolTimeoutService;
    private com.sun.net.httpserver.HttpServer runtimeStub;
    private final AtomicInteger runtimeHits = new AtomicInteger();

    @BeforeEach
    void setUp() throws Exception {
        requestRewriter = mock(RequestRewriter.class);
        policyEngine = mock(PolicyEngine.class);
        auditLogger = mock(AuditLogger.class);
        approvalService = mock(ApprovalService.class);
        sseEmitterManager = mock(SseEmitterManager.class);

        var timeoutRepo = mock(McpServerRepository.class);
        var stdioRepository = mock(McpStdioServerRepository.class);
        var aliasRepository = mock(McpToolAliasRepository.class);
        var timeoutConfig = mock(com.cc01cc.p.xihe.cp.config.ConfigService.class);
        var timeoutPolicy = new ToolTimeoutPolicy();
        toolTimeoutService = new McpToolTimeoutService(timeoutRepo, timeoutConfig, timeoutPolicy);

        controller = new McpProxyController(
                requestRewriter, policyEngine,
                auditLogger, approvalService, new com.fasterxml.jackson.databind.ObjectMapper(),
                sseEmitterManager, new McpProxyCatalogService(stdioRepository, timeoutRepo, aliasRepository),
                mock(WorkspaceService.class), mock(SessionService.class),
                mock(com.cc01cc.p.xihe.cp.operation.JobStateService.class),
                timeoutConfig,
                timeoutPolicy,
                new org.springframework.mock.env.MockEnvironment(),
                mock(AgentSpawnExecutionService.class),
                mock(com.cc01cc.p.xihe.cp.mcp.McpInvocationService.class),
                toolTimeoutService);
        ReflectionTestUtils.setField(controller, "sessionIdHmacSecret", "test-only-key");

        runtimeStub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        runtimeStub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp", exchange -> {
            runtimeHits.incrementAndGet();
            byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[]},\"id\":1}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        runtimeStub.start();
        ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                "http://127.0.0.1:" + runtimeStub.getAddress().getPort());
    }

    @AfterEach
    void stopStub() {
        if (runtimeStub != null) {
            runtimeStub.stop(0);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void grantDenyReturnsBeforeDispatchCapabilityOrApprovalEvaluation() throws Exception {
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"denied.md\"}},\"id\":10}";
        when(requestRewriter.rewrite(anyString(), anyString(), anyString())).thenReturn(body);
        when(policyEngine.loadContext(anyString(), anyString(), anyString()))
                .thenReturn(PolicyContext.EMPTY);
        when(policyEngine.allowsByGrant(any(PolicyContext.class), eq("write_file"), eq(body),
                eq("sess-1"), eq("u-1"), eq(TEST_WS_UUID), anyBoolean())).thenReturn(false);
        when(policyEngine.faceOf(any(PolicyContext.class), eq("write_file")))
                .thenReturn(new ToolFaceRegistry.Face("write", ToolShape.STRUCTURED));
        when(policyEngine.evaluateVerdict(any(PolicyContext.class), anyString(), anyString(),
                        anyString(), any(), any(), any()))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ASK, null, PolicyLayer.BUILTIN,
                        "manual", "should never be evaluated after an authorization deny"));

        Map<String, Map<String, String>> cache =
                (Map<String, Map<String, String>>) ReflectionTestUtils.getField(toolTimeoutService, "toolServerCache");
        Map<String, Instant> timestamps =
                (Map<String, Instant>) ReflectionTestUtils.getField(toolTimeoutService, "cacheTimestamps");
        cache.put(TEST_WS_UUID, new ConcurrentHashMap<>(Map.of("write_file", "__system__")));
        timestamps.put(TEST_WS_UUID, Instant.now());

        HttpHeaders headers = new HttpHeaders();
        ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                controller, "handleToolsCall", TEST_WS_UUID, body, headers, "sess-1",
                accessContext(TEST_WS_UUID, "u-1", "sess-1"));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
        assertNotNull(response.getBody());
        assertTrue(response.getBody().contains("Tool execution is not permitted"),
                "the deny is the authorization answer, got: " + response.getBody());

        assertEquals(0, runtimeHits.get(),
                "capability/execution plane must never be reached after an authorization deny");
        verify(policyEngine, never()).evaluateVerdict(any(PolicyContext.class), anyString(),
                anyString(), anyString(), any(), any(), any());
        verify(approvalService, never()).recordGatePending(anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString(), any(Instant.class));
        verify(sseEmitterManager, never()).send(eq("sess-1"), eq("tool_exec_approval_required"), any());
        verify(auditLogger).record(eq("sess-1"), eq("write_file"),
                eq("authorization_grant_denied"), any());
    }

    private static Object accessContext(String wsId, String userId, String sessionId) throws Exception {
        Class<?> accessClass = Class.forName(
                "com.cc01cc.p.xihe.cp.mcp.McpProxyController$AccessContext");
        var constructor = accessClass.getDeclaredConstructor(
                String.class, String.class, String.class, String.class, boolean.class);
        constructor.setAccessible(true);
        return constructor.newInstance(wsId, userId, sessionId, null, false);
    }
}
