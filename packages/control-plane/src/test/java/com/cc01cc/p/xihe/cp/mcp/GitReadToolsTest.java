package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.AgentSpawnExecutionService;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.ChatRunStatusReadService;
import com.cc01cc.p.xihe.cp.chat.DelegationBudgetService;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.ConfigService;
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
import com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0686 G8: the three read-only Git tools on the CP side — registration, dispatch, and the
 * failure shapes.
 *
 * <p>What this class exists to pin, in the order the D-64 rulings rank the risks:</p>
 *
 * <ul>
 *   <li><b>Unreachable Runtime is a 503, never an empty answer</b> (D-64 ④). A read tool that
 *       returns "no changes" when git or the Runtime is gone is the failure mode the whole feature
 *       is judged on, so it is asserted for all three tools in one method.</li>
 *   <li><b>Runtime refusals keep the Runtime's reason</b> (D-64 ③): they ride {@code isError=true}
 *       tool-results carrying {@code reason}, not a new {@code ToolRefusalCodes} entry and not a
 *       silent success.</li>
 *   <li><b>Not a repository is a success</b>: {@code isRepository=false} on a normal result.</li>
 *   <li><b>User callers are refused before any Runtime contact</b>, and bad arguments never reach
 *       the Runtime either.</li>
 * </ul>
 */
class GitReadToolsTest {

