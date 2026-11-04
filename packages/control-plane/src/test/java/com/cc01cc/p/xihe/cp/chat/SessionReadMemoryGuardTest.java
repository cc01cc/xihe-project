package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0670 M2b (T2b.4): the heap watermark is <b>off by default</b>, emits only at/over its
 * threshold when enabled, and its payload never carries message content.
 */
class SessionReadMemoryGuardTest {

    @Test
    void disabledGuardNeverEmitsEvenFarAboveTheThreshold() {
        SessionReadMemoryGuard guard = new SessionReadMemoryGuard(false, 1_024);
        assertFalse(guard.isEnabled());
        assertFalse(guard.shouldEmit(1_024L * 1_024 * 1_024), "disabled must stay silent");
    }

    @Test
    void enabledGuardEmitsAtOrAboveTheThresholdOnly() {
        SessionReadMemoryGuard guard = new SessionReadMemoryGuard(true, 1_024);
        assertTrue(guard.isEnabled());
        assertFalse(guard.shouldEmit(1_023), "below the threshold stays silent");
        assertTrue(guard.shouldEmit(1_024), "at the threshold emits");
    }

    @Test
    void payloadCarriesTheDiagnosticFieldsAndNoContent() {
        SessionReadMemoryGuard guard = new SessionReadMemoryGuard(true, 8_388_608);
        String line = guard.describe("messages.list", 20_001, 92L * 1024 * 1024);
        assertTrue(line.contains("event=session_read_memory_guard"));
        assertTrue(line.contains("endpoint=messages.list"));
        assertTrue(line.contains("messages=20001"));
        assertTrue(line.contains("estBytes=96468992"));
        assertTrue(line.contains("thresholdBytes=8388608"));
        assertFalse(line.contains("content"), "the diagnostic line must never mention content");
    }

    @Test
    void nonPositiveThresholdFallsBackToTheDefault() {
        SessionReadMemoryGuard guard = new SessionReadMemoryGuard(true, 0);
        assertTrue(guard.describe("export", 1, 0).contains("thresholdBytes="
                + SessionReadMemoryGuard.DEFAULT_THRESHOLD_BYTES));
    }

    @Test
    void estimateCountsUtf16ContentPlusPerRowOverhead() {
        java.util.List<java.util.Map<String, Object>> messages = java.util.List.of(
                java.util.Map.of("content", "abcd"),
                java.util.Map.of("content", ""));
        assertEquals(2L * 256 + 2L * 4, MessageReadService.estimateResponseBytes(messages));
    }
}
