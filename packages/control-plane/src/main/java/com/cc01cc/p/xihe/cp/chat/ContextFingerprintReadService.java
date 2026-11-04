package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * PLAN-0666 M1a/M1b: pure read-side projection of a stored context fingerprint plus the two-run
 * diff (design D4/D5). No repository, no HTTP, no clock — the controller wiring (M1b) is a thin
 * adapter over these two methods.
 *
 * <p>Why an envelope instead of returning the stored document directly: a missing column has to
 * stay explicit. Legacy rows (written before PLAN-0666) have {@code NULL} and no amount of
 * back-filling can reconstruct them, so the read side reports
 * {@code available=false + reason="pre_plan"}; a run that never dispatched reports
 * {@code reason="not_dispatched"}.
 *
 * <p><b>Two-level model (Lead 2026-11-05, spec §可观测性; assertion):</b> a <b>stored</b> document
 * is exactly one of {@code ok/disabled/error} — {@code not_dispatched} is never stored. Absence is
 * carried only by this envelope ({@code available=false + reason}), and <b>"no document" must never
 * be mapped to {@code disabled} or {@code error}</b>: a legacy run is neither switched off nor
 * broken. If someone later wants "submitted but not dispatched" to be a stored state, that needs
 * its own decision — do not add a fifth status silently.
 */
public final class ContextFingerprintReadService {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    /** Whether the run is known to have reached dispatch; the read side needs it to name the absence. */
    public enum DispatchState {
        DISPATCHED,
        NOT_DISPATCHED,
        UNKNOWN
    }

    private ContextFingerprintReadService() {}

    /**
     * Read-side envelope for one run.
     *
     * @param runId       run identity (echoed for the diff response)
     * @param sessionId   used to reject cross-session diffs (different sessions are not comparable)
     * @param available   true when a stored document exists (any of the four statuses)
     * @param reason      why no document exists; non-null iff {@code available=false}
     * @param fingerprint the stored document, verbatim; null iff {@code available=false}
     */
    public record View(String runId, String sessionId, boolean available, String reason, JsonNode fingerprint) {}

    /** Build the read-side envelope from the stored column value and the run's dispatch state. */
    public static View view(String runId, String sessionId, JsonNode stored, DispatchState state) {
        requireText(runId, "runId");
        requireText(sessionId, "sessionId");
        if (stored != null) {
            return new View(runId, sessionId, true, null, stored);
        }
        String reason = state == DispatchState.NOT_DISPATCHED
                ? ContextFingerprintCalculator.REASON_NOT_DISPATCHED
                : ContextFingerprintCalculator.REASON_PRE_PLAN;
        return new View(runId, sessionId, false, reason, null);
    }

    /** Two runs from different sessions have no comparable layer semantics (design D4 → HTTP 409). */
    public static void requireSameSession(View left, View right) {
        if (!left.sessionId().equals(right.sessionId())) {
            throw new IllegalArgumentException("DIFF_SESSION_MISMATCH: fingerprints from different sessions");
        }
    }

