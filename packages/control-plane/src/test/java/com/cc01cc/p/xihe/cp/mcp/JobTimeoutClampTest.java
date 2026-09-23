package com.cc01cc.p.xihe.cp.mcp;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.util.ReflectionTestUtils;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.operation.OperationService;
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
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy;

import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * PLAN-0373 T3.1：job 运行时限钳制——P2 矩阵、三分支出口体一致性
 * （__system__ 原 body / remote envelope / stdio rewritten）、job_timeout_clamp
 * 日志来源回填（四级）、四级来源判定，以及决策 #9 注入面反证
 * （非 job 工具不注入、不产 clamp 日志）。配置面（DOMAINS/写层/schema/env overlay）
 * 由 {@code ConfigServiceTest} / {@code EnvOverlayRegistryTest} 覆盖。
 */
class JobTimeoutClampTest {

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
    private ConfigService configService;
    private McpProxyController controller;

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
        configService = mock(ConfigService.class);

        controller = new McpProxyController(
                requestRewriter, policyEngine,
                auditLogger, approvalService, objectMapper, sseEmitterManager, stdioServerRepository,
                mcpServerRepository, aliasRepository,
                workspaceService, sessionRepository, operationService,
                mock(JobStateService.class),
                configService,
                new ToolTimeoutPolicy(),
                new org.springframework.mock.env.MockEnvironment()
        );
        ReflectionTestUtils.setField(controller, "runtimeBaseUrl", "http://localhost:9091");

