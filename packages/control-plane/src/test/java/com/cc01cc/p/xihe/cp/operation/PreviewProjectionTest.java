package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.AgentSpawnExecutionService;
import com.cc01cc.p.xihe.cp.chat.AnswererChain;
import com.cc01cc.p.xihe.cp.chat.ApprovalAgentClient;
import com.cc01cc.p.xihe.cp.chat.ApprovalGrantWriter;
import com.cc01cc.p.xihe.cp.chat.ApprovalPendingStore;
import com.cc01cc.p.xihe.cp.chat.ApprovalPolicySummary;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.AutoReviewAnswerer;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.chat.UserAnswerer;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;
import com.cc01cc.p.xihe.cp.mcp.McpProxyController;
import com.cc01cc.p.xihe.cp.mcp.RequestRewriter;
import com.cc01cc.p.xihe.cp.policy.BuiltinPolicyContextProvider;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyRevision;
import com.cc01cc.p.xihe.cp.policy.SessionApprovalMode;
import com.cc01cc.p.xihe.cp.policy.SessionPolicyState;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpHeaders;
import org.springframework.mock.env.MockEnvironment;

import java.lang.reflect.Method;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0407 T2.9 · verify V7：preview 三路径原文投影断言（spec §7 [d8]、design 决策 #8）。
 *
 * <p>不变式：Agent relay、Approval ledger、MCP gateway 三条写入路径的 preview 是业务原文的
 * 有界投影（禁正则改写业务原文）；日志出口仍由 {@link LogRedactor} 在编码器边界脱敏——
 * 「投影保留原文」与「日志出口脱敏」共存，互不回归。业务 payload 形似敏感
 * （Bearer、{@code "token":"..."} 形状）但不是真实密钥。</p>
 */
class PreviewProjectionTest {

    private static final String RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String OPERATION_ID = "22222222-2222-2222-2222-222222222222";
    private static final String MCP_OPERATION_ID = "99999999-9999-9999-9999-999999999999";
    private static final String REQUEST_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    private static final String USER_ID = "33333333-3333-3333-3333-333333333333";
    private static final String WORKSPACE_ID = "44444444-4444-4444-4444-444444444444";
    private static final String SESSION_ID = "55555555-5555-5555-5555-555555555555";
    private static final String JOB_ITEM_ID = "77777777-7777-7777-7777-777777777777";

    /** 三路径 ledger preview 的有界上界（design #52：ledger preview 上限 4096 字符）。 */
    private static final int PREVIEW_BOUND = 4096;

    /** 业务原文：形似敏感（Bearer / token 形状）但非真实密钥，正则脱敏会改写它。 */
    private static final String BUSINESS_NOTE =
            "sk-looks-like-a-key but is business prose \"path=C:\\x\" #tag @mention"
                    + " Authorization: Bearer abc123-not-a-secret token=preview-keeps-original";

    /** {@link #BUSINESS_NOTE} 的 JSON 字符串字面形态（逐字节断言锚点，手写不得改写）。 */
    private static final String ESCAPED_BUSINESS_NOTE =
            "sk-looks-like-a-key but is business prose \\\"path=C:\\\\x\\\" #tag @mention"
                    + " Authorization: Bearer abc123-not-a-secret token=preview-keeps-original";

    private static final String EXPECTED_AGENT_PREVIEW =
            "{\"note\":\"" + ESCAPED_BUSINESS_NOTE + "\",\"token\":\"literal-user-data\"}";

    private final ObjectMapper mapper = new ObjectMapper();
    private final OperationService operationService = mock(OperationService.class);
    private final ChatRunRepository chatRunRepository = mock(ChatRunRepository.class);
    private final JobStateService jobStateService = mock(JobStateService.class);
    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final RuntimeJobClient runtimeJobClient = mock(RuntimeJobClient.class);
    private final ChatApprovalRepository approvals = mock(ChatApprovalRepository.class);
    private final PolicyRevision policyRevision = mock(PolicyRevision.class);
    private final WorkspaceRepository workspaceRepository = mock(WorkspaceRepository.class);
    private final AuditLogger auditLogger = mock(AuditLogger.class);

    private LedgerToolRecorder recorder;
    private ApprovalService approvalService;
    private McpProxyController mcpController;
    private WorkspaceJobStartService workspaceJobStartService;

