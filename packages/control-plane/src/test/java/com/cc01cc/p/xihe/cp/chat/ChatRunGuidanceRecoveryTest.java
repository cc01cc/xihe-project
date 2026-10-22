package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.event.ApplicationReadyEvent;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** PLAN-0543 T2.2: a failed startup sweep is logged, never fatal to CP startup. */
class ChatRunGuidanceRecoveryTest {

    private final ChatRunGuidanceService service = mock(ChatRunGuidanceService.class);
    private final ChatRunGuidanceRecovery recovery = new ChatRunGuidanceRecovery(service);

    @Test
    void successfulSweepDelegatesOnce() {
        when(service.recoverPendingOnTerminalRuns()).thenReturn(2);

        recovery.recoverGuidanceOnStartup(mock(ApplicationReadyEvent.class));

        verify(service).recoverPendingOnTerminalRuns();
    }

    @Test
    void failedSweepIsSwallowedSoStartupIsNotBlocked() {
        when(service.recoverPendingOnTerminalRuns())
                .thenThrow(new IllegalStateException("sweep failed"));

        assertDoesNotThrow(() ->
                recovery.recoverGuidanceOnStartup(mock(ApplicationReadyEvent.class)));

        verify(service).recoverPendingOnTerminalRuns();
    }
}
