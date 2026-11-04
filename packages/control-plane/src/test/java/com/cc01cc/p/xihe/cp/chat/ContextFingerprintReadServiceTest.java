package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0666 M1: read envelope + two-run diff, pure logic (no DB). Covers design D4/D5: absence is
 * named, cross-session diffs are rejected, and every diff class has a case.
 */
class ContextFingerprintReadServiceTest {

    private static final String SESSION = "session-1";

    private static ObjectNode document(Object history) {
        Map<String, Object> layers = new LinkedHashMap<>();
        layers.put("template", Map.of("templateId", "tpl-1", "version", 2));
        layers.put("skills", List.of("skill-a"));
        layers.put("history", history);
        layers.put("memory", List.of("mem"));
        layers.put("userInput", Map.of("content", "c"));
        layers.put("attachments", List.of());
        layers.put("config", Map.of("instructions", "i"));
        return ContextFingerprintCalculator.calculate(layers, Map.of("content", "c"), 1);
    }

    private static ContextFingerprintReadService.View view(String runId, ObjectNode stored) {
        return ContextFingerprintReadService.view(runId, SESSION, stored,
                ContextFingerprintReadService.DispatchState.DISPATCHED);
    }

    @Test
    void storedDocumentIsAvailableAndNullColumnIsNamed() {
        ObjectNode stored = document(List.of("a"));
        ContextFingerprintReadService.View present = view("run-1", stored);
        assertTrue(present.available());
        assertNull(present.reason());
        assertEquals(stored, present.fingerprint());

        ContextFingerprintReadService.View noDispatch = ContextFingerprintReadService.view(
                "run-2", SESSION, null, ContextFingerprintReadService.DispatchState.NOT_DISPATCHED);
        assertFalse(noDispatch.available());
        assertEquals("not_dispatched", noDispatch.reason());

        ContextFingerprintReadService.View legacy = ContextFingerprintReadService.view(
                "run-3", SESSION, null, ContextFingerprintReadService.DispatchState.DISPATCHED);
        assertFalse(legacy.available());
        assertEquals("pre_plan", legacy.reason());

        ContextFingerprintReadService.View unknown = ContextFingerprintReadService.view(
                "run-4", SESSION, null, ContextFingerprintReadService.DispatchState.UNKNOWN);
        assertEquals("pre_plan", unknown.reason());
    }

    @Test
    void unchangedWhenBothDocumentsAreIdentical() {
        ObjectNode same = document(List.of("a", "b"));
        ObjectNode diff = ContextFingerprintReadService.diff(view("run-1", same), view("run-2", same));
        assertEquals("comparable", diff.path("status").asText());
        assertEquals("unchanged", diff.path("layers").path("history").path("status").asText());
        assertEquals("unchanged", diff.path("outbound").path("status").asText());
        assertEquals(0, diff.path("summary").path("changedLayers").size());
        assertEquals(1, diff.path("summary").path("unavailableLayers").size(),
                "tools is the only layer CP cannot see; it stays unavailable, never 'unchanged'");
        assertEquals("tools", diff.path("summary").path("unavailableLayers").get(0).asText());
    }

    @Test
    void changedSameShapeWhenContentChangesButCountAndBytesStayEqual() {
        ObjectNode left = document(List.of("aaaa"));
        ObjectNode right = document(List.of("bbbb"));
        assertEquals(
                left.path("layers").path("history").path("bytes").asInt(),
                right.path("layers").path("history").path("bytes").asInt());
        ObjectNode diff = ContextFingerprintReadService.diff(view("run-1", left), view("run-2", right));
        ObjectNode history = (ObjectNode) diff.path("layers").path("history");
        assertEquals("changed(sameShape)", history.path("status").asText());
        assertEquals(0, history.path("countDelta").asInt());
        assertEquals(0, history.path("bytesDelta").asInt());
        assertEquals("history", diff.path("summary").path("changedLayers").get(0).asText());
    }

    @Test
    void grewAndShrankUseTheRightDirection() {
        ObjectNode small = document(List.of("a"));
        ObjectNode big = document(List.of("a", "b", "c"));
        String grew = ContextFingerprintReadService.diff(view("run-1", small), view("run-2", big))
                .path("layers").path("history").path("status").asText();
        String shrank = ContextFingerprintReadService.diff(view("run-1", big), view("run-2", small))
                .path("layers").path("history").path("status").asText();
        assertEquals("changed(grew)", grew);
        assertEquals("changed(shrank)", shrank);
    }

