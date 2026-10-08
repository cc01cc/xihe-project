package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0464 T2.2: the SSE-relay half of the MCP execution domain.
 *
 * <p>Replaces {@code LedgerToolRecorderTest}: the relay writes the invocation and
 * the {@code agent_tool} attempt only — no {@code operation_*} rows exist any
 * more, so the assertions are the execution-domain ones (open / start / finish,
 * source isolation, cancel guard, best-effort failures).</p>
 */
class McpRelayToolRecorderTest {

    private final ChatRunRepository chatRunRepository = mock(ChatRunRepository.class);
    private final McpInvocationService mcpInvocationService = mock(McpInvocationService.class);
    private final McpRelayToolRecorder recorder =
            new McpRelayToolRecorder(chatRunRepository, mcpInvocationService, new ObjectMapper());

    private static final String TEST_RUN_ID = "11111111-1111-1111-1111-111111111111";

    private static final String RAW_TOOL_CALL_ID = "tc-1";
    /** Mirrors the canonical rule: a non-UUID raw key becomes nameUUIDFromBytes. */
    private static final String DERIVED_TOOL_CALL_ID =
            UUID.nameUUIDFromBytes(RAW_TOOL_CALL_ID.getBytes()).toString();

    private static McpRelayToolRecorder.RunState newState() {
        return McpRelayToolRecorder.RunState.create();
    }

