package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.RunCheckpointRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0338: Run slice-checkpoint lifecycle — single terminal capture, no-change
 * rows, frozen degradation policy, ledger markers, startup compensation.
 */
class RunCheckpointServiceTest {

    private static final String RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
    private static final String USER_ID = "55555555-5555-5555-5555-555555555555";
    private static final String SESSION_ID = "44444444-4444-4444-4444-444444444444";
    private static final String SLICE_REF = "refs/xihe/slices/1757980000000-ab12cd";
    private static final String RAW_REQUEST_MARKER = "secret-revert-request-marker";

    private RunCheckpointRepository repository;
    private RuntimeCheckpointClient client;
    private OperationService operationService;
    private ChatRunRepository chatRunRepository;
    private SseEmitterManager sseManager;
    private RunCheckpointService service;
    private final List<RunCheckpoint> rows = new CopyOnWriteArrayList<>();

    @BeforeEach
    void setUp() {
        repository = mock(RunCheckpointRepository.class);
        client = mock(RuntimeCheckpointClient.class);
        operationService = mock(OperationService.class);
        chatRunRepository = mock(ChatRunRepository.class);
        sseManager = mock(SseEmitterManager.class);
        rows.clear();

        when(repository.findByRunIdAndWorkspaceId(anyString(), anyString()))
                .thenAnswer(invocation -> rows.stream()
                        .filter(row -> row.getRunId().equals(invocation.getArgument(0))
                                && row.getWorkspaceId().equals(invocation.getArgument(1)))
                        .findFirst());
        when(repository.save(any(RunCheckpoint.class))).thenAnswer(invocation -> {
            RunCheckpoint row = invocation.getArgument(0);
            rows.removeIf(existing -> existing.getId().equals(row.getId()));
            rows.add(row);
            return row;
        });
        when(repository.markReverted(any(), any(), any(), any(), any()))
                .thenAnswer(invocation -> {
                    UUID id = invocation.getArgument(0);
                    for (RunCheckpoint row : rows) {
                        if (row.getId().equals(id) && isCaptured(row.getState())) {
                            return 1;
                        }
                    }
                    return 0;
                });
        when(repository.markExpired(any(), any()))
                .thenAnswer(invocation -> {
                    UUID id = invocation.getArgument(0);
                    for (RunCheckpoint row : rows) {
                        if (row.getId().equals(id) && isCaptured(row.getState())) {
                            row.setState(RunCheckpoint.STATE_EXPIRED);
                            return 1;
                        }
                    }
                    return 0;
                });
        when(repository.countByWorkspaceId(anyString())).thenReturn(0L);
        when(repository.countBaseRefs(anyString())).thenReturn(0L);
        when(repository.countEndRefs(anyString())).thenReturn(0L);
        when(operationService.findOperationIdByRunId(anyString())).thenReturn(null);

        service = new RunCheckpointService(repository, client, operationService, chatRunRepository,
                new ObjectMapper(), sseManager);
    }

    @AfterEach
    void tearDown() {
        service.shutdown();
    }

    private static boolean isCaptured(String state) {
        return RunCheckpoint.STATE_CAPTURED.equals(state)
                || RunCheckpoint.STATE_ABNORMAL_CAPTURED.equals(state);
    }

    private RunCheckpoint seedCapturedRow() {
        RunCheckpoint row = new RunCheckpoint();
        row.setId(UUID.randomUUID());
        row.setRunId(RUN_ID);
        row.setWorkspaceId(WORKSPACE_ID);
        row.setState(RunCheckpoint.STATE_CAPTURED);
        row.setEndRef(SLICE_REF);
        row.setChangedFiles("[{\"status\":\"M\",\"path\":\"src/a.txt\"}]");
        row.setSealedAt(Instant.now());
        row.setCreatedAt(Instant.now());
        row.setUpdatedAt(Instant.now());
        rows.add(row);
        return row;
    }

    private ChatRun runWithStatus(String status) {
        return new ChatRun(RUN_ID, SESSION_ID, USER_ID, WORKSPACE_ID,
                "idem-" + status, "hash", "openai", "gpt-test", "none", status);
    }

    private RuntimeCheckpointClient.CaptureResult captureOk(String sliceRef) {
        return new RuntimeCheckpointClient.CaptureResult(RuntimeCheckpointClient.Outcome.OK, RUN_ID, false,
                sliceRef, "ab12cd", "2026-09-15T00:00:00Z", RunCheckpoint.STATE_CAPTURED,
                List.of(new RuntimeCheckpointClient.ChangedFile("M", "src/a.txt")), List.of(), null, null);
    }

