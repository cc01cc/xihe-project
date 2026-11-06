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
 * PLAN-0679 T2.3: pure read-side projection of a stored provider-request fingerprint plus the
 * two-run diff (design D5/D6, 4.4). No repository, no HTTP, no clock — the controller is a thin
 * adapter over these methods (same split as PLAN-0666 {@code ContextFingerprintReadService}).
 *
 * <p><b>Two-level model (design D5, 0666 D5 precedent):</b> a stored document is a six-layer
 * diagnostic or the Agent's fail-open error marker; "no row at all" is <b>never</b> stored and is
 * carried only by the envelope as {@code available=false, reason=not_captured}. It must not be
 * re-encoded as {@code disabled} or {@code error} — a run whose diagnostics were dropped is neither
 * switched off nor broken.</p>
 *
 * <p>A layer verdict is never silently downgraded: an unavailable side reports
 * {@code unavailable} + {@code side} + {@code reason}, never {@code unchanged} (design 4.4).</p>
 */
public final class ProviderRequestFingerprintReadService {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    /** Envelope reason for "the event never made it into the table" (design D5). */
    public static final String REASON_NOT_CAPTURED = "not_captured";

    /** The six printed layers; {@code outbound} is the calibration layer and is diffed separately. */
    public static final List<String> LAYER_ORDER =
            List.of("systemTemplate", "history", "userInput", "toolSchema", "config");

    private ProviderRequestFingerprintReadService() {}

    /**
     * One side of a read or a diff.
     *
     * @param runId     run identity (echoed on the wire)
     * @param sessionId used to reject cross-session diffs (different sessions are not comparable)
     * @param available true when a row exists (any stored shape, including the error marker)
     * @param reason    why no row exists; non-null iff {@code available=false}
     * @param document  the stored six-layer document (or error marker), verbatim; null iff absent
     * @param metadata  the row's request metadata (never prompt content); null iff absent
     */
    public record View(String runId, String sessionId, boolean available, String reason,
                       JsonNode document, Metadata metadata) {}

    /**
     * Request metadata persisted next to the document (design 4.3): api type, resolved model,
     * rendered-body counts and source summary. Diagnostic metadata only — no prompt content.
     */
    public record Metadata(String apiTypeId, Integer apiTypeVersion, String model, int messageCount,
                           int toolCount, long bytesTotal, JsonNode roleHistogram,
                           JsonNode systemSources, int dispatchAttempt, int providerStep) {}

    /** Envelope for a run with a stored row. */
    public static View captured(String runId, String sessionId, JsonNode document, Metadata metadata) {
        requireText(runId, "runId");
        requireText(sessionId, "sessionId");
        if (document == null) {
            throw new IllegalArgumentException("document must not be null when available");
        }
        return new View(runId, sessionId, true, null, document, metadata);
    }

    /** Envelope for a run without a row: absence is named, never re-encoded (two-level model). */
    public static View absent(String runId, String sessionId) {
        requireText(runId, "runId");
        requireText(sessionId, "sessionId");
        return new View(runId, sessionId, false, REASON_NOT_CAPTURED, null, null);
    }

    /** Single-run response body: {@code {runId, available, reason?, fingerprint?, request?}}. */
    public static ObjectNode envelope(View view) {
        ObjectNode node = NODES.objectNode();
        node.put("runId", view.runId());
        node.put("available", view.available());
        if (view.reason() != null) {
            node.put("reason", view.reason());
        }
        if (view.document() != null) {
            node.set("fingerprint", view.document());
        }
        if (view.metadata() != null) {
            node.set("request", metadataNode(view.metadata()));
        }
        return node;
    }

    /** Two runs from different sessions have no comparable layer semantics (design D6 → HTTP 409). */
    public static void requireSameSession(View against, View current) {
        if (!against.sessionId().equals(current.sessionId())) {
            throw new IllegalArgumentException("DIFF_SESSION_MISMATCH: fingerprints from different sessions");
        }
    }

