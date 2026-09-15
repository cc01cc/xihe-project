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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0328 M2 W3: startup recovery must also seal "terminal but not sealed"
 * Run checkpoints (spec §3.1 补 seal) — once, without failing the recovery.
 */
class ChatRunRecoveryServiceTest {

    private static final String RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
    private static final String USER_ID = "55555555-5555-5555-5555-555555555555";
    private static final String SESSION_ID = "44444444-4444-4444-4444-444444444444";

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
        service = new ChatRunRecoveryService(chatRunRepository, approvalRepository, chatController,
                operationService, runCheckpointService);
    }

    private ChatRun runWithStatus(String status) {
        return new ChatRun(RUN_ID, SESSION_ID, USER_ID, WORKSPACE_ID,
                "idem-" + status, "hash", "openai", "gpt-test", "none", status);
    }

    @Test
    void recoveryMarksUnrecoverableRunAmbiguousAndSweepsCheckpoints() {
        ChatRun active = runWithStatus("running");
        when(chatRunRepository.findRecoverableRuns(any())).thenReturn(List.of(active));
        when(approvalRepository.findByRunIdAndStateIn(anyString(), any())).thenReturn(List.of());

        service.reconcileOnStartup();
        assertEquals("ambiguous", active.getStatus());
        assertEquals("CP_RESTARTED", active.getErrorCode());
        verify(chatRunRepository).save(active);

        service.sealRecoveredCheckpoints();
        verify(runCheckpointService).sealTerminalCheckpoints();
    }

    @Test
    void recoveryRestoresRunWithLiveApprovalWithoutSealing() {
        ChatRun active = runWithStatus("running");
        ChatApproval live = new ChatApproval("77777777-7777-7777-7777-777777777777", RUN_ID,
                SESSION_ID, USER_ID, WORKSPACE_ID, "write_file", "Execute write_file", "preview",
                "pending", Instant.now().plusSeconds(300), null, null);
        when(chatRunRepository.findRecoverableRuns(any())).thenReturn(List.of(active));
        when(approvalRepository.findByRunIdAndStateIn(anyString(), any())).thenReturn(List.of(live));

        service.reconcileOnStartup();

        assertEquals("awaiting_approval", active.getStatus());
        verify(chatController).restoreActiveRun(SESSION_ID, RUN_ID);
    }

    @Test
    void sealSweepFailureNeverFailsRecovery() {
        doThrow(new IllegalStateException("runtime down")).when(runCheckpointService).sealTerminalCheckpoints();

        service.sealRecoveredCheckpoints();

        verify(runCheckpointService).sealTerminalCheckpoints();
    }

    @Test
    void recoverySealsTerminalRunOnce() {
        RunCheckpointRepository checkpointRepository = mock(RunCheckpointRepository.class);
        RuntimeCheckpointClient client = mock(RuntimeCheckpointClient.class);
        List<RunCheckpoint> rows = new ArrayList<>();
        RunCheckpoint base = new RunCheckpoint();
        base.setId(java.util.UUID.randomUUID());
        base.setRunId(RUN_ID);
        base.setWorkspaceId(WORKSPACE_ID);
        base.setState(RunCheckpoint.STATE_BASE);
        base.setCreatedAt(Instant.now());
        base.setUpdatedAt(Instant.now());
        rows.add(base);
        when(checkpointRepository.findByState(RunCheckpoint.STATE_BASE)).thenAnswer(
                invocation -> rows.stream()
                        .filter(row -> RunCheckpoint.STATE_BASE.equals(row.getState()))
                        .toList());
        when(checkpointRepository.findByRunId(RUN_ID)).thenAnswer(invocation -> rows);
        when(checkpointRepository.markSealed(any(), any(), any(), anyBoolean(), anyBoolean(), any()))
                .thenAnswer(invocation -> {
                    rows.get(0).setState(RunCheckpoint.STATE_SEALED);
                    return 1;
                });
        when(client.seal(WORKSPACE_ID, RUN_ID)).thenReturn(new RuntimeCheckpointClient.SealResult(
                RuntimeCheckpointClient.Outcome.OK, "sealed", null, List.of(), false, false, null));

        ChatRun terminal = runWithStatus("ambiguous");
        when(chatRunRepository.findById(java.util.UUID.fromString(RUN_ID)))
                .thenReturn(Optional.of(terminal));
        RunCheckpointService realService = new RunCheckpointService(checkpointRepository, client,
                operationService, chatRunRepository, new ObjectMapper());
        ChatRunRecoveryService recovery = new ChatRunRecoveryService(chatRunRepository,
                approvalRepository, chatController, operationService, realService);
        try {
            recovery.sealRecoveredCheckpoints();
            recovery.sealRecoveredCheckpoints();

            verify(client, times(1)).seal(WORKSPACE_ID, RUN_ID);
            assertEquals(RunCheckpoint.STATE_SEALED, rows.get(0).getState());
        } finally {
            realService.shutdown();
        }
    }
}