    private Map<String, Object> toolCallPayload(String tool) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("tool", tool);
        payload.put("arguments", Map.of("path", "README.md"));
        payload.put("type", "tool_call");
        payload.put("run_id", TEST_RUN_ID);
        payload.put("toolCallId", "tc-1");
        return payload;
    }

    private Map<String, Object> toolResultPayload(String tool, String result) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("tool", tool);
        payload.put("result", result);
        payload.put("type", "tool_result");
        payload.put("run_id", TEST_RUN_ID);
        payload.put("toolCallId", "tc-1");
        return payload;
    }

    private void stubRunLookup(String status) {
        ChatRun run = new ChatRun();
        run.setStatus(status);
        when(chatRunRepository.findById(UUID.fromString(TEST_RUN_ID))).thenReturn(Optional.of(run));
    }

    @Test
    void toolCall_opensInvocationAndStartsAgentAttempt() {
        stubRunLookup("running");
        UUID invocationId = UUID.randomUUID();
        UUID attemptId = UUID.randomUUID();
        when(mcpInvocationService.openAgentInvocation(eq(TEST_RUN_ID), eq(DERIVED_TOOL_CALL_ID),
                eq("write_file"), any(), anyString())).thenReturn(Optional.of(invocationId));
        when(mcpInvocationService.startAgentToolAttempt(eq(invocationId), any()))
                .thenReturn(Optional.of(attemptId));

        McpRelayToolRecorder.RunState state = newState();
        recorder.record("tool_call", toolCallPayload("write_file"), TEST_RUN_ID, null, state);

        verify(mcpInvocationService).openAgentInvocation(eq(TEST_RUN_ID), eq(DERIVED_TOOL_CALL_ID),
                eq("write_file"), any(), anyString());
        verify(mcpInvocationService).startAgentToolAttempt(eq(invocationId), any());
        assertEquals(invocationId, state.invocationsByToolCallId().get(DERIVED_TOOL_CALL_ID));
        assertEquals(attemptId, state.attemptsByToolCallId().get(DERIVED_TOOL_CALL_ID));
        verify(mcpInvocationService, never()).openDirectUserInvocation(any(), any(), any(), any(),
                any(), any(), any());
    }

    @Test
    void toolCall_argumentsPreviewPreservesOriginalPayloadText() {
        stubRunLookup("running");
        Map<String, Object> payload = toolCallPayload("write_file");
        payload.put("arguments", Map.of("path", "secret.txt", "token", "literal-user-data"));

        recorder.record("tool_call", payload, TEST_RUN_ID, null, newState());

        ArgumentCaptor<String> preview = ArgumentCaptor.forClass(String.class);
        verify(mcpInvocationService).openAgentInvocation(eq(TEST_RUN_ID), any(), eq("write_file"),
                any(), preview.capture());
        assertTrue(preview.getValue().contains("literal-user-data"));
        assertTrue(preview.getValue().contains("secret.txt"));
        assertFalse(preview.getValue().contains("***redacted***"));
    }

    @Test
    void toolResult_success_finishesAgentAttempt() {
        stubRunLookup("running");
        UUID invocationId = UUID.randomUUID();
        UUID attemptId = UUID.randomUUID();
        McpRelayToolRecorder.RunState state = newState();
        state.invocationsByToolCallId().put(DERIVED_TOOL_CALL_ID, invocationId);
        state.attemptsByToolCallId().put(DERIVED_TOOL_CALL_ID, attemptId);

        recorder.record("tool_result", toolResultPayload("write_file", "{\"ok\":true}"),
                TEST_RUN_ID, null, state);

        verify(mcpInvocationService).finishAgentToolAttempt(invocationId, attemptId, false);
        assertTrue(state.invocationsByToolCallId().isEmpty(), "settlement clears the cursor");
        assertTrue(state.attemptsByToolCallId().isEmpty());
    }

    @Test
    void toolResult_rejected_finishesAgentAttemptAsFailed() {
        stubRunLookup("running");
        UUID invocationId = UUID.randomUUID();
        UUID attemptId = UUID.randomUUID();
        McpRelayToolRecorder.RunState state = newState();
        state.invocationsByToolCallId().put(DERIVED_TOOL_CALL_ID, invocationId);
        state.attemptsByToolCallId().put(DERIVED_TOOL_CALL_ID, attemptId);

        recorder.record("tool_result", toolResultPayload("write_file", "Tool error: 审批被拒"),
                TEST_RUN_ID, null, state);

        verify(mcpInvocationService).finishAgentToolAttempt(invocationId, attemptId, true);
    }

    @Test
    void toolResult_unmatched_noHeuristicFallback_reconcileOwnsRecovery() {
        stubRunLookup("running");
        McpRelayToolRecorder.RunState state = newState();
        recorder.record("tool_result", toolResultPayload("write_file", "{\"ok\":true}"),
                TEST_RUN_ID, null, state);

        verify(mcpInvocationService, never()).finishAgentToolAttempt(any(), any(), eq(false));
        verify(mcpInvocationService, never()).finishAgentToolAttempt(any(), any(), eq(true));
        verify(mcpInvocationService, never()).openAgentInvocation(any(), any(), any(), any(), any());
    }

    @Test
    void cancelledRun_skipsRecording() {
        stubRunLookup("cancelled");
        McpRelayToolRecorder.RunState state = newState();
        recorder.record("tool_call", toolCallPayload("write_file"), TEST_RUN_ID, null, state);

        verify(mcpInvocationService, never()).openAgentInvocation(any(), any(), any(), any(), any());
        assertTrue(state.invocationsByToolCallId().isEmpty());
    }

    @Test
    void writeFailure_isSwallowed_notRethrown() {
        stubRunLookup("running");
        when(mcpInvocationService.openAgentInvocation(any(), any(), any(), any(), any()))
                .thenThrow(new CpApiException(HttpStatus.CONFLICT, "MCP_INVOCATION_CONFLICT", "conflict"));

        McpRelayToolRecorder.RunState state = newState();
        assertDoesNotThrow(() -> recorder.record("tool_call", toolCallPayload("write_file"),
                TEST_RUN_ID, null, state));
    }

    @Test
    void unrelatedEvents_areIgnored() {
        stubRunLookup("running");
        McpRelayToolRecorder.RunState state = newState();
        recorder.record("llm_usage", Map.of("inputTokens", 1), TEST_RUN_ID, null, state);
        recorder.record("token", Map.of("content", "hi"), TEST_RUN_ID, null, state);

        verify(mcpInvocationService, never()).openAgentInvocation(any(), any(), any(), any(), any());
        verify(mcpInvocationService, never()).finishAgentToolAttempt(any(), any(), eq(false));
    }
}