    /**
     * Diff {@code against} (left, older baseline) with {@code current} (right).
     *
     * <p>Layer verdicts: {@code unchanged}, {@code changed(sameShape|grew|shrank)}, {@code added},
     * {@code removed}, {@code unavailable}. {@code unavailable} is never downgraded to
     * {@code unchanged} — that would turn "not collected" into "nothing changed".
     */
    public static ObjectNode diff(View against, View current) {
        requireSameSession(against, current);
        ObjectNode result = NODES.objectNode();
        result.put("againstRunId", against.runId());
        result.put("runId", current.runId());
        if (!against.available() || !current.available()) {
            result.put("status", "unavailable");
            ArrayNode sides = result.putArray("sides");
            if (!against.available()) {
                sides.addObject().put("side", "against").put("reason", against.reason());
            }
            if (!current.available()) {
                sides.addObject().put("side", "current").put("reason", current.reason());
            }
            return result;
        }
        JsonNode left = against.fingerprint();
        JsonNode right = current.fingerprint();
        List<String> blockedSides = blockedSides(left, right);
        if (!blockedSides.isEmpty()) {
            result.put("status", "unavailable");
            ArrayNode sides = result.putArray("sides");
            for (String side : blockedSides) {
                JsonNode document = "against".equals(side) ? left : right;
                sides.addObject().put("side", side).put("status", document.path("status").asText("unknown"));
            }
            return result;
        }
        result.put("status", "comparable");
        ObjectNode layers = result.putObject("layers");
        Set<String> changed = new LinkedHashSet<>();
        Set<String> unavailable = new LinkedHashSet<>();
        for (String layer : ContextFingerprintCalculator.LAYER_ORDER) {
            JsonNode layerDiff = diffLayer(layer, left.path("layers").get(layer), right.path("layers").get(layer));
            layers.set(layer, layerDiff);
            String status = layerDiff.path("status").asText();
            if ("changed(sameShape)".equals(status) || "changed(grew)".equals(status)
                    || "changed(shrank)".equals(status)) {
                changed.add(layer);
            } else if ("unavailable".equals(status)) {
                unavailable.add(layer);
            }
        }
        result.set("outbound", diffOutbound(left.get("outbound"), right.get("outbound")));
        ObjectNode attempt = result.putObject("dispatchAttempt");
        attempt.put("against", left.path("dispatchAttempt").asInt(1));
        attempt.put("current", right.path("dispatchAttempt").asInt(1));
        ObjectNode summary = result.putObject("summary");
        putStrings(summary.putArray("changedLayers"), changed);
        putStrings(summary.putArray("unavailableLayers"), unavailable);
        return result;
    }

    private static List<String> blockedSides(JsonNode left, JsonNode right) {
        List<String> sides = new ArrayList<>();
        if (!isComparable(left)) {
            sides.add("against");
        }
        if (!isComparable(right)) {
            sides.add("current");
        }
        return sides;
    }

    private static boolean isComparable(JsonNode document) {
        return document != null
                && ContextFingerprintCalculator.STATUS_OK.equals(document.path("status").asText());
    }

    private static ObjectNode diffLayer(String layer, JsonNode left, JsonNode right) {
        ObjectNode out = NODES.objectNode();
        out.put("layer", layer);
        if (left == null && right == null) {
            out.put("status", "absent");
            return out;
        }
        if (left == null) {
            out.put("status", "added");
            return out;
        }
        if (right == null) {
            out.put("status", "removed");
            return out;
        }
        if (left.has("unavailable") || right.has("unavailable")) {
            out.put("status", "unavailable");
            if (left.has("unavailable")) {
                out.put("againstReason", left.path("unavailable").asText());
            }
            if (right.has("unavailable")) {
                out.put("currentReason", right.path("unavailable").asText());
            }
            return out;
        }
        String leftHash = left.path("hash").asText();
        String rightHash = right.path("hash").asText();
        if (leftHash.equals(rightHash)) {
            out.put("status", "unchanged");
            return out;
        }
        int leftCount = left.path("count").asInt();
        int rightCount = right.path("count").asInt();
        int leftBytes = left.path("bytes").asInt();
        int rightBytes = right.path("bytes").asInt();
        String status = leftCount == rightCount && leftBytes == rightBytes
                ? "changed(sameShape)"
                : "changed(" + (rightBytes > leftBytes ? "grew" : "shrank") + ")";
        out.put("status", status);
        out.put("countDelta", rightCount - leftCount);
        out.put("bytesDelta", rightBytes - leftBytes);
        return out;
    }

    private static ObjectNode diffOutbound(JsonNode left, JsonNode right) {
        ObjectNode out = NODES.objectNode();
        if (left == null || right == null) {
            out.put("status", left == null && right == null ? "absent" : (left == null ? "added" : "removed"));
            return out;
        }
        if (left.has("unavailable") || right.has("unavailable")) {
            out.put("status", "unavailable");
            return out;
        }
        if (left.path("hash").asText().equals(right.path("hash").asText())) {
            out.put("status", "unchanged");
            return out;
        }
        out.put("status", "changed");
        out.put("bytesDelta", right.path("bytes").asInt() - left.path("bytes").asInt());
        return out;
    }

    private static void putStrings(ArrayNode array, Set<String> values) {
        for (String value : values) {
            array.add(value);
        }
    }

    private static void requireText(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(label + " must not be blank");
        }
    }
}
