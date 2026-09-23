package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0326 决策 #8/#9：Agent 侧工具事实记账的阶段映射与幂等矩阵。
 * 覆盖 verify V1/V2 的单测面：call→建项+attempt+running；result→终态（含被拒）；
 * 幂等矩阵（同源命中/跨源各建）；取消守卫；STATE_CONFLICT 吞并。
 */
class LedgerToolRecorderTest {

    private final OperationService operationService = mock(OperationService.class);
    private final ChatRunRepository chatRunRepository = mock(ChatRunRepository.class);
    private final LedgerToolRecorder recorder =
            new LedgerToolRecorder(operationService, chatRunRepository, new ObjectMapper());

    private static final String TEST_RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String TEST_OPERATION_ID = "22222222-2222-2222-2222-222222222222";

    private static final String RAW_TOOL_CALL_ID = "tc-1";
    /** 实现 canonicalToolCallId 的派生规则：非 UUID 原始键 → nameUUIDFromBytes。 */
    private static final String DERIVED_TOOL_CALL_ID =
            UUID.nameUUIDFromBytes(RAW_TOOL_CALL_ID.getBytes()).toString();

    private LedgerToolRecorder.RunLedger newLedger() {
        return LedgerToolRecorder.RunLedger.create();
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

    private OperationItem agentItem(String status) {
        OperationItem item = new OperationItem();
        item.setId(UUID.randomUUID());
        item.setOperationId(TEST_OPERATION_ID);
        item.setToolCallId(UUID.nameUUIDFromBytes("tc-1".getBytes()).toString());
        item.setKind("tool_call");
        item.setSource("agent");
        item.setStatus(status);
        return item;
    }

    private void stubRunLookup() {
        ChatRun run = new ChatRun();
        run.setStatus("running");
        when(chatRunRepository.findById(UUID.fromString(TEST_RUN_ID))).thenReturn(Optional.of(run));
        when(operationService.findOperationIdByRunId(TEST_RUN_ID)).thenReturn(UUID.fromString(TEST_OPERATION_ID));
    }

    @Test
    void toolCall_createsAgentItemAttemptAndRunning() {
        stubRunLookup();
        OperationItem created = agentItem("pending");
        when(operationService.appendItem(eq(UUID.fromString(TEST_OPERATION_ID)), anyString(),
                isNull(), eq("tool_call"), eq("write_file"), eq("agent"),
                anyString(), isNull(), isNull())).thenReturn(created);
        OperationAttempt attempt = new OperationAttempt();
        attempt.setId(UUID.randomUUID());
        when(operationService.startAttempt(eq(created.getId()), eq("agent_tool"), isNull(),
                eq("agent"), isNull())).thenReturn(attempt);

        LedgerToolRecorder.RunLedger ledger = newLedger();
        recorder.record("tool_call", toolCallPayload("write_file"), TEST_RUN_ID, null, ledger);

        verify(operationService).transitionItem(created.getId(), "running", null, null, null, null);
        assertTrue(ledger.itemsByToolCallId().containsKey(DERIVED_TOOL_CALL_ID));
        assertEquals(attempt.getId(), ledger.attemptsByItemId().get(created.getId()));
    }

    @Test
    void toolCall_argumentsPreviewPreservesOriginalPayloadText() {
        stubRunLookup();
        OperationItem created = agentItem("pending");
        when(operationService.appendItem(any(), anyString(), isNull(), eq("tool_call"),
                eq("write_file"), eq("agent"), anyString(), isNull(), isNull())).thenReturn(created);
        when(operationService.startAttempt(any(), anyString(), any(), anyString(), any()))
                .thenReturn(new OperationAttempt());
        Map<String, Object> payload = toolCallPayload("write_file");
        payload.put("arguments", Map.of("path", "secret.txt", "token", "literal-user-data"));

        recorder.record("tool_call", payload, TEST_RUN_ID, null, newLedger());

        ArgumentCaptor<String> preview = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendItem(any(), anyString(), isNull(), eq("tool_call"),
                eq("write_file"), eq("agent"), preview.capture(), isNull(), isNull());
        assertTrue(preview.getValue().contains("literal-user-data"));
        assertTrue(preview.getValue().contains("secret.txt"));
        assertFalse(preview.getValue().contains("***redacted***"));
    }

    @Test
    void toolResult_success_completesItemAndAttempt() {
        stubRunLookup();
        OperationItem item = agentItem("running");
        UUID attemptId = UUID.randomUUID();
        LedgerToolRecorder.RunLedger ledger = newLedger();
        ledger.itemsByToolCallId().put(DERIVED_TOOL_CALL_ID, item.getId());
        ledger.attemptsByItemId().put(item.getId(), attemptId);

        recorder.record("tool_result", toolResultPayload("write_file", "{\"ok\":true}"), TEST_RUN_ID, null, ledger);

        verify(operationService).finishAttempt(attemptId, "succeeded", 200, null, null, null);
        verify(operationService).transitionItem(item.getId(), "completed", "allow", null, null, null);
        assertTrue(ledger.itemsByToolCallId().isEmpty(), "结算后游标应清空");
        assertTrue(ledger.attemptsByItemId().isEmpty());
    }

    @Test
    void toolResult_rejected_marksFailedWithApprovalRejection() {
        stubRunLookup();
        OperationItem item = agentItem("running");
        UUID attemptId = UUID.randomUUID();
        LedgerToolRecorder.RunLedger ledger = newLedger();
        ledger.itemsByToolCallId().put(DERIVED_TOOL_CALL_ID, item.getId());
        ledger.attemptsByItemId().put(item.getId(), attemptId);

        recorder.record("tool_result", toolResultPayload("write_file", "Tool error: 审批被拒"), TEST_RUN_ID, null, ledger);

        verify(operationService).finishAttempt(attemptId, "failed", 500, "TOOL_FAILED", null, null);
        verify(operationService).transitionItem(item.getId(), "failed", null, null, null, "TOOL_FAILED");
    }

    @Test
    void toolResult_unmatched_noHeuristicFallback_reconcileOwnsRecovery() {
        stubRunLookup();
        // v3：游标丢失（断流/重启）不做启发式回退，交给 run 恢复对账（决策 #8）。
        LedgerToolRecorder.RunLedger ledger = newLedger();
        recorder.record("tool_result", toolResultPayload("write_file", "{\"ok\":true}"), TEST_RUN_ID, null, ledger);

        verify(operationService, never()).appendItem(any(), any(), any(), anyString(),
                anyString(), anyString(), any(), any(), any());
        verify(operationService, never()).transitionItem(any(), anyString(), any(), any(), any(), any());
        verify(operationService, never()).finishAttempt(any(), anyString(), any(), anyString(), any(), any());
    }

    @Test
    void idempotentMatrix_sameSourceReplay_hitsExistingRow() {
        stubRunLookup();
        OperationItem existing = agentItem("running");
        // 同源重放：appendItem 内部幂等命中同一行（service 层行为，这里模拟返回既有行）。
        when(operationService.appendItem(eq(UUID.fromString(TEST_OPERATION_ID)), anyString(),
                isNull(), eq("tool_call"), eq("write_file"), eq("agent"),
                anyString(), isNull(), isNull())).thenReturn(existing);
        when(operationService.startAttempt(any(), anyString(), any(), anyString(), any()))
                .thenReturn(new OperationAttempt());

        LedgerToolRecorder.RunLedger ledger = newLedger();
        recorder.record("tool_call", toolCallPayload("write_file"), TEST_RUN_ID, null, ledger);

        ArgumentCaptor<String> sourceCaptor = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendItem(any(), any(), isNull(), eq("tool_call"),
                eq("write_file"), sourceCaptor.capture(), any(), isNull(), isNull());
        assertEquals("agent", sourceCaptor.getValue(), "记账组件只写 source=agent 行");
        // 幂等命中返回 running 旧行 → 不再重复转 running。
        verify(operationService, never()).transitionItem(existing.getId(), "running", null, null, null, null);
    }

    @Test
    void crossSource_rowsAreIndependent_gatewayRowNeverTouchedByRelay() {
        stubRunLookup();
        // 决策 #9：中继不查不写 source=mcp 行——记录调用时 appendItem 固定传 source=agent。
        OperationItem created = agentItem("pending");
        when(operationService.appendItem(any(), any(), any(), anyString(), anyString(),
                eq("agent"), any(), any(), any())).thenReturn(created);
        when(operationService.startAttempt(any(), anyString(), any(), anyString(), any()))
                .thenReturn(new OperationAttempt());

        recorder.record("tool_call", toolCallPayload("write_file"), TEST_RUN_ID, null, newLedger());

        verify(operationService, never()).findItemByApprovalRequestId(any());
        verify(operationService, never()).transitionItem(any(), eq("failed"), any(), any(), any(),
                eq("TOOL_FAILED"));
    }

    @Test
    void cancelledRun_skipsRecording() {
        stubRunLookup();
        ChatRun cancelled = new ChatRun();
        cancelled.setStatus("cancelled");
        when(chatRunRepository.findById(UUID.fromString(TEST_RUN_ID))).thenReturn(Optional.of(cancelled));

        LedgerToolRecorder.RunLedger ledger = newLedger();
        recorder.record("tool_call", toolCallPayload("write_file"), TEST_RUN_ID, null, ledger);

        verify(operationService, never()).appendItem(any(), any(), any(), anyString(),
                anyString(), anyString(), any(), any(), any());
    }

    @Test
    void stateConflict_isSwallowed_notRethrown() {
        stubRunLookup();
        when(operationService.appendItem(any(), any(), any(), anyString(), anyString(),
                anyString(), any(), any(), any()))
                .thenThrow(new CpApiException(HttpStatus.CONFLICT, "OPERATION_STATE_CONFLICT", "conflict"));

        LedgerToolRecorder.RunLedger ledger = newLedger();
        assertDoesNotThrow(() -> recorder.record("tool_call", toolCallPayload("write_file"),
                TEST_RUN_ID, null, ledger));
    }

    @Test
    void unrelatedEvents_areIgnored() {
        stubRunLookup();
        LedgerToolRecorder.RunLedger ledger = newLedger();
        recorder.record("llm_usage", Map.of("inputTokens", 1), TEST_RUN_ID, null, ledger);
        recorder.record("token", Map.of("content", "hi"), TEST_RUN_ID, null, ledger);

        verify(operationService, never()).findOperationIdByRunId(anyString());
        verify(operationService, never()).appendItem(any(), any(), any(), anyString(),
                anyString(), anyString(), any(), any(), any());
    }
}