    @BeforeEach
    void setUp() {
        when(policyRevision.current()).thenReturn(0L);
        Workspace generationZero = new Workspace();
        generationZero.setGeneration(0);
        when(workspaceRepository.findById(UUID.fromString(WORKSPACE_ID)))
                .thenReturn(Optional.of(generationZero));

        recorder = new LedgerToolRecorder(operationService, chatRunRepository, mapper);

        ApprovalPolicySummary policySummary = new ApprovalPolicySummary(
                new PolicyEngine(auditLogger, new BuiltinPolicyContextProvider()));
        approvalService = new ApprovalService(
                approvals, chatRunRepository, mock(ApprovalAgentClient.class), mapper,
                operationService, mock(ApprovalGrantWriter.class), auditLogger, policySummary,
                new ApprovalPendingStore(approvals, mapper, policySummary),
                new SessionPolicyState(), mock(SessionApprovalMode.class), policyRevision,
                workspaceRepository,
                new AnswererChain(List.of(new UserAnswerer(), new AutoReviewAnswerer())));

        mcpController = new McpProxyController(
                mock(RequestRewriter.class), mock(PolicyEngine.class), auditLogger,
                approvalService, mapper, mock(SseEmitterManager.class),
                mock(McpStdioServerRepository.class), mock(McpServerRepository.class),
                mock(McpToolAliasRepository.class), workspaceService,
                mock(SessionRepository.class), operationService, jobStateService,
                mock(ConfigService.class), new ToolTimeoutPolicy(), new MockEnvironment(),
                mock(AgentSpawnExecutionService.class));

        workspaceJobStartService = new WorkspaceJobStartService(
                operationService, jobStateService, workspaceService, runtimeJobClient);
    }

    @Test
    void agentRelayPreviewProjectsOriginalBusinessPayloadByteForByte() throws Exception {
        String preview = captureAgentRelayPreview(sampleArguments());

        assertEquals(EXPECTED_AGENT_PREVIEW, preview);
        assertEquals(BUSINESS_NOTE, mapper.readTree(preview).path("note").asText(),
                "Agent relay preview 必须逐字节保留业务原文");
        assertFalse(preview.contains(LogRedactor.REDACTED));
    }

    @Test
    void approvalLedgerPreviewProjectsOriginalBusinessPayloadByteForByte() throws Exception {
        String expiresAt = Instant.now().plusSeconds(60).toString();

        String preview = captureApprovalLedgerPreview(approvalPayload(expiresAt));

        assertEquals(expectedApprovalPreview(ESCAPED_BUSINESS_NOTE, expiresAt, null), preview);
        assertEquals(BUSINESS_NOTE, mapper.readTree(preview).path("details").asText(),
                "Approval ledger preview 必须逐字节保留业务原文");
        assertFalse(preview.contains(LogRedactor.REDACTED));
    }

    @Test
    void mcpGatewayPreviewProjectsOriginalRequestBodyByteForByte() throws Exception {
        String body = mcpCallBody(ESCAPED_BUSINESS_NOTE);

        String preview = captureMcpGatewayPreview(body);

        assertEquals(body, preview, "MCP gateway preview 必须等于原始请求正文");
        assertEquals(BUSINESS_NOTE,
                mapper.readTree(preview).path("params").path("arguments").path("note").asText());
        assertFalse(preview.contains(LogRedactor.REDACTED));
    }

    @Test
    void logExitRedactsPayloadWhileAllThreePreviewsKeepOriginal() throws Exception {
        String agentPreview = captureAgentRelayPreview(sampleArguments());
        String approvalPreview = captureApprovalLedgerPreview(
                approvalPayload(Instant.now().plusSeconds(60).toString()));
        String mcpPreview = captureMcpGatewayPreview(mcpCallBody(ESCAPED_BUSINESS_NOTE));

        for (String preview : List.of(agentPreview, approvalPreview, mcpPreview)) {
            assertTrue(preview.contains("Bearer abc123-not-a-secret"),
                    "投影原文必须保留 Bearer 形状（禁正则改写）");
            String logLine = LogRedactor.redact(preview);
            assertNotEquals(preview, logLine, "日志出口必须脱敏（与投影原文共存）");
            assertTrue(logLine.contains(LogRedactor.REDACTED));
            assertFalse(logLine.contains("abc123-not-a-secret"),
                    "日志出口不得泄露 Bearer 形状后的值");
        }
        assertTrue(agentPreview.contains("\"token\":\"literal-user-data\""));
        assertFalse(LogRedactor.redact(agentPreview).contains("literal-user-data"));
        assertTrue(mcpPreview.contains("\"token\":\"literal-user-data\""));
        assertFalse(LogRedactor.redact(mcpPreview).contains("literal-user-data"));

        // 日志出口脱敏不回写投影：捕获到的 preview 原文不受影响。
        assertEquals(EXPECTED_AGENT_PREVIEW, agentPreview);
    }

