package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
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
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
    private RunCheckpointService service;
    private final List<RunCheckpoint> rows = new CopyOnWriteArrayList<>();

    @BeforeEach
    void setUp() {
        repository = mock(RunCheckpointRepository.class);
        client = mock(RuntimeCheckpointClient.class);
        operationService = mock(OperationService.class);
        chatRunRepository = mock(ChatRunRepository.class);
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
        when(operationService.findOperationIdByRunId(anyString())).thenReturn(null);

        service = new RunCheckpointService(repository, client, operationService, chatRunRepository,
                new ObjectMapper());
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
}