    private static String captureCallId(String runId) {
        return "run-terminal-capture:" + runId;
    }

    // ── PLAN-0338: terminal capture ─────────────────────────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void terminalCaptureWritesCapturedRowAndLedgerMarker() {
        UUID operationId = UUID.randomUUID();
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        when(operationService.findOperationIdByRunId(RUN_ID)).thenReturn(operationId);
        OperationItem item = new OperationItem();
        item.setId(UUID.randomUUID());
        item.setStatus("pending");
        when(operationService.appendItem(eq(operationId), any(), any(), eq("checkpoint"),
                eq("run_checkpoint"), eq("runtime"), any(), any(), any())).thenReturn(item);
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false))
                .thenReturn(captureOk(SLICE_REF));

        assertTrue(service.captureCheckpoint(RUN_ID));

        assertEquals(1, rows.size());
        RunCheckpoint row = rows.get(0);
        assertEquals(RunCheckpoint.STATE_CAPTURED, row.getState());
        assertEquals(SLICE_REF, row.getEndRef());
        assertNull(row.getBaseRef());
        assertTrue(row.getChangedFiles().contains("src/a.txt"));
        assertFalse(row.isSealedAfterAbnormal());
        assertNotNull(row.getSealedAt());
        verify(client).capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false);

        ArgumentCaptor<String> previews = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> toolCallIds = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendItem(eq(operationId), toolCallIds.capture(), any(),
                eq("checkpoint"), eq("run_checkpoint"), eq("runtime"), previews.capture(), isNull(), isNull());
        verify(operationService).transitionItem(eq(item.getId()), eq("completed"),
                isNull(), isNull(), any(), isNull());
        assertNotNull(UUID.fromString(toolCallIds.getValue()), "the marker identity is a UUID");
        assertTrue(previews.getValue().contains(SLICE_REF));
        assertTrue(previews.getValue().contains("\"marker\":\"captured\""));
    }

    @Test
    void abnormalTerminalCapturesAbnormalState() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("ambiguous")));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), true))
                .thenReturn(new RuntimeCheckpointClient.CaptureResult(RuntimeCheckpointClient.Outcome.OK,
                        RUN_ID, false, SLICE_REF, "ab12cd", "2026-09-15T00:00:00Z",
                        RunCheckpoint.STATE_ABNORMAL_CAPTURED,
                        List.of(), List.of(), null, null));

        assertTrue(service.captureCheckpoint(RUN_ID));

        assertEquals(RunCheckpoint.STATE_ABNORMAL_CAPTURED, rows.get(0).getState());
        assertTrue(rows.get(0).isSealedAfterAbnormal());
    }

    @Test
    void succeededAndCancelledAreNormalTerminals() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("cancelled")));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false))
                .thenReturn(captureOk(SLICE_REF));

        assertTrue(service.captureCheckpoint(RUN_ID));

        assertFalse(rows.get(0).isSealedAfterAbnormal());
        verify(client).capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false);
    }

    @Test
    void noChangeCaptureWritesRowWithoutSliceRef() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false))
                .thenReturn(new RuntimeCheckpointClient.CaptureResult(RuntimeCheckpointClient.Outcome.OK,
                        RUN_ID, true, null, null, null, RunCheckpoint.STATE_CAPTURED,
                        List.of(), List.of(), null, null));

        assertTrue(service.captureCheckpoint(RUN_ID));

        RunCheckpoint row = rows.get(0);
        assertEquals(RunCheckpoint.STATE_CAPTURED, row.getState());
        assertNull(row.getEndRef());
        assertEquals("[]", row.getChangedFiles());
        assertNotNull(row.getSealedAt());
    }

    @Test
    void unavailableCaptureDegradesWithFrozenReason() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false))
                .thenReturn(new RuntimeCheckpointClient.CaptureResult(
                        RuntimeCheckpointClient.Outcome.UNAVAILABLE, RUN_ID, false, null, null, null,
                        null, List.of(), List.of(), null, "git_unavailable"));

        assertFalse(service.captureCheckpoint(RUN_ID));

        assertEquals(1, rows.size());
        assertEquals(RunCheckpoint.STATE_DEGRADED, rows.get(0).getState());
        assertEquals(RunCheckpointService.REASON_UNAVAILABLE, rows.get(0).getUnrollableReason());
    }

    @Test
    void transportFailureDegradesInsteadOfThrowing() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false))
                .thenReturn(new RuntimeCheckpointClient.CaptureResult(
                        RuntimeCheckpointClient.Outcome.TRANSPORT, RUN_ID, false, null, null, null,
                        null, List.of(), List.of(), null, "unreachable"));

        assertFalse(service.captureCheckpoint(RUN_ID));

        assertEquals(RunCheckpoint.STATE_DEGRADED, rows.get(0).getState());
        assertEquals(RunCheckpointService.REASON_UNAVAILABLE, rows.get(0).getUnrollableReason());
    }

    @Test
    void invalidCaptureRequestDegradesWithInvalidReason() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false))
                .thenReturn(new RuntimeCheckpointClient.CaptureResult(
                        RuntimeCheckpointClient.Outcome.INVALID_REQUEST, RUN_ID, false, null, null, null,
                        null, List.of(), List.of(), null, "CHECKPOINT_INVALID_REQUEST"));

        assertFalse(service.captureCheckpoint(RUN_ID));

        assertEquals(RunCheckpoint.STATE_DEGRADED, rows.get(0).getState());
        assertEquals(RunCheckpointService.REASON_INVALID_REQUEST, rows.get(0).getUnrollableReason());
    }

    @Test
    void captureIsIdempotentPerRun() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false))
                .thenReturn(captureOk(SLICE_REF));

        assertTrue(service.captureCheckpoint(RUN_ID));
        assertFalse(service.captureCheckpoint(RUN_ID), "a captured row must not capture twice");

        verify(client, times(1)).capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false);
        assertEquals(1, rows.size());
    }

    @Test
    void captureWithoutRunIsANoOp() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID))).thenReturn(Optional.empty());

        assertFalse(service.captureCheckpoint(RUN_ID));

        verify(client, never()).capture(anyString(), anyString(), any(), any(), anyBoolean());
        assertTrue(rows.isEmpty());
    }

    @Test
    void unexpectedCaptureFailureIsSwallowed() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        when(repository.findByRunIdAndWorkspaceId(anyString(), anyString()))
                .thenThrow(new IllegalStateException("checkpoint store down"));

        assertFalse(service.captureCheckpoint(RUN_ID));

        verify(client, never()).capture(anyString(), anyString(), any(), any(), anyBoolean());
    }

    @Test
    void requestCaptureRunsAsynchronouslyAndNeverThrows() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false))
                .thenReturn(captureOk(SLICE_REF));

        service.requestCapture(RUN_ID);

        verify(client, timeout(3000)).capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false);
    }

    @Test
    void requestCaptureForMissingRunNeverThrows() {
        service.requestCapture(RUN_ID);
        verify(client, never()).capture(anyString(), anyString(), any(), any(), anyBoolean());
    }

    @Test
    void startupSweepCapturesTerminalRunWithoutRowOnce() {
        ChatRun terminal = runWithStatus("ambiguous");
        when(chatRunRepository.findTerminalRunsWithoutCheckpoint(any(), any()))
                .thenReturn(List.of(terminal));
        when(chatRunRepository.findById(UUID.fromString(RUN_ID))).thenReturn(Optional.of(terminal));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), true))
                .thenReturn(captureOk(SLICE_REF));

        assertEquals(1, service.captureTerminalRuns());
        assertEquals(0, service.captureTerminalRuns(), "the sweep is idempotent");

        verify(client, times(1)).capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), true);
        assertEquals(RunCheckpoint.STATE_CAPTURED, rows.get(0).getState());
    }

    @Test
    void startupSweepSkipsRunsThatAlreadyHaveARow() {
        seedCapturedRow();
        ChatRun terminal = runWithStatus("succeeded");
        when(chatRunRepository.findTerminalRunsWithoutCheckpoint(any(), any()))
                .thenReturn(List.of(terminal));
        when(chatRunRepository.findById(UUID.fromString(RUN_ID))).thenReturn(Optional.of(terminal));

        assertEquals(0, service.captureTerminalRuns());

        verify(client, never()).capture(anyString(), anyString(), any(), any(), anyBoolean());
    }

    @Test
    void startupSweepFailureNeverThrows() {
        when(chatRunRepository.findTerminalRunsWithoutCheckpoint(any(), any()))
                .thenThrow(new IllegalStateException("checkpoint store down"));

        assertEquals(0, service.captureTerminalRuns());
    }

    @Test
    void ledgerMarkerIsSkippedWhenOperationIsMissing() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false))
                .thenReturn(captureOk(SLICE_REF));

        assertTrue(service.captureCheckpoint(RUN_ID));

        verify(operationService, never()).appendItem(any(), any(), any(), anyString(), anyString(),
                anyString(), any(), any(), any());
        assertEquals(1, rows.size());
    }

    // ── PLAN-0328 M3 W2: view / revert / file / git / retention ─────────────

    private RuntimeCheckpointClient.RevertPreview previewOk() {
        return new RuntimeCheckpointClient.RevertPreview(RuntimeCheckpointClient.Outcome.OK, SLICE_REF,
                new RuntimeCheckpointClient.PreviewCounts(1, 0, 0),
                List.of(new RuntimeCheckpointClient.PreviewEntry("src/a.txt", "restore", "planned", null)),
                false, Map.of(), null);
    }

    private RuntimeCheckpointClient.RevertResult revertOk(int restored, int failed, int suspectCount) {
        List<RuntimeCheckpointClient.ExecuteEntry> entries = new ArrayList<>();
        for (int i = 0; i < restored; i++) {
            entries.add(new RuntimeCheckpointClient.ExecuteEntry("r" + i + ".txt", "restored", null));
        }
        for (int i = 0; i < failed; i++) {
            entries.add(new RuntimeCheckpointClient.ExecuteEntry("f" + i + ".txt", "failed", "IO_ERROR"));
        }
        List<String> suspects = new ArrayList<>();
        for (int i = 0; i < suspectCount; i++) {
            suspects.add("suspect-" + i + ".txt");
        }
        return new RuntimeCheckpointClient.RevertResult(RuntimeCheckpointClient.Outcome.OK, SLICE_REF,
                new RuntimeCheckpointClient.ExecuteCounts(restored, 0, failed),
                entries, 12L, suspects, Map.of(), null);
    }

    @Test
    void viewWithoutRowProjectsStateNone() {
        RunCheckpointService.View view = service.view(RUN_ID, WORKSPACE_ID);

        assertEquals(RunCheckpointService.STATE_NONE, view.state());
        assertEquals(0, view.changedCount());
        assertTrue(view.changedFiles().isEmpty());
        assertEquals(RunCheckpoint.REVERT_NONE, view.revert().state());
    }

    @Test
    void viewCapsChangedFilesAtTwentyAndCountsAll() {
        RunCheckpoint row = seedCapturedRow();
        StringBuilder json = new StringBuilder("[");
        for (int i = 0; i < 25; i++) {
            if (i > 0) {
                json.append(",");
            }
            json.append("{\"status\":\"M\",\"path\":\"f").append(i).append(".txt\"}");
        }
        json.append("]");
        row.setChangedFiles(json.toString());

        RunCheckpointService.View view = service.view(RUN_ID, WORKSPACE_ID);

        assertEquals(RunCheckpoint.STATE_CAPTURED, view.state());
        assertEquals(25, view.changedCount());
        assertEquals(20, view.changedFiles().size());
        assertEquals("f0.txt", view.changedFiles().get(0).path());
    }

    @Test
    void viewProjectsRevertSummaryCounts() {
        RunCheckpoint row = seedCapturedRow();
        row.setRevertState(RunCheckpoint.REVERT_PARTIAL);
        row.setRevertedAt(Instant.parse("2026-09-15T10:00:00Z"));
        row.setRevertRef(SLICE_REF);
        row.setRevertSummary("{\"marker\":\"revert\",\"counts\":{\"restored\":2,\"deleted\":1,"
                + "\"failed\":0},\"sliceRef\":\"refs/xihe/slices/x\"}");

        RunCheckpointService.View view = service.view(RUN_ID, WORKSPACE_ID);

        assertEquals(RunCheckpoint.REVERT_PARTIAL, view.revert().state());
        assertEquals(Instant.parse("2026-09-15T10:00:00Z"), view.revert().at());
        assertEquals(SLICE_REF, view.revert().ref());
        assertEquals(2, ((Number) view.revert().counts().get("restored")).intValue());
    }

    @Test
    void previewRevertBlocksMissingDegradedAndUncapturedRows() {
        RunCheckpointService.PreviewOutcome missing = service.previewRevert(RUN_ID, WORKSPACE_ID);
        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, missing.gate());
        assertEquals(RunCheckpointService.REASON_MISSING, missing.reason());

        RunCheckpoint degraded = seedCapturedRow();
        degraded.setState(RunCheckpoint.STATE_DEGRADED);
        degraded.setUnrollableReason(RunCheckpointService.REASON_UNAVAILABLE);
        RunCheckpointService.PreviewOutcome degradedOutcome =
                service.previewRevert(RUN_ID, WORKSPACE_ID);
        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, degradedOutcome.gate());
        assertEquals(RunCheckpointService.REASON_UNAVAILABLE, degradedOutcome.reason());

        degraded.setState(RunCheckpoint.STATE_CAPTURED);
        degraded.setUnrollableReason(null);
        degraded.setEndRef(null);
        RunCheckpointService.PreviewOutcome noRef = service.previewRevert(RUN_ID, WORKSPACE_ID);
        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, noRef.gate());
        assertEquals(RunCheckpointService.REASON_MISSING, noRef.reason());

        verify(client, never()).previewRevert(anyString(), anyString());
    }

    @Test
    void previewRevertPassesSliceRefToRuntimePreview() {
        seedCapturedRow();
        when(client.previewRevert(WORKSPACE_ID, SLICE_REF)).thenReturn(previewOk());

        RunCheckpointService.PreviewOutcome outcome = service.previewRevert(RUN_ID, WORKSPACE_ID);

        assertEquals(RunCheckpointService.Gate.OK, outcome.gate());
        assertEquals(1, outcome.preview().counts().restore());
        assertEquals("planned", outcome.preview().entries().get(0).state());
        verify(client).previewRevert(WORKSPACE_ID, SLICE_REF);
    }

    @Test
    void previewRevertFlipsCapturedRowToExpiredOnceWhenRuntimeSliceIsGone() {
        seedCapturedRow();
        when(client.previewRevert(WORKSPACE_ID, SLICE_REF)).thenReturn(
                new RuntimeCheckpointClient.RevertPreview(RuntimeCheckpointClient.Outcome.NOT_FOUND,
                        null, null, List.of(), false, Map.of(), "http_404"));

        RunCheckpointService.PreviewOutcome first = service.previewRevert(RUN_ID, WORKSPACE_ID);
        RunCheckpointService.PreviewOutcome second = service.previewRevert(RUN_ID, WORKSPACE_ID);

        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, first.gate());
        assertEquals(RunCheckpointService.REASON_EXPIRED, first.reason());
        assertEquals(RunCheckpoint.STATE_EXPIRED, rows.get(0).getState());
        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, second.gate());
        assertEquals(RunCheckpointService.REASON_EXPIRED, second.reason());
        verify(repository, times(1)).markExpired(any(), any());
        verify(client, times(1)).previewRevert(WORKSPACE_ID, SLICE_REF);
    }

    @Test
    void revertHappyPathRecordsRolledBackLedgerAndAttemptCount() {
        seedCapturedRow();
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        UUID operationId = UUID.randomUUID();
        when(operationService.findOperationIdByRunId(RUN_ID)).thenReturn(operationId);
        OperationItem item = new OperationItem();
        item.setId(UUID.randomUUID());
        item.setStatus("pending");
        when(operationService.appendItem(eq(operationId), any(), any(), eq("checkpoint"),
                eq("revert_checkpoint"), eq("ui"), any(), any(), any())).thenReturn(item);
        when(client.revert(WORKSPACE_ID, SLICE_REF, List.of(RAW_REQUEST_MARKER)))
                .thenReturn(revertOk(2, 0, 0));

        RunCheckpointService.RevertOutcome outcome = service.revert(
                RUN_ID, WORKSPACE_ID, List.of(RAW_REQUEST_MARKER));

        assertEquals(RunCheckpointService.Gate.OK, outcome.gate());
        RunCheckpoint row = rows.get(0);
        assertEquals(RunCheckpoint.REVERT_ROLLED_BACK, row.getRevertState());
        assertEquals(SLICE_REF, row.getRevertRef());
        assertEquals(1, row.getRevertAttemptCount());
        assertNotNull(row.getRevertedAt());
        verify(repository).markReverted(eq(row.getId()), eq(RunCheckpoint.REVERT_ROLLED_BACK),
                eq(SLICE_REF), any(), any());

        ArgumentCaptor<String> summary = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendItem(eq(operationId), any(), any(), eq("checkpoint"),
                eq("revert_checkpoint"), eq("ui"), summary.capture(), isNull(), isNull());
        assertTrue(summary.getValue().contains("\"marker\":\"revert\""));
        assertTrue(summary.getValue().contains("\"checkpointId\":\"" + row.getId() + "\""));
        assertTrue(summary.getValue().contains("\"sliceRef\":\"" + SLICE_REF + "\""));
        assertTrue(summary.getValue().contains("\"allowedBy\":\"user_ui\""));
        assertTrue(summary.getValue().contains("\"restored\":2"));
        assertTrue(summary.getValue().contains("\"reason\":null"));
        assertFalse(summary.getValue().contains(RAW_REQUEST_MARKER));
        assertFalse(summary.getValue().contains("arguments"));
        assertFalse(summary.getValue().contains("details"));
        verify(operationService).transitionItem(eq(item.getId()), eq("completed"), isNull(), isNull(),
                any(), isNull());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> payload = ArgumentCaptor.forClass(Map.class);
        verify(sseManager).send(eq(SESSION_ID), eq("run_checkpoint"), payload.capture());
        assertEquals(RunCheckpoint.STATE_CAPTURED, payload.getValue().get("state"));
        assertEquals(RUN_ID, payload.getValue().get("runId"));
        @SuppressWarnings("unchecked")
        Map<String, Object> revert = (Map<String, Object>) payload.getValue().get("revert");
        assertEquals(RunCheckpoint.REVERT_ROLLED_BACK, revert.get("state"));
    }

    @Test
    void revertPartialRecordsPartialStateAndCappedSuspects() {
        seedCapturedRow();
        UUID operationId = UUID.randomUUID();
        when(operationService.findOperationIdByRunId(RUN_ID)).thenReturn(operationId);
        OperationItem item = new OperationItem();
        item.setId(UUID.randomUUID());
        item.setStatus("completed");
        when(operationService.appendItem(any(), any(), any(), anyString(), anyString(), anyString(),
                any(), any(), any())).thenReturn(item);
        when(client.revert(WORKSPACE_ID, SLICE_REF, List.of("c0.txt", RAW_REQUEST_MARKER)))
                .thenReturn(revertOk(1, 2, 25));

        RunCheckpointService.RevertOutcome outcome = service.revert(
                RUN_ID, WORKSPACE_ID, List.of("c0.txt", RAW_REQUEST_MARKER));

        assertEquals(RunCheckpointService.Gate.OK, outcome.gate());
        RunCheckpoint row = rows.get(0);
        assertEquals(RunCheckpoint.REVERT_PARTIAL, row.getRevertState());
        ArgumentCaptor<String> summary = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendItem(any(), any(), any(), eq("checkpoint"), eq("revert_checkpoint"),
                eq("ui"), summary.capture(), any(), any());
        assertTrue(summary.getValue().contains("\"reason\":\"FAILED\""));
        assertTrue(summary.getValue().contains("\"failed\":2"));
        long suspectCount = summary.getValue().split("\"suspect-", -1).length - 1;
        assertEquals(20, suspectCount, "suspects are capped at 20 in the ledger summary");
        assertFalse(summary.getValue().contains(RAW_REQUEST_MARKER));
        assertFalse(summary.getValue().contains("arguments"));
        assertFalse(summary.getValue().contains("details"));
        verify(operationService, never()).transitionItem(any(), any(), any(), any(), any(), any());
    }

    @Test
    void revertWithFailuresAndNoOperationSkipsLedger() {
        seedCapturedRow();
        when(client.revert(WORKSPACE_ID, SLICE_REF, List.of())).thenReturn(revertOk(1, 2, 0));

        RunCheckpointService.RevertOutcome outcome = service.revert(RUN_ID, WORKSPACE_ID, List.of());

        assertEquals(RunCheckpointService.Gate.OK, outcome.gate());
        RunCheckpoint row = rows.get(0);
        assertEquals(RunCheckpoint.REVERT_PARTIAL, row.getRevertState());
        assertTrue(row.getRevertSummary().contains("\"reason\":\"FAILED\""));
        verify(operationService, never()).appendItem(any(), any(), any(), anyString(), anyString(),
                anyString(), any(), any(), any());
    }

    @Test
    void revertMapsRuntimeFailureGates() {
        RunCheckpoint row = seedCapturedRow();

        when(client.revert(WORKSPACE_ID, SLICE_REF, List.of())).thenReturn(
                new RuntimeCheckpointClient.RevertResult(
                        RuntimeCheckpointClient.Outcome.TYPE_CHANGES_UNACKNOWLEDGED,
                        null, null, List.of(), 0L, List.of(), Map.of(),
                        "CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED"));
        RunCheckpointService.RevertOutcome conflicts = service.revert(RUN_ID, WORKSPACE_ID, List.of());
        assertEquals(RunCheckpointService.Gate.TYPE_CHANGES_UNACKNOWLEDGED, conflicts.gate());

        when(client.revert(WORKSPACE_ID, SLICE_REF, List.of())).thenReturn(
                new RuntimeCheckpointClient.RevertResult(RuntimeCheckpointClient.Outcome.RESTORE_LOCKED,
                        null, null, List.of(), 0L, List.of(), Map.of(), "CHECKPOINT_RESTORE_LOCKED"));
        RunCheckpointService.RevertOutcome locked = service.revert(RUN_ID, WORKSPACE_ID, List.of());
        assertEquals(RunCheckpointService.Gate.RESTORE_LOCKED, locked.gate());

        when(client.revert(WORKSPACE_ID, SLICE_REF, List.of())).thenReturn(
                new RuntimeCheckpointClient.RevertResult(RuntimeCheckpointClient.Outcome.TRANSPORT,
                        null, null, List.of(), 0L, List.of(), Map.of(), "unreachable"));
        RunCheckpointService.RevertOutcome transport = service.revert(RUN_ID, WORKSPACE_ID, List.of());
        assertEquals(RunCheckpointService.Gate.UNAVAILABLE, transport.gate());
        assertEquals(RunCheckpointService.REASON_UNAVAILABLE, transport.reason());
        assertEquals(RunCheckpoint.STATE_CAPTURED, row.getState(), "failed reverts leave the row captured");
        assertEquals(RunCheckpoint.REVERT_NONE, row.getRevertState());
    }

    @Test
    void revertOnMissingRowNeverCallsRuntime() {
        RunCheckpointService.RevertOutcome outcome = service.revert(RUN_ID, WORKSPACE_ID, List.of());

        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, outcome.gate());
        assertEquals(RunCheckpointService.REASON_MISSING, outcome.reason());
        verify(client, never()).revert(anyString(), anyString(), any());
    }

    @Test
    void checkpointFileMapsOutcomes() {
        seedCapturedRow();
        when(client.checkpointBlob(WORKSPACE_ID, SLICE_REF, "src/a.txt")).thenReturn(
                new RuntimeCheckpointClient.BlobResult(RuntimeCheckpointClient.Outcome.OK, "src/a.txt",
                        SLICE_REF, "hello", null, Map.of()));
        RunCheckpointService.FileOutcome ok = service.checkpointFile(RUN_ID, WORKSPACE_ID,
                "src/a.txt", SLICE_REF);
        assertEquals(RunCheckpointService.Gate.OK, ok.gate());
        assertEquals("hello", ok.content());

        when(client.checkpointBlob(WORKSPACE_ID, SLICE_REF, "big.bin")).thenReturn(
                new RuntimeCheckpointClient.BlobResult(RuntimeCheckpointClient.Outcome.TOO_LARGE,
                        "big.bin", SLICE_REF, null, "http_413",
                        Map.of("path", "big.bin", "size", 2, "max", 1)));
        RunCheckpointService.FileOutcome tooLarge = service.checkpointFile(RUN_ID, WORKSPACE_ID,
                "big.bin", SLICE_REF);
        assertEquals(RunCheckpointService.Gate.TOO_LARGE, tooLarge.gate());
        assertEquals("big.bin", tooLarge.details().get("path"));

        when(client.checkpointBlob(WORKSPACE_ID, SLICE_REF, "missing.txt")).thenReturn(
                new RuntimeCheckpointClient.BlobResult(RuntimeCheckpointClient.Outcome.NOT_FOUND,
                        "missing.txt", SLICE_REF, null, "http_404", Map.of()));
        RunCheckpointService.FileOutcome missing = service.checkpointFile(RUN_ID, WORKSPACE_ID,
                "missing.txt", SLICE_REF);
        assertEquals(RunCheckpointService.Gate.FILE_NOT_FOUND, missing.gate());
        assertEquals(RunCheckpoint.STATE_CAPTURED, rows.get(0).getState(),
                "a missing blob path must never expire the checkpoint row");
    }

    @Test
    void gitStatusAndGcMapRuntimeOutcomes() {
        when(client.workspaceGitStatus(WORKSPACE_ID)).thenReturn(new RuntimeCheckpointClient.GitStatusResult(
                RuntimeCheckpointClient.Outcome.OK, true,
                List.of(new RuntimeCheckpointClient.GitStatusEntry("M", "a.txt")), null));
        RunCheckpointService.GitStatusOutcome status = service.gitStatus(WORKSPACE_ID);
        assertEquals(RunCheckpointService.Gate.OK, status.gate());
        assertTrue(status.isRepository());
        assertEquals(1, status.entries().size());

        when(client.workspaceGitStatus(WORKSPACE_ID)).thenReturn(new RuntimeCheckpointClient.GitStatusResult(
                RuntimeCheckpointClient.Outcome.UNAVAILABLE, false, List.of(), "git_unavailable"));
        RunCheckpointService.GitStatusOutcome degraded = service.gitStatus(WORKSPACE_ID);
        assertEquals(RunCheckpointService.Gate.UNAVAILABLE, degraded.gate());
        assertEquals("git_unavailable", degraded.reason());

        when(client.gc(WORKSPACE_ID)).thenReturn(new RuntimeCheckpointClient.GcResult(
                RuntimeCheckpointClient.Outcome.OK, Map.of("deleted", 2), null));
        RunCheckpointService.GcOutcome gc = service.gc(WORKSPACE_ID);
        assertEquals(RunCheckpointService.Gate.OK, gc.gate());
        assertEquals(2, ((Number) gc.counts().get("deleted")).intValue());

        when(client.gc(WORKSPACE_ID)).thenReturn(new RuntimeCheckpointClient.GcResult(
                RuntimeCheckpointClient.Outcome.TRANSPORT, Map.of(), "unreachable"));
        assertEquals(RunCheckpointService.Gate.UNAVAILABLE, service.gc(WORKSPACE_ID).gate());
    }

    @Test
    void retentionReturnsConstantsAndCounts() {
        when(repository.countByWorkspaceId(WORKSPACE_ID)).thenReturn(7L);
        when(repository.countBaseRefs(WORKSPACE_ID)).thenReturn(0L);
        when(repository.countEndRefs(WORKSPACE_ID)).thenReturn(5L);

        RunCheckpointService.RetentionView view = service.retention(WORKSPACE_ID);

        assertEquals(50, view.maxRuns());
        assertEquals(30, view.ttlDays());
        assertTrue(view.unsealedNeverDeleted());
        assertEquals(7, view.currentRuns());
        assertEquals(5, view.currentRefs());
    }

    @Test
    @SuppressWarnings("unchecked")
    void capturedAndDegradedRowsEmitRunCheckpointSse() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, captureCallId(RUN_ID), false))
                .thenReturn(captureOk(SLICE_REF));

        assertTrue(service.captureCheckpoint(RUN_ID));

        ArgumentCaptor<Map<String, Object>> payload = ArgumentCaptor.forClass(Map.class);
        verify(sseManager).send(eq(SESSION_ID), eq("run_checkpoint"), payload.capture());
        assertEquals(RunCheckpoint.STATE_CAPTURED, payload.getValue().get("state"));
        assertEquals(1, payload.getValue().get("changedCount"));

        String otherRun = "99999999-9999-9999-9999-999999999999";
        when(chatRunRepository.findById(UUID.fromString(otherRun)))
                .thenReturn(Optional.of(new ChatRun(otherRun, SESSION_ID, USER_ID, WORKSPACE_ID,
                        "idem", "hash", "openai", "gpt-test", "none", "succeeded")));
        when(client.capture(WORKSPACE_ID, otherRun, USER_ID, captureCallId(otherRun), false))
                .thenReturn(new RuntimeCheckpointClient.CaptureResult(
                        RuntimeCheckpointClient.Outcome.UNAVAILABLE, otherRun, false, null, null, null,
                        null, List.of(), List.of(), null, "git_unavailable"));

        assertFalse(service.captureCheckpoint(otherRun));

        ArgumentCaptor<Map<String, Object>> degradedPayload = ArgumentCaptor.forClass(Map.class);
        verify(sseManager, times(2)).send(eq(SESSION_ID), eq("run_checkpoint"), degradedPayload.capture());
        assertEquals(RunCheckpoint.STATE_DEGRADED, degradedPayload.getAllValues().get(1).get("state"));
        assertEquals(RunCheckpointService.REASON_UNAVAILABLE,
                degradedPayload.getAllValues().get(1).get("unrollableReason"));
    }
}