    @Test
    void allThreePreviewsTruncateAtLedgerBoundKeepingPrefix() throws Exception {
        String longNote = "a".repeat(5000);

        String agentExpected = "{\"note\":\"" + longNote + "\",\"token\":\"literal-user-data\"}";
        String agentPreview = captureAgentRelayPreview(argumentsWithNote(longNote));
        assertEquals(PREVIEW_BOUND, agentPreview.length());
        assertEquals(agentExpected.substring(0, PREVIEW_BOUND), agentPreview,
                "Agent relay 截断必须是原文前缀截取，不得改写");

        // details 受 512 上限约束，未知键仍会进入序列化结果——4096 界正是为它兜底。
        String expiresAt = Instant.now().plusSeconds(60).toString();
        Map<String, Object> payload = approvalPayload(expiresAt);
        payload.put("context", longNote);
        String approvalExpected = expectedApprovalPreview(ESCAPED_BUSINESS_NOTE, expiresAt, longNote);
        String approvalPreview = captureApprovalLedgerPreview(payload);
        assertEquals(PREVIEW_BOUND, approvalPreview.length());
        assertEquals(approvalExpected.substring(0, PREVIEW_BOUND), approvalPreview,
                "Approval ledger 截断必须是原文前缀截取，不得改写");

        String body = mcpCallBody(longNote);
        String mcpPreview = captureMcpGatewayPreview(body);
        assertEquals(PREVIEW_BOUND, mcpPreview.length());
        assertEquals(body.substring(0, PREVIEW_BOUND), mcpPreview,
                "MCP gateway 截断必须是原文前缀截取，不得改写");
    }

    @Test
    void workspaceJobBaselinePreviewKeepsOriginalUntruncatedJson() throws Exception {
        String longArg = "a".repeat(5000);
        stubReplayedWorkspaceJobStart();
        WorkspaceJobStartService.StartRequest request = new WorkspaceJobStartService.StartRequest(
                "deploy", List.of(BUSINESS_NOTE, longArg), null, 0L,
                "workspace", null, null, "ui", null);

        WorkspaceJobStartService.StartOutcome outcome =
                workspaceJobStartService.start(WORKSPACE_ID, USER_ID, request, "key-1");

        assertTrue(outcome.replayed());
        ArgumentCaptor<String> preview = ArgumentCaptor.forClass(String.class);
        verify(operationService).startWorkspaceJob(eq(USER_ID), eq(WORKSPACE_ID), isNull(), isNull(),
                eq("ui"), eq("user"), eq("key-1"), anyString(), eq("job:deploy"), preview.capture());

        JsonNode node = mapper.readTree(preview.getValue());
        ObjectNode expected = mapper.createObjectNode();
        expected.put("command", "deploy");
        ArrayNode args = expected.putArray("args");
        args.add(BUSINESS_NOTE);
        args.add(longArg);
        assertEquals(expected, node,
                "WorkspaceJobStartService.argumentsPreview 基线 = 原文直存 JSON（V16 基线未改）");
        assertFalse(preview.getValue().contains(LogRedactor.REDACTED));
        assertTrue(preview.getValue().length() > PREVIEW_BOUND,
                "基线直存不受三路径 4096 界约束（原文直存为基线）");
    }

