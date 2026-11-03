package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

/**
 * PLAN-0645 D45-01: the per-Session run cap is a config-driven resource valve with a strict
 * fallback ladder (default 2, valid 1–4) and a Session-locked, count-based admission gate.
 */
class SessionRunConcurrencyGateTest {

    private static final String SESSION_ID = "session-1";

    private final ChatRunRepository runs = Mockito.mock(ChatRunRepository.class);
    private final ConfigService config = Mockito.mock(ConfigService.class);

    private SessionRunConcurrencyGate gate() {
        return new SessionRunConcurrencyGate(runs, config);
    }

    private void configuredCap(String value) {
        when(config.resolve(eq(SessionRunConcurrencyGate.CONFIG_DOMAIN),
                eq(SessionRunConcurrencyGate.CONFIG_KEY), any(), any())).thenReturn(value);
    }

    @Test
    void defaultsToTwoWhenTheKeyIsUnset() {
        configuredCap(null);
        assertEquals(2, gate().maxConcurrentRuns());
    }

    @Test
    void acceptsEveryValueInsideTheSchemaRange() {
        for (String value : List.of("1", "2", "3", "4")) {
            configuredCap(value);
            assertEquals(Integer.parseInt(value), gate().maxConcurrentRuns(), "value " + value);
        }
    }

    @Test
    void invalidOrOutOfRangeValuesFallBackToTheDefault() {
        for (String value : List.of("0", "5", "-1", "abc", "  ")) {
            configuredCap(value);
            assertEquals(2, gate().maxConcurrentRuns(), "value " + value);
        }
    }

    @Test
    void unreadableConfigFallsBackToTheDefault() {
        when(config.resolve(eq(SessionRunConcurrencyGate.CONFIG_DOMAIN),
                eq(SessionRunConcurrencyGate.CONFIG_KEY), any(), any()))
                .thenThrow(new IllegalStateException("config store unavailable"));
        assertEquals(2, gate().maxConcurrentRuns());
    }

    @Test
    void requireSlotRejectsWhenTheSessionIsAtItsCap() {
        configuredCap("2");
        when(runs.countBySessionIdAndStatusIn(eq(SESSION_ID), any())).thenReturn(2L);

        CpApiException error = assertThrows(CpApiException.class, () -> gate().requireSlot(SESSION_ID));

        assertEquals("CHAT_IN_PROGRESS", error.getCode());
        assertTrue(error.getMessage().contains("2"), "the refusal names the cap: " + error.getMessage());
        assertFalse(gate().hasSlot(SESSION_ID));
    }

    @Test
    void requireSlotPassesBelowTheCap() {
        configuredCap("2");
        when(runs.countBySessionIdAndStatusIn(eq(SESSION_ID), any())).thenReturn(1L);

        assertDoesNotThrow(() -> gate().requireSlot(SESSION_ID));
        assertTrue(gate().hasSlot(SESSION_ID));
    }

    @Test
    void capOneRejectsTheSecondInFlightRun() {
        configuredCap("1");
        when(runs.countBySessionIdAndStatusIn(eq(SESSION_ID), any())).thenReturn(1L);

        CpApiException error = assertThrows(CpApiException.class, () -> gate().requireSlot(SESSION_ID));

        assertEquals("CHAT_IN_PROGRESS", error.getCode());
    }
}
