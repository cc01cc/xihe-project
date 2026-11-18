package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.AgentSpawnExecutionService;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.chat.TeamTaskService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * task-188 MVP5: the four CP-owned team_task_* tools end to end on the CP side — tools/list
 * definitions, tools/call dispatch into TeamTaskService, and the failure envelopes.
 *
 * <p>The face under evaluation is the PRODUCTION registry's (TEAM_TASK_MANAGE / STRUCTURED, V172)
 * — the same resolution the outer MCP gate runs, so authorization-by-face is asserted against the
 * shipped classification, not a fixture's opinion. TeamTaskService itself is mocked: the
 * grant gate and row-local rules have their own suite (TeamTaskServiceTest); this class pins the
 * wire: shapes, argument validation, coded error passthrough, and the identity handed to the
 * service (tool name, session owner, workspace, the X-Session-Id application session).</p>
 */
class TeamTaskMcpDispatchTest {

    private static final String WS = "66666666-6666-6666-6666-666666666666";
    private static final String USER_ID = "77777777-7777-7777-7777-777777777777";
    private static final String SESSION_ID = "55555555-5555-5555-5555-555555555555";
    private static final String TASK_ID = "88888888-8888-8888-8888-888888888888";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private PolicyEngine policyEngine;
    private McpToolTimeoutService toolTimeoutService;
    private TeamTaskService teamTaskService;
    private McpProxyController controller;
    private com.sun.net.httpserver.HttpServer runtimeStub;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() throws Exception {
        var requestRewriter = mock(RequestRewriter.class);
        when(requestRewriter.rewrite(anyString(), anyString(), anyString()))
                .thenAnswer(invocation -> invocation.getArgument(1));
        policyEngine = mock(PolicyEngine.class);
        when(policyEngine.loadContext(any(), any(), any())).thenReturn(PolicyContext.EMPTY);
        when(policyEngine.allowsByGrant(any(PolicyContext.class), anyString(), anyString(),
                anyString(), anyString(), anyString(), org.mockito.ArgumentMatchers.anyBoolean()))
                .thenReturn(true);
        when(policyEngine.evaluateVerdict(any(PolicyContext.class), anyString(), anyString(),
                anyString(), any(), any(), any()))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN,
                        "manual", "auto_allow"));
        ToolFaceRegistry realFaces = new ToolFaceRegistry();
        when(policyEngine.faceOf(any(PolicyContext.class), anyString()))
                .thenAnswer(call -> realFaces.faceOf(call.getArgument(1)));
        when(policyEngine.hasCurrentAgentToolCall(any(), any(), any(), any(), any(), any()))
                .thenReturn(true);

        AuditLogger audit = mock(AuditLogger.class);
        ApprovalService approvalService = mock(ApprovalService.class);
        SseEmitterManager sse = mock(SseEmitterManager.class);
        SessionService sessionService = mock(SessionService.class);
        teamTaskService = mock(TeamTaskService.class);

        var configService = mock(com.cc01cc.p.xihe.cp.config.ConfigService.class);
        var toolTimeoutPolicy = new com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy();
        toolTimeoutService = new McpToolTimeoutService(
                mock(McpServerRepository.class), configService, toolTimeoutPolicy);
        McpInvocationService mcpInvocationService = mock(McpInvocationService.class);
        lenient().when(mcpInvocationService.findAgentInvocation(any(), any()))
                .thenReturn(Optional.empty());
        LineageInvocationService lineageInvocationService = mock(LineageInvocationService.class);
        lenient().when(lineageInvocationService.reserve(any(), any(), any(), any(), any(), any()))
                .thenReturn(new LineageInvocationService.ReservationDecision(
                        LineageInvocationService.DecisionKind.NOT_LINEAGED, null));

        controller = new McpProxyController(
                requestRewriter, policyEngine, audit, approvalService, MAPPER, sse,
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
                mock(com.cc01cc.p.xihe.cp.chat.DelegationBudgetService.class),
                mock(com.cc01cc.p.xihe.cp.chat.ChatRunStatusReadService.class),
                mock(com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient.class),
                teamTaskService,
                new com.cc01cc.p.xihe.cp.plugin.PluginToolCatalogFilter(
                        org.mockito.Mockito.mock(
                                com.cc01cc.p.xihe.cp.plugin.PluginRunCatalogSnapshotService.class),
                        false));
        ReflectionTestUtils.setField(controller, "runtimeBaseUrl", "http://localhost:9091");

        // Route seeds: the tool map already knows the four names, so no Runtime probe is attempted
        // on the tools/call path (the tools/list test spins its own stub).
        Map<String, String> seeded = new ConcurrentHashMap<>();
        seeded.put("team_task_create", "__cp__");
        seeded.put("team_task_list", "__cp__");
        seeded.put("team_task_get", "__cp__");
        seeded.put("team_task_update", "__cp__");
        toolTimeoutService.putMapping(WS, seeded);
    }

    @AfterEach
    void tearDown() {
        if (runtimeStub != null) {
            runtimeStub.stop(0);
        }
    }

    // ---------------------------------------------------------------- helpers

    private static TeamTaskService.TeamTaskView sampleView(
            String taskId, long taskNo, long revision, String subject) {
        return new TeamTaskService.TeamTaskView(
                taskId, SESSION_ID, taskNo, revision, subject, null,
                "open", true, null, null, List.of(), List.of(), SESSION_ID,
                Instant.parse("2026-11-18T01:00:00Z"), Instant.parse("2026-11-18T01:00:00Z"));
    }

    private static String callBody(String tool, String argumentsJson) {
        return "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":7,"
                + "\"params\":{\"name\":\"" + tool + "\",\"arguments\":" + argumentsJson + "}}";
    }

    @SuppressWarnings("unchecked")
    private ResponseEntity<String> handle(String body) throws Exception {
        return handleAs(body, accessContext(SESSION_ID, true));
    }

    @SuppressWarnings("unchecked")
    private ResponseEntity<String> handleAs(String body, Object access) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Chat-Run-Id", "11111111-1111-1111-1111-111111111111");
        return (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                controller, "handleToolsCall", WS, body, headers, SESSION_ID, access);
    }

    private static JsonNode structured(ResponseEntity<String> response) throws Exception {
        return MAPPER.readTree(response.getBody()).path("result").path("structuredContent");
    }

    /** The controller's private AccessContext record, built the way its own callers do. */
    private static Object accessContext(String applicationSessionId, boolean internalService)
            throws Exception {
        Class<?> accessClass = Class.forName(
                "com.cc01cc.p.xihe.cp.mcp.McpProxyController$AccessContext");
        var constructor = accessClass.getDeclaredConstructor(
                String.class, String.class, String.class, boolean.class);
        constructor.setAccessible(true);
        return constructor.newInstance(WS, USER_ID, applicationSessionId, internalService);
    }

    // ---------------------------------------------------------------- tools/list

    @Test
    @SuppressWarnings("unchecked")
    void toolsListSurfacesTheFourDefinitions() throws Exception {
        runtimeStub = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        runtimeStub.createContext("/internal/v1/runtime/workspaces/" + WS + "/mcp", exchange -> {
            byte[] bytes = "{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]},\"id\":1}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        runtimeStub.start();
        ReflectionTestUtils.setField(controller, "runtimeBaseUrl",
                "http://127.0.0.1:" + runtimeStub.getAddress().getPort());

        String listBody =
                "{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1,\"params\":{}}";
        ResponseEntity<String> response = (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                controller, "handleToolsList", WS, listBody, new HttpHeaders(), SESSION_ID,
                accessContext(SESSION_ID, true));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        JsonNode tools = MAPPER.readTree(response.getBody()).path("result").path("tools");
        Map<String, JsonNode> byName = new java.util.HashMap<>();
        tools.forEach(tool -> byName.put(tool.path("name").asText(), tool));
        for (String name : new String[]{"team_task_create", "team_task_list",
                "team_task_get", "team_task_update"}) {
            assertTrue(byName.containsKey(name), "tools/list must surface " + name);
        }
        JsonNode create = byName.get("team_task_create");
        assertTrue(create.path("inputSchema").path("required").toString().contains("subject"));
        JsonNode update = byName.get("team_task_update");
        assertTrue(update.path("inputSchema").path("required").toString()
                .contains("expectedRevision"));
        JsonNode actionEnum = update.path("inputSchema").path("properties").path("action")
                .path("enum");
        assertEquals(6, actionEnum.size(), "six lifecycle verbs frozen");
        assertTrue(byName.get("team_task_list").path("inputSchema").path("properties").isEmpty());
    }

    // ---------------------------------------------------------------- call dispatch: shapes

    @Test
    void createReturnsTheFifteenFieldRow() throws Exception {
        TeamTaskService.TeamTaskView created = sampleView(TASK_ID, 1, 0, "write tests");
        when(teamTaskService.create(eq("team_task_create"), eq(USER_ID), eq(WS), eq(SESSION_ID),
                eq("write tests"), isNull(), eq(List.of("a")), isNull())).thenReturn(created);

        JsonNode structured = structured(handle(callBody("team_task_create",
                "{\"subject\":\"write tests\",\"blockedBy\":[\"a\"]}")));

        assertEquals(TASK_ID, structured.path("taskId").asText());
        assertEquals("write tests", structured.path("subject").asText());
        assertEquals(15, structured.size(), "the canonical TeamTaskView wire row, nothing more");
        assertEquals(SESSION_ID, structured.path("teamRootSessionId").asText());
        verify(teamTaskService).create(eq("team_task_create"), eq(USER_ID), eq(WS), eq(SESSION_ID),
                eq("write tests"), isNull(), eq(List.of("a")), isNull());
    }

    @Test
    void listReturnsATasksArray() throws Exception {
        when(teamTaskService.list(eq("team_task_list"), eq(USER_ID), eq(WS), eq(SESSION_ID)))
                .thenReturn(List.of(sampleView(TASK_ID, 1, 0, "write tests"), sampleView(TASK_ID, 2, 3, "other task")));

        JsonNode structured = structured(handle(callBody("team_task_list", "{}")));

        assertTrue(structured.path("tasks").isArray());
        assertEquals(2, structured.path("tasks").size());
        assertEquals(1, structured.path("tasks").get(0).path("taskNo").asLong());
        assertEquals(3, structured.path("tasks").get(1).path("revision").asLong());
    }

    @Test
    void getPassesTheTaskIdThrough() throws Exception {
        when(teamTaskService.get(eq("team_task_get"), eq(USER_ID), eq(WS), eq(SESSION_ID),
                eq(TASK_ID))).thenReturn(sampleView(TASK_ID, 1, 0, "write tests"));

        JsonNode structured = structured(handle(
                callBody("team_task_get", "{\"taskId\":\"" + TASK_ID + "\"}")));

        assertEquals(TASK_ID, structured.path("taskId").asText());
        verify(teamTaskService).get(eq("team_task_get"), eq(USER_ID), eq(WS), eq(SESSION_ID),
                eq(TASK_ID));
    }

    @Test
    void updatePassesEveryArgumentThrough() throws Exception {
        when(teamTaskService.update(eq("team_task_update"), eq(USER_ID), eq(WS), eq(SESSION_ID),
                eq(TASK_ID), eq("update_details"), eq(4L),
                isNull(), eq("new subject"), eq("new description"), isNull(),
                eq(List.of("x")), isNull())).thenReturn(sampleView(TASK_ID, 1, 5, "write tests"));

        JsonNode structured = structured(handle(callBody("team_task_update",
                "{\"taskId\":\"" + TASK_ID + "\",\"action\":\"update_details\","
                        + "\"expectedRevision\":4,\"subject\":\"new subject\","
                        + "\"description\":\"new description\",\"blockedBy\":[\"x\"]}")));

        assertEquals(5, structured.path("revision").asLong());
        verify(teamTaskService).update(eq("team_task_update"), eq(USER_ID), eq(WS), eq(SESSION_ID),
                eq(TASK_ID), eq("update_details"), eq(4L),
                isNull(), eq("new subject"), eq("new description"), isNull(),
                eq(List.of("x")), isNull());
    }

    // ---------------------------------------------------------------- failure envelopes

    @Test
    void forbiddenIsACodedToolErrorNotAnHttpError() throws Exception {
        when(teamTaskService.create(anyString(), anyString(), anyString(), anyString(),
                anyString(), isNull(), isNull(), isNull()))
                .thenThrow(new CpApiException(HttpStatus.FORBIDDEN, "TEAM_TASK_FORBIDDEN",
                        "an explicit TEAM_TASK_MANAGE grant is required"));

        ResponseEntity<String> response =
                handle(callBody("team_task_create", "{\"subject\":\"x\"}"));
        JsonNode root = MAPPER.readTree(response.getBody());

        assertEquals(HttpStatus.OK, response.getStatusCode(), "CP decisions ride the tool envelope");
        assertTrue(root.path("result").path("isError").asBoolean());
        assertEquals("TEAM_TASK_FORBIDDEN",
                root.path("result").path("structuredContent").path("code").asText());
    }

    @Test
    void notFoundAndConflictPassTheirCodesThrough() throws Exception {
        when(teamTaskService.get(eq("team_task_get"), anyString(), anyString(), anyString(),
                eq("99999999-9999-9999-9999-999999999999")))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "TEAM_TASK_NOT_FOUND",
                        "no such task on this board"));
        when(teamTaskService.update(anyString(), anyString(), anyString(), anyString(), anyString(),
                eq("claim"), any(), isNull(), isNull(), isNull(), isNull(), isNull(), isNull()))
                .thenThrow(new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                        "expectedRevision does not match the current revision"));

        assertEquals("TEAM_TASK_NOT_FOUND", structured(handle(callBody("team_task_get",
                "{\"taskId\":\"99999999-9999-9999-9999-999999999999\"}"))).path("code").asText());
        assertEquals("TEAM_TASK_CONFLICT", structured(handle(callBody("team_task_update",
                "{\"taskId\":\"" + TASK_ID + "\",\"action\":\"claim\",\"expectedRevision\":0}")))
                .path("code").asText());
    }

    // ---------------------------------------------------------------- argument validation

    @Test
    void missingTaskIdOnGetIsAnArgumentErrorBeforeDispatch() throws Exception {
        JsonNode structured = structured(handle(callBody("team_task_get", "{}")));

        assertEquals("INVALID_ARGUMENTS", structured.path("code").asText());
        verify(teamTaskService, never()).get(anyString(), anyString(), anyString(), anyString(),
                anyString());
    }

    @Test
    void missingOrNonIntegerExpectedRevisionOnUpdateIsAnArgumentError() throws Exception {
        assertEquals("INVALID_ARGUMENTS", structured(handle(callBody("team_task_update",
                "{\"taskId\":\"" + TASK_ID + "\",\"action\":\"claim\"}"))).path("code").asText());
        assertEquals("INVALID_ARGUMENTS", structured(handle(callBody("team_task_update",
                "{\"taskId\":\"" + TASK_ID + "\",\"action\":\"claim\","
                        + "\"expectedRevision\":\"4\"}"))).path("code").asText());
        verify(teamTaskService, never()).update(anyString(), anyString(), anyString(), anyString(),
                anyString(), anyString(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void nonStringListEntryIsAnArgumentError() throws Exception {
        JsonNode structured = structured(handle(callBody("team_task_create",
                "{\"subject\":\"x\",\"blockedBy\":[7]}")));

        assertEquals("INVALID_ARGUMENTS", structured.path("code").asText());
        verify(teamTaskService, never()).create(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), any(), any());
    }

    // ---------------------------------------------------------------- caller gates

    @Test
    void userCallerIsRefusedBeforeTheServiceIsTouched() throws Exception {
        ResponseEntity<String> response = handleAs(
                callBody("team_task_list", "{}"), accessContext(SESSION_ID, false));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
        verify(teamTaskService, never()).list(anyString(), anyString(), anyString(), anyString());
    }

    @Test
    void missingSessionContextIsRefusedByTheGenericAgentGate() throws Exception {
        ResponseEntity<String> resp = handleAs(callBody("team_task_list", "{}"),
                accessContext(null, true));

        assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode(),
                "the generic internal-service gate owns session identity (agent_session_required)");
        verify(teamTaskService, never()).list(anyString(), anyString(), anyString(), anyString());
    }

}