    private static final String WS = "66666666-6666-6666-6666-666666666666";
    private static final String USER_ID = "77777777-7777-7777-7777-777777777777";
    private static final String SESSION_ID = "55555555-5555-5555-5555-555555555555";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private RequestRewriter requestRewriter;
    private PolicyEngine policyEngine;
    private AuditLogger audit;
    private McpToolTimeoutService toolTimeoutService;
    private RuntimeCheckpointClient runtimeCheckpointClient;
    private McpProxyController controller;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        requestRewriter = mock(RequestRewriter.class);
        policyEngine = mock(PolicyEngine.class);
        when(policyEngine.loadContext(any(), any(), any())).thenReturn(PolicyContext.EMPTY);
        when(policyEngine.allowsByGrant(any(PolicyContext.class), anyString(), anyString(),
                anyString(), anyString(), anyString(), org.mockito.ArgumentMatchers.anyBoolean()))
                .thenReturn(true);
        when(policyEngine.evaluateVerdict(any(PolicyContext.class), anyString(), anyString(),
                anyString(), any(), any(), any()))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN,
                        "manual", "auto_allow"));
        // The face comes from the PRODUCTION registry: the read classification asserted below is
        // then a statement about ToolFaceRegistry, not about this fixture.
        ToolFaceRegistry realFaces = new ToolFaceRegistry();
        when(policyEngine.faceOf(any(PolicyContext.class), anyString()))
                .thenAnswer(call -> realFaces.faceOf(call.getArgument(1)));
        when(requestRewriter.rewrite(anyString(), anyString(), anyString()))
                .thenAnswer(invocation -> invocation.getArgument(1));
        // Internal-service dispatch requires a durable agent tool-call context; the point of this
        // class is the Git surface, so the context gate is stubbed open.
        when(policyEngine.hasCurrentAgentToolCall(any(), any(), any(), any(), any(), any()))
                .thenReturn(true);

        audit = mock(AuditLogger.class);
        var sessionService = mock(SessionService.class);
        when(sessionService.requireCurrent(eq(SESSION_ID), eq(USER_ID), eq(WS)))
                .thenReturn(new com.cc01cc.p.xihe.cp.entity.Session());
        var configService = mock(ConfigService.class);
        var toolTimeoutPolicy = new ToolTimeoutPolicy();
        toolTimeoutService = new McpToolTimeoutService(
                mock(McpServerRepository.class), configService, toolTimeoutPolicy);
        McpInvocationService mcpInvocationService = mock(McpInvocationService.class);
        lenient().when(mcpInvocationService.findAgentInvocation(any(), any()))
                .thenReturn(java.util.Optional.empty());
        LineageInvocationService lineageInvocationService = mock(LineageInvocationService.class);
        lenient().when(lineageInvocationService.reserve(any(), any(), any(), any(), any(), any()))
                .thenReturn(new LineageInvocationService.ReservationDecision(
                        LineageInvocationService.DecisionKind.NOT_LINEAGED, null));
        runtimeCheckpointClient = mock(RuntimeCheckpointClient.class);

        controller = new McpProxyController(
                requestRewriter, policyEngine, audit, mock(ApprovalService.class), MAPPER,
                mock(SseEmitterManager.class),
                new McpProxyCatalogService(mock(McpStdioServerRepository.class),
                        mock(McpServerRepository.class), mock(McpToolAliasRepository.class)),
                mock(WorkspaceService.class), sessionService,
                mock(com.cc01cc.p.xihe.cp.operation.JobStateService.class),
                configService, toolTimeoutPolicy,
                new org.springframework.mock.env.MockEnvironment(),
                mock(AgentSpawnExecutionService.class),
                mcpInvocationService, lineageInvocationService, toolTimeoutService,
                mock(com.cc01cc.p.xihe.cp.credentials.CredentialLeaseService.class),
                mock(com.cc01cc.p.xihe.cp.skill.SkillReadService.class),
                new com.cc01cc.p.xihe.cp.status.BuildVersion(),
                mock(DelegationBudgetService.class),
                mock(ChatRunStatusReadService.class),
                runtimeCheckpointClient);
        // Unreachable by default: any accidental Runtime forward fails fast instead of hanging.
        ReflectionTestUtils.setField(controller, "runtimeBaseUrl", "http://127.0.0.1:1");

        // Route seeds: the tool map already claims the three names, so tools/call dispatches as
        // CP-owned without a Runtime catalog probe (the same seeding skill_read uses).
        Map<String, String> seeded = new ConcurrentHashMap<>();
        seeded.put("git_status", "__cp__");
        seeded.put("git_diff", "__cp__");
        seeded.put("git_log", "__cp__");
        toolTimeoutService.putMapping(WS, seeded);
    }

    // ---------------------------------------------------------------- registration

    @Test
    void gitToolsAreRegisteredOnTheReadFaceWithTheStructuredShape() {
        ToolFaceRegistry registry = new ToolFaceRegistry();
        for (String tool : List.of("git_status", "git_diff", "git_log")) {
            ToolFaceRegistry.Face face = registry.faceOf(tool);
            assertEquals(ToolFaceRegistry.ACTION_READ, face.actionClass(),
                    tool + " must ride the existing read atom (spec §3.5), got " + face);
            assertEquals(ToolShape.STRUCTURED, face.shape(), tool + " must keep the STRUCTURED shape");
        }
    }

    @Test
    void toolsListPublishesTheThreeGitToolsWithBoundedSchemas() throws Exception {
        com.sun.net.httpserver.HttpServer stub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        stub.createContext("/internal/v1/runtime/workspaces/" + WS + "/mcp", exchange -> {
            byte[] response = ("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":"
                    + "\"read_file\",\"description\":\"reads\",\"inputSchema\":{\"type\":\"object\"}}],"
                    + "\"resultType\":\"complete\"}}")
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        stub.start();
        try {
            ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                    "http://127.0.0.1:" + stub.getAddress().getPort());
            ResponseEntity<String> response = listToolsAs(internalAccessContext());
            assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());

            Map<String, JsonNode> byName = new java.util.LinkedHashMap<>();
            JsonNode tools = MAPPER.readTree(response.getBody()).path("result").path("tools");
            for (JsonNode tool : tools) {
                byName.put(tool.path("name").asText(), tool);
            }
            for (String name : List.of("git_status", "git_diff", "git_log")) {
                JsonNode tool = byName.get(name);
                assertNotNull(tool, name + " must be published, got " + byName.keySet());
                JsonNode schema = tool.path("inputSchema");
                assertEquals("object", schema.path("type").asText(), name + " inputSchema");
                assertFalse(schema.path("additionalProperties").asBoolean(true),
                        name + " inputSchema must reject additional properties");
            }
            JsonNode logSchema = byName.get("git_log").path("inputSchema").path("properties");
            assertEquals(1, logSchema.path("limit").path("minimum").asInt());
            assertEquals(200, logSchema.path("limit").path("maximum").asInt());
            assertEquals("integer", logSchema.path("limit").path("type").asText());
            assertEquals("array", byName.get("git_diff").path("inputSchema")
                    .path("properties").path("paths").path("type").asText());
        } finally {
            stub.stop(0);
        }
    }

    // ---------------------------------------------------------------- caller gating

    @Test
    void userCallerIsRefusedBeforeAnyRuntimeContact() throws Exception {
        ResponseEntity<String> response = handleAs(gitBody("git_diff", "{}"), accessContext(false));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), response.getBody());
        JsonNode problem = MAPPER.readTree(response.getBody());
        assertEquals("FORBIDDEN", problem.path("code").asText());
        verify(audit).record(eq(SESSION_ID), eq("git_diff"), eq("caller_tool_denied"), anyString());
        verifyNoInteractions(runtimeCheckpointClient);
    }

    // ---------------------------------------------------------------- dependency failure

    @Test
    void unreachableRuntimeIs503ForAllThreeToolsAndNeverAnEmptySuccess() throws Exception {
        when(runtimeCheckpointClient.workspaceGitStatus(WS)).thenReturn(
                new RuntimeCheckpointClient.GitStatusResult(
                        RuntimeCheckpointClient.Outcome.TRANSPORT, false, List.of(), "unreachable"));
        when(runtimeCheckpointClient.workspaceGitDiff(eq(WS), any())).thenReturn(
                new RuntimeCheckpointClient.GitDiffResult(
                        RuntimeCheckpointClient.Outcome.TRANSPORT, false, null, false, 0, "unreachable"));
        when(runtimeCheckpointClient.workspaceGitLog(eq(WS), any(Integer.class), any(), any()))
                .thenReturn(new RuntimeCheckpointClient.GitLogResult(
                        RuntimeCheckpointClient.Outcome.TRANSPORT, false, List.of(), false,
                        "unreachable"));

        for (String tool : List.of("git_status", "git_diff", "git_log")) {
            ResponseEntity<String> response = handleAs(gitBody(tool, "{}"), internalAccessContext());
            assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode(),
                    tool + " must fail closed, got: " + response.getBody());
            JsonNode problem = MAPPER.readTree(response.getBody());
            assertEquals("RUNTIME_UNAVAILABLE", problem.path("code").asText(), tool);
            assertEquals("runtime", problem.path("dependency").asText(), tool);
            assertEquals("unreachable", problem.path("reason").asText(), tool);
            assertTrue(problem.path("retryable").asBoolean(), tool + " must be retryable");
            verify(audit).record(eq(SESSION_ID), eq(tool), eq("dependency_unavailable"),
                    eq("runtime:unreachable"));
        }
    }

    @Test
    void runtimeRefusalBecomesAnErrorToolResultCarryingTheRuntimeReason() throws Exception {
        when(runtimeCheckpointClient.workspaceGitStatus(WS)).thenReturn(
                new RuntimeCheckpointClient.GitStatusResult(
                        RuntimeCheckpointClient.Outcome.UNAVAILABLE, false, List.of(),
                        "GIT_UNAVAILABLE"));

        ResponseEntity<String> response = handleAs(gitBody("git_status", "{}"),
                internalAccessContext());

        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        JsonNode result = MAPPER.readTree(response.getBody()).path("result");
        assertTrue(result.path("isError").asBoolean(),
                "an unavailable git must be an error tool-result, got: " + response.getBody());
        assertEquals("GIT_UNAVAILABLE", result.path("structuredContent").path("reason").asText());
        assertEquals("Tool error: GIT_UNAVAILABLE",
                result.path("content").get(0).path("text").asText());
        assertTrue(result.path("structuredContent").path("entries").isMissingNode(),
                "no entries may be fabricated for a refused read");
        verify(audit).record(eq(SESSION_ID), eq("git_status"), eq("tool_error"),
                eq("GIT_UNAVAILABLE"));
    }

    @Test
    void runtimeArgumentRejectionBecomesInvalidArgumentsToolResult() throws Exception {
        when(runtimeCheckpointClient.workspaceGitLog(eq(WS), any(Integer.class), any(), any()))
                .thenReturn(new RuntimeCheckpointClient.GitLogResult(
                        RuntimeCheckpointClient.Outcome.INVALID_REQUEST, false, List.of(), false,
                        "CHECKPOINT_INVALID_REQUEST"));

        ResponseEntity<String> response = handleAs(gitBody("git_log", "{\"range\":\"nope\"}"),
                internalAccessContext());

        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        JsonNode result = MAPPER.readTree(response.getBody()).path("result");
        assertTrue(result.path("isError").asBoolean());
        assertEquals("INVALID_ARGUMENTS", result.path("structuredContent").path("code").asText());
        assertEquals("CHECKPOINT_INVALID_REQUEST",
                result.path("structuredContent").path("reason").asText());
    }

    // ---------------------------------------------------------------- not a repository

    @Test
    void notARepositoryIsASuccessForEveryTool() throws Exception {
        when(runtimeCheckpointClient.workspaceGitStatus(WS)).thenReturn(
                new RuntimeCheckpointClient.GitStatusResult(
                        RuntimeCheckpointClient.Outcome.OK, false, List.of(), null));
        when(runtimeCheckpointClient.workspaceGitDiff(eq(WS), any())).thenReturn(
                new RuntimeCheckpointClient.GitDiffResult(
                        RuntimeCheckpointClient.Outcome.OK, false, "", false, 0, null));
        when(runtimeCheckpointClient.workspaceGitLog(eq(WS), any(Integer.class), any(), any()))
                .thenReturn(new RuntimeCheckpointClient.GitLogResult(
                        RuntimeCheckpointClient.Outcome.OK, false, List.of(), false, null));

        for (String tool : List.of("git_status", "git_diff", "git_log")) {
            ResponseEntity<String> response = handleAs(gitBody(tool, "{}"), internalAccessContext());
            assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
            JsonNode result = MAPPER.readTree(response.getBody()).path("result");
            assertFalse(result.path("isError").asBoolean(false), tool + ": " + response.getBody());
            assertFalse(result.path("structuredContent").path("isRepository").asBoolean(true),
                    tool + " must report isRepository=false");
        }
    }

    // ---------------------------------------------------------------- success mapping

    @Test
    void gitStatusPassesEntriesThrough() throws Exception {
        when(runtimeCheckpointClient.workspaceGitStatus(WS)).thenReturn(
                new RuntimeCheckpointClient.GitStatusResult(
                        RuntimeCheckpointClient.Outcome.OK, true,
                        List.of(new RuntimeCheckpointClient.GitStatusEntry("M", "src/main.rs")), null));

        JsonNode output = structured(handleAs(gitBody("git_status", "{}"),
                internalAccessContext()));

        assertTrue(output.path("isRepository").asBoolean());
        assertEquals("M", output.path("entries").get(0).path("status").asText());
        assertEquals("src/main.rs", output.path("entries").get(0).path("path").asText());
    }

    @Test
    void gitDiffForwardsPathsAndCopiesPatchAndTruncation() throws Exception {
        when(runtimeCheckpointClient.workspaceGitDiff(WS, List.of("src/a.rs", "src/b.rs")))
                .thenReturn(new RuntimeCheckpointClient.GitDiffResult(
                        RuntimeCheckpointClient.Outcome.OK, true, "diff --git a/src/a.rs\n",
                        true, 1234, null));

        JsonNode output = structured(handleAs(
                gitBody("git_diff", "{\"paths\":[\"src/a.rs\",\"src/b.rs\"]}"),
                internalAccessContext()));

        assertEquals("diff --git a/src/a.rs\n", output.path("patch").asText());
        assertTrue(output.path("truncated").asBoolean(),
                "a cut patch must stay visibly truncated");
        assertEquals(1234, output.path("patchBytes").asInt());
        verify(runtimeCheckpointClient).workspaceGitDiff(WS, List.of("src/a.rs", "src/b.rs"));
    }

    @Test
    void gitLogDefaultsToTwentyAndForwardsExplicitArguments() throws Exception {
        when(runtimeCheckpointClient.workspaceGitLog(eq(WS), any(Integer.class), any(), any()))
                .thenReturn(new RuntimeCheckpointClient.GitLogResult(
                        RuntimeCheckpointClient.Outcome.OK, true,
                        List.of(new RuntimeCheckpointClient.GitLogEntry(
                                "abc123", "abc", "drafter", "2026-11-07T00:00:00Z", "G8")),
                        true, null));

        JsonNode output = structured(handleAs(gitBody("git_log", "{}"),
                internalAccessContext()));
        assertEquals(1, output.path("entries").size());
        assertEquals("abc123", output.path("entries").get(0).path("hash").asText());
        assertTrue(output.path("truncated").asBoolean(),
                "truncated means 'more matched than limit', and must be reported");
        verify(runtimeCheckpointClient).workspaceGitLog(WS, 20, List.of(), null);

        handleAs(gitBody("git_log",
                "{\"limit\":5,\"paths\":[\"src\"],\"range\":\"main..HEAD\"}"),
                internalAccessContext());
        verify(runtimeCheckpointClient).workspaceGitLog(WS, 5, List.of("src"), "main..HEAD");
    }

    // ---------------------------------------------------------------- argument validation

    @Test
    void outOfWindowLimitIsAnArgumentErrorWithoutRuntimeContact() throws Exception {
        for (String arguments : List.of("{\"limit\":0}", "{\"limit\":201}", "{\"limit\":\"5\"}")) {
            ResponseEntity<String> response = handleAs(gitBody("git_log", arguments),
                    internalAccessContext());
            assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
            JsonNode result = MAPPER.readTree(response.getBody()).path("result");
            assertTrue(result.path("isError").asBoolean(), arguments + ": " + response.getBody());
            assertEquals("INVALID_ARGUMENTS",
                    result.path("structuredContent").path("code").asText(), arguments);
        }
        verify(audit, org.mockito.Mockito.atLeastOnce()).record(
                eq(SESSION_ID), eq("git_log"), eq("tool_error"), eq("INVALID_ARGUMENTS"));
        verifyNoInteractions(runtimeCheckpointClient);
    }

    @Test
    void nonArrayPathsIsAnArgumentErrorWithoutRuntimeContact() throws Exception {
        ResponseEntity<String> response = handleAs(
                gitBody("git_diff", "{\"paths\":\"src\"}"), internalAccessContext());

        JsonNode result = MAPPER.readTree(response.getBody()).path("result");
        assertTrue(result.path("isError").asBoolean(), response.getBody());
        assertEquals("INVALID_ARGUMENTS", result.path("structuredContent").path("code").asText());
        verifyNoInteractions(runtimeCheckpointClient);
    }

    // ---------------------------------------------------------------- helpers

    private static String gitBody(String tool, String arguments) {
        return "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":7,\"params\":{\"name\":\""
                + tool + "\",\"arguments\":" + arguments + "}}";
    }

    @SuppressWarnings("unchecked")
    private ResponseEntity<String> handleAs(String body, Object access) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        return (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                controller, "handleToolsCall", WS, body, headers, SESSION_ID, access);
    }

    @SuppressWarnings("unchecked")
    private ResponseEntity<String> listToolsAs(Object access) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        return (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                controller, "handleToolsList", WS,
                "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1,\"params\":{}}",
                headers, SESSION_ID, access);
    }

    private static JsonNode structured(ResponseEntity<String> response) throws Exception {
        return MAPPER.readTree(response.getBody()).path("result").path("structuredContent");
    }

    private static Object accessContext(boolean internalService) throws Exception {
        Class<?> accessClass = Class.forName(
                "com.cc01cc.p.xihe.cp.mcp.McpProxyController$AccessContext");
        var constructor = accessClass.getDeclaredConstructor(
                String.class, String.class, String.class, boolean.class);
        constructor.setAccessible(true);
        return constructor.newInstance(WS, USER_ID, SESSION_ID, internalService);
    }

    private static Object internalAccessContext() throws Exception {
        return accessContext(true);
    }
}
