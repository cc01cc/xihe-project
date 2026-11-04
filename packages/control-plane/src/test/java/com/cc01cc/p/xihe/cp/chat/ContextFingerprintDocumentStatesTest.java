package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0666 D5: the stored document is a closed set of four states and every "nothing here" case
 * carries an explicit reason. The rule this test enforces: <b>a reader can never mistake "off" for
 * "failed", or either for "empty context"</b> (BL-268 lesson: a missing parameter must be explicit).
 */
class ContextFingerprintDocumentStatesTest {

    private static final Map<String, Object> LAYERS = Map.of("history", List.of("%s"));

    @Test
    void okStateCarriesEnabledTrueStatusAlgoAndData() {
        ObjectNode document = ContextFingerprintCalculator.calculate(LAYERS, Map.of("content", "c"), 1);
        assertEquals(true, document.path("enabled").asBoolean());
        assertEquals("ok", document.path("status").asText());
        assertEquals("sha256", document.path("algo").asText());
        assertEquals(1, document.path("dispatchAttempt").asInt());
        assertTrue(document.path("layers").has("history"));
        assertTrue(document.path("outbound").has("hash"));
    }

    @Test
    void disabledStateIsEnabledFalseWithAClosedReasonAndNoData() {
        ObjectNode document = ContextFingerprintCalculator.disabled();
        assertEquals(false, document.path("enabled").asBoolean());
        assertEquals("disabled", document.path("status").asText());
        assertEquals("workspace_disabled", document.path("reason").asText());
        assertFalse(document.has("layers"), "a disabled workspace has no layer data to show");
        assertFalse(document.has("outbound"));
        assertThrows(IllegalArgumentException.class, () -> ContextFingerprintCalculator.disabled(" "));
    }

    @Test
    void errorStateStaysEnabledTrueSoItCannotBeConfusedWithDisabled() {
        ObjectNode document = ContextFingerprintCalculator.error("HASH_FAILED");
        assertEquals(true, document.path("enabled").asBoolean());
        assertEquals("error", document.path("status").asText());
        assertEquals("HASH_FAILED", document.path("reasonCode").asText());
        assertFalse(document.path("enabled").asBoolean() == false,
                "fail-open keeps enabled=true; otherwise it would read as 'workspace off'");
        assertNotEquals(ContextFingerprintCalculator.disabled().path("status").asText(),
                document.path("status").asText());
        assertThrows(IllegalArgumentException.class, () -> ContextFingerprintCalculator.error(""));
    }

    @Test
    void notDispatchedIsReadSideOnlyAndNeverAStoredStatus() {
        ObjectNode synthetic = ContextFingerprintCalculator.notDispatched();
        assertEquals("not_dispatched", synthetic.path("status").asText());
        // Two-level model (Lead 2026-11-05): stored documents are exactly ok/disabled/error.
        java.util.Set<String> storable = java.util.Set.of(
                ContextFingerprintCalculator.STATUS_OK,
                ContextFingerprintCalculator.STATUS_DISABLED,
                ContextFingerprintCalculator.STATUS_ERROR);
        assertFalse(storable.contains(ContextFingerprintCalculator.STATUS_NOT_DISPATCHED),
                "not_dispatched must never be a stored status; absence is a read-side envelope reason");
        assertEquals("ok", ContextFingerprintCalculator.calculate(Map.of(), null, 1).path("status").asText());
        assertEquals("disabled", ContextFingerprintCalculator.disabled().path("status").asText());
        assertEquals("error", ContextFingerprintCalculator.error("X").path("status").asText());
    }

    @Test
    void theFourStateNamesAreDistinctAndOnlyDisabledTurnsEnabledOff() {
        assertEquals(4, java.util.Set.of(
                ContextFingerprintCalculator.STATUS_OK,
                ContextFingerprintCalculator.STATUS_DISABLED,
                ContextFingerprintCalculator.STATUS_NOT_DISPATCHED,
                ContextFingerprintCalculator.STATUS_ERROR).size());
        assertFalse(ContextFingerprintCalculator.disabled().path("enabled").asBoolean(),
                "disabled must be the only state with enabled=false");
        assertEquals(true, ContextFingerprintCalculator.error("X").path("enabled").asBoolean());
        assertEquals(true, ContextFingerprintCalculator.notDispatched().path("enabled").asBoolean());
    }
}
