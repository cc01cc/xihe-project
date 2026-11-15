package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.status.RequestQueue;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * task-134 A2: a run parked for transport recovery is skipped by reconciliation only while the
 * queue can still deliver it. Past the queue's TTL the parked entry is dead, and the run must be
 * taken over — with its own outcome ({@code QUEUE_EXPIRED}) rather than "unknown".
 */
class ChatRunReconciliationServiceTest {

    private static final String RUN_ID = "33333333-3333-3333-3333-333333333333";
    private static final String SESSION_ID = "44444444-4444-4444-4444-444444444444";
    private static final String USER_ID = "55555555-5555-5555-5555-555555555555";
    private static final String WORKSPACE_ID = "66666666-6666-6666-6666-666666666666";

    private ChatRunRepository chatRunRepository;
    private ChatActiveRunRegistry registry;
    private ChatRunTerminalService terminalService;
    private ChatRunTransportService transportAttempts;
    private ChatRunReconciliationService service;

    @BeforeEach
    void setUp() {
        chatRunRepository = mock(ChatRunRepository.class);
        registry = new ChatActiveRunRegistry();
        terminalService = mock(ChatRunTerminalService.class);
        transportAttempts = mock(ChatRunTransportService.class);
        when(transportAttempts.reconcileOrphanedTerminalAttempts()).thenReturn(0);
        when(terminalService.terminalize(any())).thenAnswer(invocation -> {
            ChatRunTerminalService.TerminalRequest request = invocation.getArgument(0);
            return new ChatRunTerminalService.TerminalResult(
                    ChatRunTerminalService.Outcome.COMMITTED, request.status());
        });
        ChatRun queued = new ChatRun(RUN_ID, SESSION_ID, USER_ID, WORKSPACE_ID,
                "idem-queued", "hash", "openai", "gpt-test", "none", "queued");
        when(chatRunRepository.findStaleActiveRuns(any(), any(), any())).thenReturn(List.of(queued));
        service = new ChatRunReconciliationService(chatRunRepository, registry, terminalService,
                transportAttempts, 600);
    }

    @Test
    void aRunParkedWithinTheQueueTtlIsStillLeftToTheDrain() {
        registry.claim(SESSION_ID, RUN_ID);
        registry.markHandedOff(SESSION_ID, RUN_ID, Instant.now());

        service.reconcileStaleRuns();

        verify(terminalService, never()).terminalize(any());
    }

    @Test
    void aRunParkedPastTheQueueTtlIsTerminalizedAsQueueExpired() {
        registry.claim(SESSION_ID, RUN_ID);
        registry.markHandedOff(SESSION_ID, RUN_ID,
                Instant.now().minusSeconds(RequestQueue.TTL_SECONDS + 5));

        service.reconcileStaleRuns();

        verify(terminalService).terminalize(argThat(request ->
                RUN_ID.equals(request.runId())
                        && "ambiguous".equals(request.status())
                        && "QUEUE_EXPIRED".equals(request.errorCode())
                        // narrowed on purpose: a running run must never be swept up here
                        && List.of("queued").equals(request.expectedStatuses())
                        && request.source() == ChatRunTerminalService.TerminalSource.RECONCILIATION));
    }

    @Test
    void aRunThatIsNobodyInParticularsParkedRunIsStillReconciledTheOldWay() {
        // registered but never handed off: a genuinely active run, which must stay untouched
        registry.claim(SESSION_ID, RUN_ID);

        service.reconcileStaleRuns();

        verify(terminalService, never()).terminalize(any());
    }

    @Test
    void anUnregisteredRunIsReconciledAsBefore() {
        when(chatRunRepository.findStaleActiveRuns(any(), any(), any())).thenReturn(List.of(
                new ChatRun(UUID.randomUUID().toString(), SESSION_ID, USER_ID, WORKSPACE_ID,
                        "idem-stale", "hash", "openai", "gpt-test", "none", "queued")));

        service.reconcileStaleRuns();

        verify(terminalService).terminalize(argThat(request ->
                "CP_RECONCILED".equals(request.errorCode())));
    }
}
