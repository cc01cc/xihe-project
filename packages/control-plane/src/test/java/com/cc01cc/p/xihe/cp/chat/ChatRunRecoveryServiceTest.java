package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.RunCheckpointRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient;
import com.cc01cc.p.xihe.cp.service.RunCheckpointService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0338: startup recovery must also compensate "terminal but not yet
 * captured" Run slices (single capture, no pre-dispatch row) — once, without
 * failing the recovery.
 */
class ChatRunRecoveryServiceTest {

    private static final String RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
    private static final String USER_ID = "55555555-5555-5555-5555-555555555555";
    private static final String SESSION_ID = "44444444-4444-4444-4444-444444444444";
    private static final String SLICE_REF = "refs/xihe/slices/1757980000000-ab12cd";

    private ChatRunRepository chatRunRepository;
    private ChatApprovalRepository approvalRepository;
    private ChatController chatController;
    private OperationService operationService;
    private RunCheckpointService runCheckpointService;
    private ChatRunRecoveryService service;

    @BeforeEach
    void setUp() {
        chatRunRepository = mock(ChatRunRepository.class);
        approvalRepository = mock(ChatApprovalRepository.class);
        chatController = mock(ChatController.class);
        operationService = mock(OperationService.class);
        runCheckpointService = mock(RunCheckpointService.class);
        when(chatRunRepository.findByStatus("cancelling")).thenReturn(List.of());
        when(chatRunRepository.findRecoverableRuns(any())).thenReturn(List.of());
        when(chatRunRepository.findTerminalRunsWithoutCheckpoint(any(), any())).thenReturn(List.of());
        service = new ChatRunRecoveryService(chatRunRepository, approvalRepository, chatController,
                operationService, runCheckpointService);
    }

    private ChatRun runWithStatus(String status) {
        return new ChatRun(RUN_ID, SESSION_ID, USER_ID, WORKSPACE_ID,
                "idem-" + status, "hash", "openai", "gpt-test", "none", status);
    }

    @Test
    void recoveryMarksUnrecoverableRunAmbiguousAndCapturesCheckpoints() {
        ChatRun active = runWithStatus("running");
        when(chatRunRepository.findRecoverableRuns(any())).thenReturn(List.of(active));
        when(approvalRepository.findByRunIdAndStateIn(anyString(), any())).thenReturn(List.of());

        service.reconcileOnStartup();
        assertEquals("ambiguous", active.getStatus());
        assertEquals("CP_RESTARTED", active.getErrorCode());
        verify(chatRunRepository).save(active);

        service.captureRecoveredRuns();
        verify(runCheckpointService).captureTerminalRuns();
    }

    @Test
    void recoveryRestoresRunWithLiveApprovalWithoutCapturing() {
        ChatRun active = runWithStatus("running");
        ChatApproval live = new ChatApproval(
                "77777777-7777-7777-7777-777777777777",
                RUN_ID,
                SESSION_ID,
                USER_ID,
                WORKSPACE_ID,
                "write_file",
                "Execute write_file",
                "preview",
                "pending",
                Instant.now().plusSeconds(300));
        when(chatRunRepository.findRecoverableRuns(any())).thenReturn(List.of(active));
        when(approvalRepository.findByRunIdAndStateIn(anyString(), any())).thenReturn(List.of(live));

        service.reconcileOnStartup();

        assertEquals("awaiting_approval", active.getStatus());
        verify(chatController).restoreActiveRun(SESSION_ID, RUN_ID);
    }

    @Test
    void captureSweepFailureNeverFailsRecovery() {
        doThrow(new IllegalStateException("runtime down")).when(runCheckpointService).captureTerminalRuns();

        service.captureRecoveredRuns();

        verify(runCheckpointService).captureTerminalRuns();
    }

    @Test
    void recoveryCapturesTerminalRunOnce() {
        RunCheckpointRepository checkpointRepository = mock(RunCheckpointRepository.class);
        RuntimeCheckpointClient client = mock(RuntimeCheckpointClient.class);
        List<RunCheckpoint> rows = new ArrayList<>();
        when(checkpointRepository.findBySourceRunIdAndWorkspaceId(anyString(), anyString()))
                .thenAnswer(invocation -> rows.stream()
                        .filter(row -> row.getSourceRunId().equals(invocation.getArgument(0))
                                && row.getWorkspaceId().equals(invocation.getArgument(1)))
                        .findFirst());
        when(checkpointRepository.save(any(RunCheckpoint.class))).thenAnswer(invocation -> {
            RunCheckpoint row = invocation.getArgument(0);
            rows.add(row);
            return row;
        });
        when(client.capture(WORKSPACE_ID, RUN_ID, USER_ID, "run-terminal-capture:" + RUN_ID, true))
                .thenReturn(new RuntimeCheckpointClient.CaptureResult(RuntimeCheckpointClient.Outcome.OK,
                        RUN_ID, false, SLICE_REF, "ab12cd", "2026-09-15T00:00:00Z",
                        RunCheckpoint.STATE_CAPTURED,
                        List.of(new RuntimeCheckpointClient.ChangedFile("M", "src/a.txt")),
                        List.of(), null, null));

        ChatRun terminal = runWithStatus("ambiguous");
        when(chatRunRepository.findTerminalRunsWithoutCheckpoint(any(), any()))
                .thenReturn(List.of(terminal));
        when(chatRunRepository.findById(UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(terminal));
        RunCheckpointService realService = new RunCheckpointService(checkpointRepository, client,
                operationService, chatRunRepository, new ObjectMapper(),
                mock(com.cc01cc.p.xihe.cp.chat.SseEmitterManager.class));
        ChatRunRecoveryService recovery = new ChatRunRecoveryService(chatRunRepository,
                approvalRepository, chatController, operationService, realService);
        try {
            recovery.captureRecoveredRuns();
            recovery.captureRecoveredRuns();

            verify(client, times(1)).capture(WORKSPACE_ID, RUN_ID, USER_ID,
                    "run-terminal-capture:" + RUN_ID, true);
            assertEquals(RunCheckpoint.STATE_CAPTURED, rows.get(0).getState());
            assertEquals(SLICE_REF, rows.get(0).getSliceRef());
        } finally {
            realService.shutdown();
        }
    }
}