    /**
     * Diff {@code against} (left, older baseline) with {@code current} (right).
     *
     * <p>Layer verdicts (design 4.4): {@code unchanged}, {@code changed(sameShape|grew|shrank)},
     * {@code added}, {@code removed}, {@code unavailable}. Both runs' metadata travel with the diff
     * so a reader can name the two requests without a second round trip.</p>
     */
    public static ObjectNode diff(View against, View current) {
        requireSameSession(against, current);
        ObjectNode result = NODES.objectNode();
        result.put("againstRunId", against.runId());
        result.put("runId", current.runId());
        if (against.metadata() != null) {
            result.set("against", metadataNode(against.metadata()));
        }
        if (current.metadata() != null) {
            result.set("current", metadataNode(current.metadata()));
        }
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
        JsonNode left = against.document();
        JsonNode right = current.document();
        List<String> blockedSides = blockedSides(left, right);
        if (!blockedSides.isEmpty()) {
            result.put("status", "unavailable");
            ArrayNode sides = result.putArray("sides");
            for (String side : blockedSides) {
                JsonNode document = "against".equals(side) ? left : right;
                ObjectNode entry = sides.addObject();
                entry.put("side", side);
                entry.put("status", document.path("status").asText("unknown"));
                if (document.hasNonNull("reasonCode")) {
                    entry.put("reasonCode", document.path("reasonCode").asText());
                }
            }
            return result;
        }
        result.put("status", "comparable");
        ObjectNode layers = result.putObject("layers");
        Set<String> changed = new LinkedHashSet<>();
        Set<String> unavailable = new LinkedHashSet<>();
        for (String layer : LAYER_ORDER) {
            JsonNode layerDiff = diffLayer(layer, left.path("layers").get(layer), right.path("layers").get(layer));
            layers.set(layer, layerDiff);
            String status = layerDiff.path("status").asText();
            if (status.startsWith("changed(")) {
                changed.add(layer);
            } else if ("unavailable".equals(status)) {
                unavailable.add(layer);
            }
        }
        result.set("outbound", diffLayer("outbound", left.get("outbound"), right.get("outbound")));
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

    /** A comparable document is a real six-layer diagnostic, not the fail-open error marker. */
    private static boolean isComparable(JsonNode document) {
        return document != null
                && "sha256".equals(document.path("algo").asText(""))
                && document.path("layers").isObject();
    }

    /**
     * Layer verdict. {@code count}/{@code bytes} are optional per layer (design 4.2: only
     * {@code history}, {@code toolSchema} and {@code outbound} carry a count), so a layer that has
     * no count compares on bytes alone and never invents a delta.
     */
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
        if (left.path("hash").asText().equals(right.path("hash").asText())) {
            out.put("status", "unchanged");
            return out;
        }
        JsonNode leftCount = left.get("count");
        JsonNode rightCount = right.get("count");
        boolean hasCount = leftCount != null && rightCount != null;
        int leftBytes = left.path("bytes").asInt();
        int rightBytes = right.path("bytes").asInt();
        int leftCountValue = leftCount == null ? 0 : leftCount.asInt();
        int rightCountValue = rightCount == null ? 0 : rightCount.asInt();
        boolean sameShape = (!hasCount || leftCountValue == rightCountValue) && leftBytes == rightBytes;
        out.put("status", sameShape
                ? "changed(sameShape)"
                : "changed(" + (rightBytes > leftBytes ? "grew" : "shrank") + ")");
        if (hasCount) {
            out.put("countDelta", rightCountValue - leftCountValue);
        }
        out.put("bytesDelta", rightBytes - leftBytes);
        return out;
    }

    /** Metadata is stored as-is; the shape is the persisted column set (never prompt content). */
    public static ObjectNode metadataNode(Metadata metadata) {
        ObjectNode node = NODES.objectNode();
        node.put("apiTypeId", metadata.apiTypeId());
        if (metadata.apiTypeVersion() != null) {
            node.put("apiTypeVersion", metadata.apiTypeVersion());
        }
        node.put("model", metadata.model());
        node.put("messageCount", metadata.messageCount());
        node.put("toolCount", metadata.toolCount());
        node.put("bytesTotal", metadata.bytesTotal());
        node.put("dispatchAttempt", metadata.dispatchAttempt());
        node.put("providerStep", metadata.providerStep());
        node.set("roleHistogram", metadata.roleHistogram() == null ? NODES.objectNode() : metadata.roleHistogram());
        node.set("systemSources", metadata.systemSources() == null ? NODES.objectNode() : metadata.systemSources());
        return node;
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