    @Test
    void addedAndRemovedWhenALayerExistsOnlyOnOneSide() {
        ObjectNode full = document(List.of("a"));
        ObjectNode withoutHistory = (ObjectNode) full.deepCopy();
        ((ObjectNode) withoutHistory.path("layers")).remove("history");
        ObjectNode added = ContextFingerprintReadService.diff(
                view("run-1", withoutHistory), view("run-2", full));
        assertEquals("added", added.path("layers").path("history").path("status").asText());
        ObjectNode removed = ContextFingerprintReadService.diff(
                view("run-1", full), view("run-2", withoutHistory));
        assertEquals("removed", removed.path("layers").path("history").path("status").asText());
    }

    @Test
    void unavailableIsNeverDowngradedToUnchanged() {
        ObjectNode ok = document(List.of("a"));
        ObjectNode disabled = ContextFingerprintCalculator.disabled();
        ObjectNode diff = ContextFingerprintReadService.diff(view("run-1", disabled), view("run-2", ok));
        assertEquals("unavailable", diff.path("status").asText());
        assertEquals("against", diff.path("sides").get(0).path("side").asText());
        assertEquals("disabled", diff.path("sides").get(0).path("status").asText());

        ContextFingerprintReadService.View legacy = ContextFingerprintReadService.view(
                "run-3", SESSION, null, ContextFingerprintReadService.DispatchState.DISPATCHED);
        ObjectNode legacyDiff = ContextFingerprintReadService.diff(legacy, view("run-4", ok));
        assertEquals("unavailable", legacyDiff.path("status").asText());
        assertEquals("pre_plan", legacyDiff.path("sides").get(0).path("reason").asText());
    }

    @Test
    void layerLevelUnavailableKeepsItsReason() {
        Map<String, Object> layers = new LinkedHashMap<>();
        layers.put("history", List.of("a"));
        layers.put("tools", new ContextFingerprintCalculator.Unavailable("agent_side"));
        ObjectNode doc = ContextFingerprintCalculator.calculate(layers, Map.of("content", "c"), 1);
        ObjectNode diff = ContextFingerprintReadService.diff(view("run-1", doc), view("run-2", doc));
        ObjectNode tools = (ObjectNode) diff.path("layers").path("tools");
        assertEquals("unavailable", tools.path("status").asText());
        assertEquals("agent_side", tools.path("againstReason").asText());
        assertTrue(diff.path("summary").path("unavailableLayers").toString().contains("\"tools\""),
                "tools must be listed as unavailable, not folded into unchanged");
    }

    @Test
    void crossSessionDiffIsRejected() {
        ContextFingerprintReadService.View left = ContextFingerprintReadService.view(
                "run-1", "session-1", document(List.of("a")), ContextFingerprintReadService.DispatchState.DISPATCHED);
        ContextFingerprintReadService.View right = ContextFingerprintReadService.view(
                "run-2", "session-2", document(List.of("a")), ContextFingerprintReadService.DispatchState.DISPATCHED);
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> ContextFingerprintReadService.diff(left, right));
        assertTrue(error.getMessage().contains("DIFF_SESSION_MISMATCH"));
    }

    @Test
    void dispatchAttemptIsReportedOnBothSides() {
        ObjectNode doc = document(List.of("a"));
        ObjectNode diff = ContextFingerprintReadService.diff(view("run-1", doc), view("run-2", doc));
        assertEquals(1, diff.path("dispatchAttempt").path("against").asInt());
        assertEquals(1, diff.path("dispatchAttempt").path("current").asInt());
    }

    @Test
    void blankRunIdOrSessionIdIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> ContextFingerprintReadService.view(
                " ", SESSION, null, ContextFingerprintReadService.DispatchState.UNKNOWN));
        assertThrows(IllegalArgumentException.class, () -> ContextFingerprintReadService.view(
                "run-1", "", null, ContextFingerprintReadService.DispatchState.UNKNOWN));
    }
}
