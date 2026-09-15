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
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
 * PLAN-0328 M2 W3: Run checkpoint lifecycle — idempotent establishment, frozen
 * degradation policy, idempotent seal, ledger markers, startup sweep.
 */
class RunCheckpointServiceTest {

    private static final String RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
    private static final String CHECKPOINT_ID = "33333333-3333-3333-3333-333333333333";

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
        when(repository.findByRunId(anyString()))
                .thenAnswer(invocation -> rows.stream()
                        .filter(row -> row.getRunId().equals(invocation.getArgument(0)))
                        .toList());
        when(repository.findByState(anyString()))
                .thenAnswer(invocation -> rows.stream()
                        .filter(row -> row.getState().equals(invocation.getArgument(0)))
                        .toList());
        when(repository.save(any(RunCheckpoint.class))).thenAnswer(invocation -> {
            RunCheckpoint row = invocation.getArgument(0);
            rows.removeIf(existing -> existing.getId().equals(row.getId()));
            rows.add(row);
            return row;
        });
        when(repository.markSealed(any(), any(), any(), anyBoolean(), anyBoolean(), any()))
                .thenAnswer(invocation -> {
                    UUID id = invocation.getArgument(0);
                    for (RunCheckpoint row : rows) {
                        if (row.getId().equals(id) && RunCheckpoint.STATE_BASE.equals(row.getState())) {
                            row.setState(RunCheckpoint.STATE_SEALED);
                            row.setChangedFiles(invocation.getArgument(2));
                            return 1;
                        }
                    }
                    return 0;
                });
        when(repository.markReverted(any(), any(), any(), any(), any()))
                .thenAnswer(invocation -> {
                    UUID id = invocation.getArgument(0);
                    for (RunCheckpoint row : rows) {
                        if (row.getId().equals(id) && RunCheckpoint.STATE_SEALED.equals(row.getState())) {
                            return 1;
                        }
                    }
                    return 0;
                });
        when(repository.markExpired(any(), any()))
                .thenAnswer(invocation -> {
                    UUID id = invocation.getArgument(0);
                    for (RunCheckpoint row : rows) {
                        if (row.getId().equals(id) && RunCheckpoint.STATE_SEALED.equals(row.getState())) {
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

    private RunCheckpoint seedBaseRow() {
        RunCheckpoint row = new RunCheckpoint();
        row.setId(UUID.randomUUID());
        row.setRunId(RUN_ID);
        row.setWorkspaceId(WORKSPACE_ID);
        row.setState(RunCheckpoint.STATE_BASE);
        row.setBaseRef("refs/xihe/" + RUN_ID + "/base");
        row.setCreatedAt(Instant.now());
        row.setUpdatedAt(Instant.now());
        rows.add(row);
        return row;
    }

    private RuntimeCheckpointClient.CreateResult created() {
        return new RuntimeCheckpointClient.CreateResult(RuntimeCheckpointClient.Outcome.OK,
                CHECKPOINT_ID, RUN_ID, "base", "refs/xihe/" + RUN_ID + "/base",
                "2026-09-15T00:00:00Z", null);
    }

    private RuntimeCheckpointClient.SealResult sealed() {
        return new RuntimeCheckpointClient.SealResult(RuntimeCheckpointClient.Outcome.OK, "sealed",
                "refs/xihe/" + RUN_ID + "/end",
                List.of(new RuntimeCheckpointClient.ChangedFile("M", "src/a.txt")), false, false, null);
    }

    @Test
    void ensureCheckpointIsIdempotentPerRun() {
        when(client.create(WORKSPACE_ID, RUN_ID, "user-1", "call-1")).thenReturn(created());

        service.ensureCheckpoint(RUN_ID, WORKSPACE_ID, "user-1", "call-1");
        service.ensureCheckpoint(RUN_ID, WORKSPACE_ID, "user-1", "call-1");

        verify(client, times(1)).create(WORKSPACE_ID, RUN_ID, "user-1", "call-1");
        assertEquals(1, rows.size());
        assertEquals(RunCheckpoint.STATE_BASE, rows.get(0).getState());
        assertEquals(CHECKPOINT_ID, rows.get(0).getId().toString());
        assertEquals("refs/xihe/" + RUN_ID + "/base", rows.get(0).getBaseRef());
    }

    @Test
    void leaseHeldDegradesWithFrozenReason() {
        when(client.create(WORKSPACE_ID, RUN_ID, "user-1", "call-1"))
                .thenReturn(new RuntimeCheckpointClient.CreateResult(
                        RuntimeCheckpointClient.Outcome.LEASE_HELD, null, RUN_ID, null, null, null,
                        "CHECKPOINT_LEASE_HELD"));

        service.ensureCheckpoint(RUN_ID, WORKSPACE_ID, "user-1", "call-1");

        assertEquals(1, rows.size());
        assertEquals(RunCheckpoint.STATE_DEGRADED, rows.get(0).getState());
        assertEquals(RunCheckpointService.REASON_LEASE_HELD, rows.get(0).getUnrollableReason());
    }

    @Test
    void unavailableDegradesWithFrozenReason() {
        when(client.create(WORKSPACE_ID, RUN_ID, "user-1", "call-1"))
                .thenReturn(new RuntimeCheckpointClient.CreateResult(
                        RuntimeCheckpointClient.Outcome.UNAVAILABLE, null, RUN_ID, null, null, null,
                        "CHECKPOINT_UNAVAILABLE"));

        service.ensureCheckpoint(RUN_ID, WORKSPACE_ID, "user-1", "call-1");

        assertEquals(RunCheckpoint.STATE_DEGRADED, rows.get(0).getState());
        assertEquals(RunCheckpointService.REASON_UNAVAILABLE, rows.get(0).getUnrollableReason());
    }

    @Test
    void transportFailureDegradesInsteadOfThrowing() {
        when(client.create(WORKSPACE_ID, RUN_ID, "user-1", "call-1"))
                .thenReturn(new RuntimeCheckpointClient.CreateResult(
                        RuntimeCheckpointClient.Outcome.TRANSPORT, null, RUN_ID, null, null, null,
                        "unreachable"));

        service.ensureCheckpoint(RUN_ID, WORKSPACE_ID, "user-1", "call-1");

        assertEquals(RunCheckpoint.STATE_DEGRADED, rows.get(0).getState());
        assertEquals(RunCheckpointService.REASON_UNAVAILABLE, rows.get(0).getUnrollableReason());
    }

    @Test
    void unexpectedEstablishFailureIsSwallowedInsteadOfBlockingDispatch() {
        when(repository.findByRunIdAndWorkspaceId(anyString(), anyString()))
                .thenThrow(new IllegalStateException("checkpoint store down"));

        service.ensureCheckpoint(RUN_ID, WORKSPACE_ID, "user-1", "call-1");

        verify(client, never()).create(anyString(), anyString(), any(), any());
    }

    @Test
    void degradedRowStopsFurtherEstablishAttemptsForTheRun() {
        when(client.create(WORKSPACE_ID, RUN_ID, "user-1", "call-1"))
                .thenReturn(new RuntimeCheckpointClient.CreateResult(
                        RuntimeCheckpointClient.Outcome.LEASE_HELD, null, RUN_ID, null, null, null,
                        "CHECKPOINT_LEASE_HELD"));

        service.ensureCheckpoint(RUN_ID, WORKSPACE_ID, "user-1", "call-1");
        service.ensureCheckpoint(RUN_ID, WORKSPACE_ID, "user-1", "call-1");

        verify(client, times(1)).create(anyString(), anyString(), any(), any());
        assertEquals(1, rows.size());
    }

    @Test
    void sealTransitionsBaseRowOnceAndIsIdempotent() {
        seedBaseRow();
        when(client.seal(WORKSPACE_ID, RUN_ID)).thenReturn(sealed());

        assertTrue(service.sealCheckpoint(RUN_ID));
        assertFalse(service.sealCheckpoint(RUN_ID), "a sealed row must not seal twice");

        verify(client, times(1)).seal(WORKSPACE_ID, RUN_ID);
        assertEquals(RunCheckpoint.STATE_SEALED, rows.get(0).getState());
        assertTrue(rows.get(0).getChangedFiles().contains("src/a.txt"));
        assertFalse(rows.get(0).isSealedWithLiveJobs());
        assertFalse(rows.get(0).isSealedAfterAbnormal());
    }

    @Test
    void sealFailureLeavesBaseRowForRuntimeSweep() {
        seedBaseRow();
        when(client.seal(WORKSPACE_ID, RUN_ID)).thenReturn(new RuntimeCheckpointClient.SealResult(
                RuntimeCheckpointClient.Outcome.UNAVAILABLE, null, null, List.of(), false, false,
                "git_unavailable"));

        assertFalse(service.sealCheckpoint(RUN_ID));

        assertEquals(RunCheckpoint.STATE_BASE, rows.get(0).getState());
        verify(repository, never()).markSealed(any(), any(), any(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void sealWithoutRowIsANoOp() {
        assertFalse(service.sealCheckpoint(RUN_ID));
        verify(client, never()).seal(anyString(), anyString());
    }

    @Test
    void sealPreservesRuntimeAbnormalFlags() {
        seedBaseRow();
        when(client.seal(WORKSPACE_ID, RUN_ID)).thenReturn(new RuntimeCheckpointClient.SealResult(
                RuntimeCheckpointClient.Outcome.OK, "sealed", null, List.of(), true, true, null));

        assertTrue(service.sealCheckpoint(RUN_ID));

        assertTrue(rows.get(0).isSealedWithLiveJobs());
        assertTrue(rows.get(0).isSealedAfterAbnormal());
    }

    @Test
    @SuppressWarnings("unchecked")
    void createAndSealAppendDistinctLedgerMarkers() {
        UUID operationId = UUID.randomUUID();
        when(operationService.findOperationIdByRunId(RUN_ID)).thenReturn(operationId);
        OperationItem item = new OperationItem();
        item.setId(UUID.randomUUID());
        item.setStatus("pending");
        when(operationService.appendItem(eq(operationId), any(), any(), eq("checkpoint"),
                eq("run_checkpoint"), eq("runtime"), any(), any(), any())).thenReturn(item);
        when(client.create(WORKSPACE_ID, RUN_ID, "user-1", "call-1")).thenReturn(created());
        when(client.seal(WORKSPACE_ID, RUN_ID)).thenReturn(sealed());

        service.ensureCheckpoint(RUN_ID, WORKSPACE_ID, "user-1", "call-1");
        assertTrue(service.sealCheckpoint(RUN_ID));

        ArgumentCaptor<String> previews = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> toolCallIds = ArgumentCaptor.forClass(String.class);
        verify(operationService, times(2)).appendItem(eq(operationId), toolCallIds.capture(), any(),
                eq("checkpoint"), eq("run_checkpoint"), eq("runtime"), previews.capture(), isNull(), isNull());
        verify(operationService, times(2)).transitionItem(eq(item.getId()), eq("completed"),
                isNull(), isNull(), any(), isNull());
        assertEquals(2, toolCallIds.getAllValues().stream().distinct().count(),
                "base and seal markers must use distinct ledger identities");
        assertTrue(previews.getAllValues().stream().anyMatch(value -> value.contains("base")));
        assertTrue(previews.getAllValues().stream().anyMatch(value -> value.contains("seal")));
    }

    @Test
    void ledgerMarkerIsSkippedWhenOperationIsMissing() {
        when(client.create(WORKSPACE_ID, RUN_ID, "user-1", "call-1")).thenReturn(created());

        service.ensureCheckpoint(RUN_ID, WORKSPACE_ID, "user-1", "call-1");

        verify(operationService, never()).appendItem(any(), any(), any(), anyString(), anyString(),
                anyString(), any(), any(), any());
        assertEquals(1, rows.size());
    }

    @Test
    void startupSweepSealsTerminalRunOnce() {
        seedBaseRow();
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("ambiguous")));
        when(client.seal(WORKSPACE_ID, RUN_ID)).thenReturn(sealed());

        assertEquals(1, service.sealTerminalCheckpoints());
        assertEquals(0, service.sealTerminalCheckpoints(), "the sweep is idempotent");

        verify(client, times(1)).seal(WORKSPACE_ID, RUN_ID);
        assertEquals(RunCheckpoint.STATE_SEALED, rows.get(0).getState());
    }

    @Test
    void startupSweepSkipsLiveRuns() {
        seedBaseRow();
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("running")));

        assertEquals(0, service.sealTerminalCheckpoints());

        verify(client, never()).seal(anyString(), anyString());
        assertEquals(RunCheckpoint.STATE_BASE, rows.get(0).getState());
    }

    @Test
    void requestSealRunsAsynchronouslyAndNeverThrows() {
        seedBaseRow();
        when(client.seal(WORKSPACE_ID, RUN_ID)).thenReturn(sealed());

        service.requestSeal(RUN_ID);

        verify(client, timeout(3000)).seal(WORKSPACE_ID, RUN_ID);
    }

    @Test
    void requestSealForMissingRunNeverThrows() {
        service.requestSeal(RUN_ID);
        verify(client, never()).seal(anyString(), anyString());
    }

    private ChatRun runWithStatus(String status) {
        return new ChatRun(RUN_ID, "44444444-4444-4444-4444-444444444444",
                "55555555-5555-5555-5555-555555555555", WORKSPACE_ID,
                "idem-" + status, "hash", "openai", "gpt-test", "none", status);
    }

    // ── PLAN-0328 M3 W2: view / revert / file / git / retention ─────────────

    private static final String SESSION_ID = "44444444-4444-4444-4444-444444444444";

    private RunCheckpoint seedSealedRow() {
        RunCheckpoint row = seedBaseRow();
        row.setState(RunCheckpoint.STATE_SEALED);
        row.setEndRef("refs/xihe/" + RUN_ID + "/end");
        row.setChangedFiles("[{\"status\":\"M\",\"path\":\"src/a.txt\"}]");
        row.setSealedAt(Instant.now());
        return row;
    }

    private RuntimeCheckpointClient.RevertPreview previewOk() {
        return new RuntimeCheckpointClient.RevertPreview(RuntimeCheckpointClient.Outcome.OK, RUN_ID,
                "sealed", new RuntimeCheckpointClient.PreviewCounts(1, 0, 0, 0),
                List.of(new RuntimeCheckpointClient.PreviewEntry("src/a.txt", null, "restore", null)),
                Map.of("status", "ok"), false, false, Map.of(), null);
    }

    private RuntimeCheckpointClient.RevertResult revertOk(int restored, int skippedConflict, int failed) {
        List<RuntimeCheckpointClient.ExecuteEntry> entries = new java.util.ArrayList<>();
        for (int i = 0; i < restored; i++) {
            entries.add(new RuntimeCheckpointClient.ExecuteEntry("r" + i + ".txt", "restored", null));
        }
        for (int i = 0; i < skippedConflict; i++) {
            entries.add(new RuntimeCheckpointClient.ExecuteEntry("c" + i + ".txt", "skippedConflict",
                    "CONTENT_CHANGED"));
        }
        for (int i = 0; i < failed; i++) {
            entries.add(new RuntimeCheckpointClient.ExecuteEntry("f" + i + ".txt", "failed", "IO_ERROR"));
        }
        return new RuntimeCheckpointClient.RevertResult(RuntimeCheckpointClient.Outcome.OK, RUN_ID,
                "refs/xihe/" + RUN_ID + "/rollback/1",
                new RuntimeCheckpointClient.ExecuteCounts(restored, 0, skippedConflict, failed, 0),
                entries, 12L, Map.of(), null);
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
        RunCheckpoint row = seedSealedRow();
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

        assertEquals(RunCheckpoint.STATE_SEALED, view.state());
        assertEquals(25, view.changedCount());
        assertEquals(20, view.changedFiles().size());
        assertEquals("f0.txt", view.changedFiles().get(0).path());
    }

    @Test
    void viewProjectsRevertSummaryCounts() {
        RunCheckpoint row = seedSealedRow();
        row.setRevertState(RunCheckpoint.REVERT_PARTIAL);
        row.setRevertedAt(Instant.parse("2026-09-15T10:00:00Z"));
        row.setRevertRef("refs/xihe/" + RUN_ID + "/rollback/7");
        row.setRevertSummary("{\"marker\":\"revert\",\"counts\":{\"restored\":2,\"deleted\":1,"
                + "\"skippedConflict\":1,\"failed\":0,\"noop\":0},\"revertRef\":\"refs/xihe/x\"}");

        RunCheckpointService.View view = service.view(RUN_ID, WORKSPACE_ID);

        assertEquals(RunCheckpoint.REVERT_PARTIAL, view.revert().state());
        assertEquals(Instant.parse("2026-09-15T10:00:00Z"), view.revert().at());
        assertEquals("refs/xihe/" + RUN_ID + "/rollback/7", view.revert().ref());
        assertEquals(2, ((Number) view.revert().counts().get("restored")).intValue());
    }

    @Test
    void previewRevertBlocksMissingDegradedAndUnsealedRows() {
        RunCheckpointService.PreviewOutcome missing = service.previewRevert(RUN_ID, WORKSPACE_ID);
        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, missing.gate());
        assertEquals(RunCheckpointService.REASON_MISSING, missing.reason());

        RunCheckpoint degraded = seedBaseRow();
        degraded.setState(RunCheckpoint.STATE_DEGRADED);
        degraded.setUnrollableReason(RunCheckpointService.REASON_LEASE_HELD);
        RunCheckpointService.PreviewOutcome degradedOutcome =
                service.previewRevert(RUN_ID, WORKSPACE_ID);
        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, degradedOutcome.gate());
        assertEquals(RunCheckpointService.REASON_LEASE_HELD, degradedOutcome.reason());

        degraded.setState(RunCheckpoint.STATE_BASE);
        degraded.setUnrollableReason(null);
        RunCheckpointService.PreviewOutcome unsealed = service.previewRevert(RUN_ID, WORKSPACE_ID);
        assertEquals(RunCheckpointService.Gate.NOT_SEALED, unsealed.gate());

        verify(client, never()).previewRevert(anyString(), anyString());
    }

    @Test
    void previewRevertPassesThroughSealedRuntimePreview() {
        seedSealedRow();
        when(client.previewRevert(WORKSPACE_ID, RUN_ID)).thenReturn(previewOk());

        RunCheckpointService.PreviewOutcome outcome = service.previewRevert(RUN_ID, WORKSPACE_ID);

        assertEquals(RunCheckpointService.Gate.OK, outcome.gate());
        assertEquals(1, outcome.preview().counts().restore());
        assertEquals("restore", outcome.preview().entries().get(0).action());
        verify(client).previewRevert(WORKSPACE_ID, RUN_ID);
    }

    @Test
    void previewRevertFlipsSealedRowToExpiredOnceWhenRuntimeRefsAreGone() {
        seedSealedRow();
        when(client.previewRevert(WORKSPACE_ID, RUN_ID)).thenReturn(
                new RuntimeCheckpointClient.RevertPreview(RuntimeCheckpointClient.Outcome.NOT_FOUND,
                        null, null, null, List.of(), Map.of(), false, false, Map.of(), "http_404"));

        RunCheckpointService.PreviewOutcome first = service.previewRevert(RUN_ID, WORKSPACE_ID);
        RunCheckpointService.PreviewOutcome second = service.previewRevert(RUN_ID, WORKSPACE_ID);

        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, first.gate());
        assertEquals(RunCheckpointService.REASON_EXPIRED, first.reason());
        assertEquals(RunCheckpoint.STATE_EXPIRED, rows.get(0).getState());
        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, second.gate());
        assertEquals(RunCheckpointService.REASON_EXPIRED, second.reason());
        verify(repository, times(1)).markExpired(any(), any());
        verify(client, times(1)).previewRevert(WORKSPACE_ID, RUN_ID);
    }

    @Test
    void revertHappyPathRecordsRolledBackLedgerAndAttemptCount() {
        seedSealedRow();
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        UUID operationId = UUID.randomUUID();
        when(operationService.findOperationIdByRunId(RUN_ID)).thenReturn(operationId);
        OperationItem item = new OperationItem();
        item.setId(UUID.randomUUID());
        item.setStatus("pending");
        when(operationService.appendItem(eq(operationId), any(), any(), eq("checkpoint"),
                eq("revert_snapshot"), eq("cp"), any(), any(), any())).thenReturn(item);
        when(client.revert(WORKSPACE_ID, RUN_ID, List.of(), false)).thenReturn(revertOk(2, 0, 0));

        RunCheckpointService.RevertOutcome outcome = service.revert(RUN_ID, WORKSPACE_ID, List.of(), false);

        assertEquals(RunCheckpointService.Gate.OK, outcome.gate());
        RunCheckpoint row = rows.get(0);
        assertEquals(RunCheckpoint.REVERT_ROLLED_BACK, row.getRevertState());
        assertEquals("refs/xihe/" + RUN_ID + "/rollback/1", row.getRevertRef());
        assertEquals(1, row.getRevertAttemptCount());
        assertNotNull(row.getRevertedAt());
        verify(repository).markReverted(eq(row.getId()), eq(RunCheckpoint.REVERT_ROLLED_BACK),
                eq("refs/xihe/" + RUN_ID + "/rollback/1"), any(), any());

        ArgumentCaptor<String> summary = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendItem(eq(operationId), any(), any(), eq("checkpoint"),
                eq("revert_snapshot"), eq("cp"), summary.capture(), isNull(), isNull());
        assertTrue(summary.getValue().contains("\"marker\":\"revert\""));
        assertTrue(summary.getValue().contains("\"checkpointId\":\"" + row.getId() + "\""));
        assertTrue(summary.getValue().contains("\"allowedBy\":\"user_ui\""));
        assertTrue(summary.getValue().contains("\"restored\":2"));
        assertTrue(summary.getValue().contains("\"reason\":null"));
        verify(operationService).transitionItem(eq(item.getId()), eq("completed"), isNull(), isNull(),
                any(), isNull());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> payload = ArgumentCaptor.forClass(Map.class);
        verify(sseManager).send(eq(SESSION_ID), eq("run_checkpoint"), payload.capture());
        assertEquals(RunCheckpoint.STATE_SEALED, payload.getValue().get("state"));
        assertEquals(RUN_ID, payload.getValue().get("runId"));
        @SuppressWarnings("unchecked")
        Map<String, Object> revert = (Map<String, Object>) payload.getValue().get("revert");
        assertEquals(RunCheckpoint.REVERT_ROLLED_BACK, revert.get("state"));
    }

    @Test
    void revertPartialRecordsPartialStateAndCappedConflicts() {
        seedSealedRow();
        UUID operationId = UUID.randomUUID();
        when(operationService.findOperationIdByRunId(RUN_ID)).thenReturn(operationId);
        OperationItem item = new OperationItem();
        item.setId(UUID.randomUUID());
        item.setStatus("completed");
        when(operationService.appendItem(any(), any(), any(), anyString(), anyString(), anyString(),
                any(), any(), any())).thenReturn(item);
        when(client.revert(WORKSPACE_ID, RUN_ID, List.of("c0.txt"), true)).thenReturn(revertOk(1, 25, 0));

        RunCheckpointService.RevertOutcome outcome =
                service.revert(RUN_ID, WORKSPACE_ID, List.of("c0.txt"), true);

        assertEquals(RunCheckpointService.Gate.OK, outcome.gate());
        RunCheckpoint row = rows.get(0);
        assertEquals(RunCheckpoint.REVERT_PARTIAL, row.getRevertState());
        ArgumentCaptor<String> summary = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendItem(any(), any(), any(), eq("checkpoint"), eq("revert_snapshot"),
                eq("cp"), summary.capture(), any(), any());
        assertTrue(summary.getValue().contains("\"reason\":\"CONFLICTS\""));
        long conflictCount = summary.getValue().split("\"path\":\"c", -1).length - 1;
        assertEquals(20, conflictCount, "conflicts are capped at 20 in the ledger summary");
        verify(operationService, never()).transitionItem(any(), any(), any(), any(), any(), any());
    }

    @Test
    void revertPartialWithFailuresUsesFailedReasonAndNoLedgerWhenOperationMissing() {
        seedSealedRow();
        when(client.revert(WORKSPACE_ID, RUN_ID, List.of(), false)).thenReturn(revertOk(1, 1, 2));

        RunCheckpointService.RevertOutcome outcome = service.revert(RUN_ID, WORKSPACE_ID, List.of(), false);

        assertEquals(RunCheckpointService.Gate.OK, outcome.gate());
        RunCheckpoint row = rows.get(0);
        assertEquals(RunCheckpoint.REVERT_PARTIAL, row.getRevertState());
        assertTrue(row.getRevertSummary().contains("\"reason\":\"FAILED_AND_CONFLICTS\""));
        verify(operationService, never()).appendItem(any(), any(), any(), anyString(), anyString(),
                anyString(), any(), any(), any());
    }

    @Test
    void revertMapsRuntimeFailureGates() {
        RunCheckpoint row = seedSealedRow();

        when(client.revert(WORKSPACE_ID, RUN_ID, List.of(), false)).thenReturn(
                new RuntimeCheckpointClient.RevertResult(RuntimeCheckpointClient.Outcome.LEASE_HELD,
                        null, null, null, List.of(), 0L,
                        Map.of("heldByRunId", "run-other", "expiresAtMs", 1), "CHECKPOINT_LEASE_HELD"));
        RunCheckpointService.RevertOutcome lease = service.revert(RUN_ID, WORKSPACE_ID, List.of(), false);
        assertEquals(RunCheckpointService.Gate.LEASE_HELD, lease.gate());
        assertEquals("run-other", lease.details().get("heldByRunId"));

        when(client.revert(WORKSPACE_ID, RUN_ID, List.of(), false)).thenReturn(
                new RuntimeCheckpointClient.RevertResult(RuntimeCheckpointClient.Outcome.HEAD_CHANGED,
                        null, null, null, List.of(), 0L,
                        Map.of("recorded", Map.of("commit", "a"), "observed", Map.of("commit", "b")),
                        "CHECKPOINT_HEAD_CHANGED"));
        RunCheckpointService.RevertOutcome head = service.revert(RUN_ID, WORKSPACE_ID, List.of(), false);
        assertEquals(RunCheckpointService.Gate.HEAD_CHANGED, head.gate());
        assertTrue(head.details().containsKey("recorded"));

        when(client.revert(WORKSPACE_ID, RUN_ID, List.of(), false)).thenReturn(
                new RuntimeCheckpointClient.RevertResult(
                        RuntimeCheckpointClient.Outcome.CONFLICTS_UNACKNOWLEDGED, null, null, null,
                        List.of(), 0L, Map.of("paths", List.of("a.txt")), "CHECKPOINT_CONFLICTS_UNACKNOWLEDGED"));
        RunCheckpointService.RevertOutcome conflicts = service.revert(RUN_ID, WORKSPACE_ID, List.of(), false);
        assertEquals(RunCheckpointService.Gate.CONFLICTS_UNACKNOWLEDGED, conflicts.gate());
        assertEquals(List.of("a.txt"), conflicts.details().get("paths"));

        when(client.revert(WORKSPACE_ID, RUN_ID, List.of(), false)).thenReturn(
                new RuntimeCheckpointClient.RevertResult(RuntimeCheckpointClient.Outcome.TRANSPORT,
                        null, null, null, List.of(), 0L, Map.of(), "unreachable"));
        RunCheckpointService.RevertOutcome transport = service.revert(RUN_ID, WORKSPACE_ID, List.of(), false);
        assertEquals(RunCheckpointService.Gate.UNAVAILABLE, transport.gate());
        assertEquals(RunCheckpointService.REASON_UNAVAILABLE, transport.reason());
        assertEquals(RunCheckpoint.STATE_SEALED, row.getState(), "failed reverts leave the row sealed");
        assertEquals(RunCheckpoint.REVERT_NONE, row.getRevertState());
    }

    @Test
    void revertOnMissingRowNeverCallsRuntime() {
        RunCheckpointService.RevertOutcome outcome = service.revert(RUN_ID, WORKSPACE_ID, List.of(), false);

        assertEquals(RunCheckpointService.Gate.NOT_AVAILABLE, outcome.gate());
        assertEquals(RunCheckpointService.REASON_MISSING, outcome.reason());
        verify(client, never()).revert(anyString(), anyString(), any(), anyBoolean());
    }

    @Test
    void checkpointFileMapsOutcomes() {
        seedSealedRow();
        when(client.checkpointBlob(WORKSPACE_ID, RUN_ID, "base", "src/a.txt")).thenReturn(
                new RuntimeCheckpointClient.BlobResult(RuntimeCheckpointClient.Outcome.OK, "src/a.txt",
                        "base", "hello", null, Map.of()));
        RunCheckpointService.FileOutcome ok = service.checkpointFile(RUN_ID, WORKSPACE_ID,
                "src/a.txt", "base");
        assertEquals(RunCheckpointService.Gate.OK, ok.gate());
        assertEquals("hello", ok.content());

        when(client.checkpointBlob(WORKSPACE_ID, RUN_ID, "end", "big.bin")).thenReturn(
                new RuntimeCheckpointClient.BlobResult(RuntimeCheckpointClient.Outcome.TOO_LARGE,
                        "big.bin", "end", null, "http_413",
                        Map.of("path", "big.bin", "size", 2, "max", 1)));
        RunCheckpointService.FileOutcome tooLarge = service.checkpointFile(RUN_ID, WORKSPACE_ID,
                "big.bin", "end");
        assertEquals(RunCheckpointService.Gate.TOO_LARGE, tooLarge.gate());
        assertEquals("big.bin", tooLarge.details().get("path"));

        when(client.checkpointBlob(WORKSPACE_ID, RUN_ID, "base", "missing.txt")).thenReturn(
                new RuntimeCheckpointClient.BlobResult(RuntimeCheckpointClient.Outcome.NOT_FOUND,
                        "missing.txt", "base", null, "http_404", Map.of()));
        RunCheckpointService.FileOutcome missing = service.checkpointFile(RUN_ID, WORKSPACE_ID,
                "missing.txt", "base");
        assertEquals(RunCheckpointService.Gate.FILE_NOT_FOUND, missing.gate());
        assertEquals(RunCheckpoint.STATE_SEALED, rows.get(0).getState(),
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
                RuntimeCheckpointClient.Outcome.OK, Map.of("deletedRuns", 2), null));
        RunCheckpointService.GcOutcome gc = service.gc(WORKSPACE_ID);
        assertEquals(RunCheckpointService.Gate.OK, gc.gate());
        assertEquals(2, ((Number) gc.counts().get("deletedRuns")).intValue());

        when(client.gc(WORKSPACE_ID)).thenReturn(new RuntimeCheckpointClient.GcResult(
                RuntimeCheckpointClient.Outcome.TRANSPORT, Map.of(), "unreachable"));
        assertEquals(RunCheckpointService.Gate.UNAVAILABLE, service.gc(WORKSPACE_ID).gate());
    }

    @Test
    void retentionReturnsConstantsAndCounts() {
        when(repository.countByWorkspaceId(WORKSPACE_ID)).thenReturn(7L);
        when(repository.countBaseRefs(WORKSPACE_ID)).thenReturn(7L);
        when(repository.countEndRefs(WORKSPACE_ID)).thenReturn(5L);

        RunCheckpointService.RetentionView view = service.retention(WORKSPACE_ID);

        assertEquals(50, view.maxRuns());
        assertEquals(30, view.ttlDays());
        assertTrue(view.unsealedNeverDeleted());
        assertEquals(7, view.currentRuns());
        assertEquals(12, view.currentRefs());
    }

    @Test
    void degradedAndSealedRowsEmitRunCheckpointSse() {
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(runWithStatus("succeeded")));
        seedBaseRow();
        when(client.seal(WORKSPACE_ID, RUN_ID)).thenReturn(sealed());

        assertTrue(service.sealCheckpoint(RUN_ID));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> payload = ArgumentCaptor.forClass(Map.class);
        verify(sseManager).send(eq(SESSION_ID), eq("run_checkpoint"), payload.capture());
        assertEquals(RunCheckpoint.STATE_SEALED, payload.getValue().get("state"));
        assertEquals(1, payload.getValue().get("changedCount"));

        when(client.create(WORKSPACE_ID, "99999999-9999-9999-9999-999999999999", "user-1", "call-1"))
                .thenReturn(new RuntimeCheckpointClient.CreateResult(
                        RuntimeCheckpointClient.Outcome.LEASE_HELD,
                        null, "99999999-9999-9999-9999-999999999999", null, null, null,
                        "CHECKPOINT_LEASE_HELD"));
        when(chatRunRepository.findById(UUID.fromString("99999999-9999-9999-9999-999999999999")))
                .thenReturn(Optional.of(new ChatRun("99999999-9999-9999-9999-999999999999", SESSION_ID,
                        "55555555-5555-5555-5555-555555555555", WORKSPACE_ID,
                        "idem", "hash", "openai", "gpt-test", "none", "running")));

        service.ensureCheckpoint("99999999-9999-9999-9999-999999999999", WORKSPACE_ID, "user-1", "call-1");

        ArgumentCaptor<Map<String, Object>> degradedPayload = ArgumentCaptor.forClass(Map.class);
        verify(sseManager, times(2)).send(eq(SESSION_ID), eq("run_checkpoint"), degradedPayload.capture());
        assertEquals(RunCheckpoint.STATE_DEGRADED, degradedPayload.getAllValues().get(1).get("state"));
        assertEquals(RunCheckpointService.REASON_LEASE_HELD,
                degradedPayload.getAllValues().get(1).get("unrollableReason"));
    }
}