    private String captureAgentRelayPreview(Map<String, Object> arguments) {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runningRun()));
        when(operationService.findOperationIdByRunId(RUN_ID))
                .thenReturn(UUID.fromString(OPERATION_ID));
        when(operationService.appendItem(any(), anyString(), isNull(), eq("tool_call"),
                eq("write_file"), eq("agent"), anyString(), isNull(), isNull()))
                .thenReturn(newItem("agent"));
        when(operationService.startAttempt(any(), anyString(), any(), anyString(), any()))
                .thenReturn(new OperationAttempt());

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("tool", "write_file");
        payload.put("arguments", arguments);
        payload.put("type", "tool_call");
        payload.put("run_id", RUN_ID);
        payload.put("toolCallId", "tc-1");
        recorder.record("tool_call", payload, RUN_ID, null, LedgerToolRecorder.RunLedger.create());

        ArgumentCaptor<String> preview = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendItem(any(), anyString(), isNull(), eq("tool_call"),
                eq("write_file"), eq("agent"), preview.capture(), isNull(), isNull());
        return preview.getValue();
    }

    private String captureApprovalLedgerPreview(Map<String, Object> payload) {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runningRun()));
        when(approvals.findById(UUID.fromString(REQUEST_ID))).thenReturn(Optional.empty());
        when(operationService.findOperationIdByRunId(RUN_ID))
                .thenReturn(UUID.fromString(OPERATION_ID));

        approvalService.recordPending(payload, SESSION_ID, RUN_ID, USER_ID, WORKSPACE_ID);

        ArgumentCaptor<String> preview = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendApprovalItem(eq(UUID.fromString(OPERATION_ID)),
                eq(REQUEST_ID), eq("request_approval"), preview.capture());
        return preview.getValue();
    }

    private String captureMcpGatewayPreview(String body) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Operation-Id", MCP_OPERATION_ID);
        when(operationService.appendItem(eq(UUID.fromString(MCP_OPERATION_ID)), anyString(),
                isNull(), eq("tool_call"), eq("write_file"), eq("mcp"), anyString(), isNull(),
                isNull())).thenReturn(newItem("mcp"));
        when(operationService.startAttempt(any(), anyString(), any(), anyString(), any()))
                .thenReturn(new OperationAttempt());

        Class<?> accessType = Class.forName(
                "com.cc01cc.p.xihe.cp.mcp.McpProxyController$AccessContext");
        Method method = McpProxyController.class.getDeclaredMethod(
                "startLedgerAttempt", String.class, HttpHeaders.class, String.class, accessType);
        method.setAccessible(true);
        method.invoke(mcpController, body, headers, "sess-1", null);

        ArgumentCaptor<String> preview = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendItem(eq(UUID.fromString(MCP_OPERATION_ID)), anyString(),
                isNull(), eq("tool_call"), eq("write_file"), eq("mcp"), preview.capture(),
                isNull(), isNull());
        return preview.getValue();
    }

    private void stubReplayedWorkspaceJobStart() {
        Workspace workspace = new Workspace();
        workspace.setExecutionMode("docker");
        when(workspaceService.requireAccessibleWorkspace(WORKSPACE_ID, USER_ID))
                .thenReturn(workspace);
        when(operationService.startWorkspaceJob(any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any()))
                .thenReturn(new OperationService.WorkspaceJobStart(
                        UUID.fromString(OPERATION_ID), UUID.fromString(JOB_ITEM_ID), true));
        when(operationService.jobView(UUID.fromString(JOB_ITEM_ID)))
                .thenReturn(Map.of("status", "pending"));
    }

    private static ChatRun runningRun() {
        return new ChatRun(RUN_ID, SESSION_ID, USER_ID, WORKSPACE_ID,
                "idem-1", "hash", "openai", "model", "workspace", "running");
    }

    private static OperationItem newItem(String source) {
        OperationItem item = new OperationItem();
        item.setId(UUID.randomUUID());
        item.setOperationId(OPERATION_ID);
        item.setKind("tool_call");
        item.setSource(source);
        item.setStatus("pending");
        return item;
    }

    private static Map<String, Object> sampleArguments() {
        return argumentsWithNote(BUSINESS_NOTE);
    }

    private static Map<String, Object> argumentsWithNote(String note) {
        Map<String, Object> arguments = new LinkedHashMap<>();
        arguments.put("note", note);
        arguments.put("token", "literal-user-data");
        return arguments;
    }

    private static Map<String, Object> approvalPayload(String expiresAt) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("requestId", REQUEST_ID);
        payload.put("runId", RUN_ID);
        payload.put("sessionId", SESSION_ID);
        payload.put("workspaceId", WORKSPACE_ID);
        payload.put("tool", "request_approval");
        payload.put("action", "delete file");
        payload.put("details", BUSINESS_NOTE);
        payload.put("expiresAt", expiresAt);
        return payload;
    }

    private static String expectedApprovalPreview(String detailsJsonEscaped, String expiresAt,
                                                  String contextJsonEscaped) {
        return "{\"requestId\":\"" + REQUEST_ID + "\",\"runId\":\"" + RUN_ID
                + "\",\"sessionId\":\"" + SESSION_ID + "\",\"workspaceId\":\"" + WORKSPACE_ID
                + "\",\"tool\":\"request_approval\",\"action\":\"delete file\",\"details\":\""
                + detailsJsonEscaped + "\",\"expiresAt\":\"" + expiresAt + "\""
                + (contextJsonEscaped == null ? "" : ",\"context\":\"" + contextJsonEscaped + "\"")
                + "}";
    }

    private static String mcpCallBody(String noteAsJsonString) {
        return "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,"
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"note\":\""
                + noteAsJsonString + "\",\"token\":\"literal-user-data\"}}}";
    }
}