        when(policyEngine.loadContext(any(), any(), any())).thenReturn(PolicyContext.EMPTY);
        when(policyEngine.evaluateVerdict(any(PolicyContext.class), anyString(), anyString(),
                anyString(), any(), any(), any()))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN,
                        "manual", "auto_allow"));
        when(policyEngine.faceOf(any(PolicyContext.class), anyString()))
                .thenReturn(new ToolFaceRegistry.Face("exec", ToolShape.STRUCTURED));
        when(requestRewriter.rewrite(anyString(), anyString(), anyString()))
                .thenAnswer(inv -> inv.getArgument(1));
    }

    // ------------------------------------------------------------------
    // P2 钳制矩阵（决策 #2/#8，纯函数）
    // ------------------------------------------------------------------

    @Test
    void computeJobTimeout_matrix_coversP2Semantics() {
        // 未传 → 默认；上限已设时默认也被钳（P1 硬上限不变式，workspace 不可超上限抬默认）。
        assertEquals(3600L, McpProxyController.computeJobTimeoutValue(null, 3600L, 0L));
        assertEquals(1800L, McpProxyController.computeJobTimeoutValue(null, 3600L, 1800L));
        // >0 → min(参数, 上限)；上限 0 = 不钳（决策 #8：未配置零行为变化）。
        assertEquals(900L, McpProxyController.computeJobTimeoutValue(7200L, 3600L, 900L));
        assertEquals(600L, McpProxyController.computeJobTimeoutValue(600L, 3600L, 900L));
        assertEquals(600L, McpProxyController.computeJobTimeoutValue(600L, 3600L, 0L));
        // 显式 0 → 钳到上限；cap=0 时 = 0 = 不限（0-opt-out 保持）。
        assertEquals(900L, McpProxyController.computeJobTimeoutValue(0L, 3600L, 900L));
        assertEquals(0L, McpProxyController.computeJobTimeoutValue(0L, 3600L, 0L));
        // 非法负值按未传处理（不放大、不绕过）。
        assertEquals(3600L, McpProxyController.computeJobTimeoutValue(-5L, 3600L, 0L));
        assertEquals(900L, McpProxyController.computeJobTimeoutValue(-5L, 3600L, 900L));
    }

    // ------------------------------------------------------------------
    // 三分支注入一致性（T3.1 / 评审 P1-2）：三个出口携带同一覆写值
    // ------------------------------------------------------------------

    @Test
    @SuppressWarnings("unchecked")
    void threeBranchExits_carryIdenticalOverriddenTimeout() throws Exception {
        // 配置：默认 1800、上限 900；模型参数 7200 → 三个出口都应是 min(7200, 900) = 900。
        when(configService.resolve(eq("job-policy"), eq("defaultTimeoutSecs"), any(), any()))
                .thenReturn("1800");
        when(configService.resolve(eq("job-policy"), eq("maxTimeoutSecs"), any(), any()))
                .thenReturn("900");

        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        final String[] systemBody = new String[1];
        final String[] stdioBody = new String[1];
        final String[] remoteEnvelope = new String[1];
        stub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp", exchange -> {
            systemBody[0] = new String(exchange.getRequestBody().readAllBytes(),
                    java.nio.charset.StandardCharsets.UTF_8);
            byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[],\"isError\":false},\"id\":1}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        stub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp/stdio/srv-stdio",
                exchange -> {
                    stdioBody[0] = new String(exchange.getRequestBody().readAllBytes(),
                            java.nio.charset.StandardCharsets.UTF_8);
                    byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[],\"isError\":false},\"id\":2}"
                            .getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(200, response.length);
                    exchange.getResponseBody().write(response);
                    exchange.close();
                });
        com.cc01cc.p.xihe.cp.entity.McpServer server =
                new com.cc01cc.p.xihe.cp.entity.McpServer(
                        TEST_WS_UUID, "deepwiki", "https://mcp.deepwiki.com/mcp");
        server.setId(java.util.UUID.nameUUIDFromBytes("deepwiki".getBytes()));
        server.setEnabled(true);
        server.setAuthMode("no-auth");
        when(mcpServerRepository.findById(server.getId())).thenReturn(java.util.Optional.of(server));
        stub.createContext("/internal/v1/runtime/remote-mcp/" + TEST_WS_UUID + "/"
                + server.getId() + "/call", exchange -> {
            remoteEnvelope[0] = new String(exchange.getRequestBody().readAllBytes(),
                    java.nio.charset.StandardCharsets.UTF_8);
            byte[] response = "{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        stub.start();
        try {
            ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                    "http://127.0.0.1:" + stub.getAddress().getPort());

            // 决策 #9：注入面 = start_background_process；分支拓扑与工具名正交——
            // 同一 job 工具名按三种 serverId 依次重播种缓存，分别打到三个出口。
            // ① __system__ 出口：原 body 分支（注入同时回写 body 与 rewritten）。
            seedToolCache("start_background_process", "__system__");
            ResponseEntity<String> systemResp = dispatch(
                    "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                            + "\"params\":{\"name\":\"start_background_process\","
                            + "\"arguments\":{\"command\":\"sleep 5\",\"timeout\":7200}},\"id\":1}");
            assertEquals(HttpStatus.OK, systemResp.getStatusCode());

            // ② stdio 出口：rewritten 分支（同名 job 工具重播种到 stdio server）。
            seedToolCache("start_background_process", "srv-stdio");
            ResponseEntity<String> stdioResp = dispatch(
                    "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                            + "\"params\":{\"name\":\"start_background_process\","
                            + "\"arguments\":{\"command\":\"sleep 5\",\"timeout\":7200}},\"id\":2}");
            assertEquals(HttpStatus.OK, stdioResp.getStatusCode());

            // ③ remote 出口：rewritten + forwardRemoteToRuntime 重解析装 envelope。
            seedToolCache("start_background_process", server.getId().toString());
            ResponseEntity<String> remoteResp = dispatch(
                    "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                            + "\"params\":{\"name\":\"start_background_process\","
                            + "\"arguments\":{\"command\":\"sleep 5\",\"timeout\":7200}},\"id\":3}");
            assertEquals(HttpStatus.OK, remoteResp.getStatusCode());

            assertNotNull(systemBody[0], "system branch must forward");
            assertNotNull(stdioBody[0], "stdio branch must forward");
            assertNotNull(remoteEnvelope[0], "remote envelope must forward");

            long systemTimeout = timeoutOf(objectMapper.readTree(systemBody[0])
                    .path("params").path("arguments"));
            long stdioTimeout = timeoutOf(objectMapper.readTree(stdioBody[0])
                    .path("params").path("arguments"));
            long remoteTimeout = timeoutOf(objectMapper.readTree(remoteEnvelope[0])
                    .path("arguments"));

            assertEquals(900L, systemTimeout, "__system__ exit must carry the clamped value");
            assertEquals(900L, stdioTimeout, "stdio exit must carry the clamped value");
            assertEquals(900L, remoteTimeout, "remote envelope must carry the clamped value");
            assertEquals(systemTimeout, stdioTimeout, "all three exits must agree");
            assertEquals(systemTimeout, remoteTimeout, "all three exits must agree");
        } finally {
            stub.stop(0);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void absentArgumentsObject_isCreatedWithDefaultTimeout() throws Exception {
        // 无配置 → 代码默认 3600/0；job 工具未传 arguments 对象也要被无条件补上 timeout（决策 #9 注入面内）。
        seedToolCache("start_background_process", "__system__");
        final String[] body = new String[1];
        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        stub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp", exchange -> {
            body[0] = new String(exchange.getRequestBody().readAllBytes(),
                    java.nio.charset.StandardCharsets.UTF_8);
            byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[],\"isError\":false},\"id\":4}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        stub.start();
        try {
            ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                    "http://127.0.0.1:" + stub.getAddress().getPort());
            ResponseEntity<String> response = dispatch(
                    "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                            + "\"params\":{\"name\":\"start_background_process\"},\"id\":4}");
            assertEquals(HttpStatus.OK, response.getStatusCode());
            JsonNode arguments = objectMapper.readTree(body[0]).path("params").path("arguments");
            assertTrue(arguments.isObject(), "arguments object must be created");
            assertEquals(3600L, timeoutOf(arguments));
        } finally {
            stub.stop(0);
        }
    }

    // ------------------------------------------------------------------
    // 决策 #9 注入面反证：非 job 工具完全不碰 body、不产 clamp 日志
    // ------------------------------------------------------------------

    @Test
    @SuppressWarnings("unchecked")
    void nonJobTools_neverGetTimeoutInjectedOrClamped() throws Exception {
        // 上限 900 对 job 工具面生效；共享 timeout 键的 execute_command 参数 7200 必须原样透传
        // （不被钳到 900——否则同步工具缺省语义被改写），未传 timeout 的 read_file 不得被补键。
        when(configService.resolve(eq("job-policy"), eq("defaultTimeoutSecs"), any(), any()))
                .thenReturn("1800");
        when(configService.resolve(eq("job-policy"), eq("maxTimeoutSecs"), any(), any()))
                .thenReturn("900");
        seedToolCache("execute_command", "__system__");
        var appender = attachClampAppender();
        final String[] forwarded = new String[2];
        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        stub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp", exchange -> {
            String payload = new String(exchange.getRequestBody().readAllBytes(),
                    java.nio.charset.StandardCharsets.UTF_8);
            if (payload.contains("\"id\":42")) {
                forwarded[1] = payload;
            } else {
                forwarded[0] = payload;
            }
            byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[],\"isError\":false},\"id\":41}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        stub.start();
        try {
            ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                    "http://127.0.0.1:" + stub.getAddress().getPort());

            // A：共享 timeout 键的非 job 工具带 7200 → 必须原样（cap=900 不生效于该面）。
            ResponseEntity<String> execResp = dispatch(
                    "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                            + "\"params\":{\"name\":\"execute_command\","
                            + "\"arguments\":{\"command\":\"echo hi\",\"timeout\":7200}},\"id\":41}");
            assertEquals(HttpStatus.OK, execResp.getStatusCode());
            assertNotNull(forwarded[0]);
            JsonNode execArgs = objectMapper.readTree(forwarded[0]).path("params").path("arguments");
            assertEquals(7200L, execArgs.get("timeout").asLong(),
                    "non-job tool timeout must pass through untouched (decision #9)");

            // B：非 job 工具未传 timeout → 不得被补键。
            seedToolCache("read_file", "__system__");
            ResponseEntity<String> readResp = dispatch(
                    "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                            + "\"params\":{\"name\":\"read_file\","
                            + "\"arguments\":{\"path\":\"a.txt\"}},\"id\":42}");
            assertEquals(HttpStatus.OK, readResp.getStatusCode());
            assertNotNull(forwarded[1]);
            JsonNode readArgs = objectMapper.readTree(forwarded[1]).path("params").path("arguments");
            assertFalse(readArgs.has("timeout"),
                    "non-job tool must not gain an injected timeout key (decision #9)");

            // C：非 job 工具派发不得产生 job_timeout_clamp 日志。
            long clampLogs = appender.list.stream()
                    .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                    .filter(message -> message.contains("event=job_timeout_clamp"))
                    .count();
            assertEquals(0L, clampLogs, "no job_timeout_clamp log for non-job tools");
        } finally {
            stub.stop(0);
            detachClampAppender(appender);
        }
    }

    // ------------------------------------------------------------------
    // job_timeout_clamp 日志：生效值 + 来源四级回填（T2.3 / V3）
    // ------------------------------------------------------------------

    @Test
    @SuppressWarnings("unchecked")
    void clampLog_recordsDefaultOriginWhenUnconfigured() throws Exception {
        seedToolCache("start_background_process", "__system__");
        var appender = attachClampAppender();
        try {
            com.sun.net.httpserver.HttpServer stub = okStub();
            try {
                ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                        "http://127.0.0.1:" + stub.getAddress().getPort());
                dispatch("{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                        + "\"params\":{\"name\":\"start_background_process\","
                        + "\"arguments\":{\"command\":\"echo hi\"}},\"id\":5}");
            } finally {
                stub.stop(0);
            }
            String message = clampMessages(appender).get(0);
            assertTrue(message.contains("event=job_timeout_clamp"), message);
            assertTrue(message.contains("tool=start_background_process"), message);
            assertTrue(message.contains("param=absent"), message);
            assertTrue(message.contains("value=3600"), message);
            assertTrue(message.contains("valueOrigin=default"), message);
            assertTrue(message.contains("max=0"), message);
            assertTrue(message.contains("maxOrigin=default"), message);
        } finally {
            detachClampAppender(appender);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void clampLog_recordsEnvOriginAndClampedValue() throws Exception {
        when(configService.envOverriddenKeys("job-policy"))
                .thenReturn(Set.of("defaultTimeoutSecs", "maxTimeoutSecs"));
        when(configService.resolve(eq("job-policy"), eq("defaultTimeoutSecs"), any(), any()))
                .thenReturn("7200");
        when(configService.resolve(eq("job-policy"), eq("maxTimeoutSecs"), any(), any()))
                .thenReturn("3600");
        seedToolCache("start_background_process", "__system__");
        var appender = attachClampAppender();
        try {
            com.sun.net.httpserver.HttpServer stub = okStub();
            try {
                ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                        "http://127.0.0.1:" + stub.getAddress().getPort());
                // 模型未传 → 默认 7200 被 env 上限 3600 钳到 3600；来源均为 env。
                dispatch("{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                        + "\"params\":{\"name\":\"start_background_process\","
                        + "\"arguments\":{\"command\":\"echo hi\"}},\"id\":6}");
            } finally {
                stub.stop(0);
            }
            String message = clampMessages(appender).get(0);
            assertTrue(message.contains("event=job_timeout_clamp"), message);
            assertTrue(message.contains("valueOrigin=env"), message);
            assertTrue(message.contains("maxOrigin=env"), message);
            assertTrue(message.contains("value=3600"), message);
            assertTrue(message.contains("max=3600"), message);
            assertTrue(message.contains("param=absent"), message);
        } finally {
            detachClampAppender(appender);
        }
    }

    // ------------------------------------------------------------------
    // 四级来源判定（env > workspace > user* > instance > default）
    // ------------------------------------------------------------------

    @Test
    void jobTimeoutOrigin_resolvesAllFourLevels() {
        UUID user = UUID.randomUUID();
        UUID ws = UUID.randomUUID();
        String key = "defaultTimeoutSecs";

        // 无任何行 → default
        assertEquals("default",
                origin(key, user, ws));

        // instance 行 → instance
        when(configService.layerEntries(eq("instance"), eq("job-policy"), isNull(), isNull()))
                .thenReturn(Map.of(key, "3600"));
        assertEquals("instance", origin(key, user, ws));

        // workspace 行覆盖 instance → workspace
        when(configService.layerEntries(eq("workspace"), eq("job-policy"), isNull(), eq(ws)))
                .thenReturn(Map.of(key, "1800"));
        assertEquals("workspace", origin(key, user, ws));

        // env 覆盖一切 → env
        when(configService.envOverriddenKeys("job-policy")).thenReturn(Set.of(key));
        assertEquals("env", origin(key, user, ws));
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private String origin(String key, UUID user, UUID ws) {
        return ReflectionTestUtils.invokeMethod(
                controller, "jobTimeoutOrigin", key, user, ws);
    }

    private long timeoutOf(JsonNode arguments) {
        assertTrue(arguments.hasNonNull("timeout"),
                "arguments.timeout must be present, got: " + arguments);
        return arguments.get("timeout").asLong();
    }

    @SuppressWarnings("unchecked")
    private void seedToolCache(String tool, String serverId) {
        Map<String, Map<String, String>> cache =
                (Map<String, Map<String, String>>) ReflectionTestUtils.getField(controller, "toolServerCache");
        Map<String, Instant> timestamps =
                (Map<String, Instant>) ReflectionTestUtils.getField(controller, "cacheTimestamps");
        cache.put(TEST_WS_UUID, new ConcurrentHashMap<>(Map.of(tool, serverId)));
        timestamps.put(TEST_WS_UUID, Instant.now());
    }

    private ResponseEntity<String> dispatch(String body) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Chat-Run-Id", TEST_WS_UUID);
        return ReflectionTestUtils.invokeMethod(
                controller, "handleToolsCall", TEST_WS_UUID, body, headers, "sess-1",
                accessContext(TEST_WS_UUID, "u-1"));
    }

    private static Object accessContext(String wsId, String userId) {
        try {
            Class<?> accessClass = Class.forName(
                    "com.cc01cc.p.xihe.cp.mcp.McpProxyController$AccessContext");
            var constructor = accessClass.getDeclaredConstructor(
                    String.class, String.class, String.class, String.class);
            constructor.setAccessible(true);
            return constructor.newInstance(wsId, userId, null, null);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private com.sun.net.httpserver.HttpServer okStub() throws java.io.IOException {
        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        stub.createContext("/internal/v1/runtime/workspaces/" + TEST_WS_UUID + "/mcp", exchange -> {
            byte[] response = "{\"jsonrpc\":\"2.0\",\"result\":{\"content\":[],\"isError\":false},\"id\":1}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        stub.start();
        return stub;
    }

    private ch.qos.logback.core.read.ListAppender<
            ch.qos.logback.classic.spi.ILoggingEvent> attachClampAppender() {
        ch.qos.logback.classic.Logger logbackLogger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                        .getLogger(McpProxyController.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logbackLogger.addAppender(appender);
        return appender;
    }

    private void detachClampAppender(
            ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender) {
        ((ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                .getLogger(McpProxyController.class)).detachAppender(appender);
    }

    private java.util.List<String> clampMessages(
            ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender) {
        java.util.List<String> messages = appender.list.stream()
                .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                .filter(message -> message.contains("event=job_timeout_clamp"))
                .toList();
        assertFalse(messages.isEmpty(), "job_timeout_clamp must be logged on every dispatch");
        return messages;
    }
}
