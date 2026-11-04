package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0666 M1a: deterministic per-layer context fingerprint.
 *
 * <p>Only a <b>pure function</b> lives here: no Spring, no repository, no clock. The dispatch path
 * (M1b) supplies the layer payloads and persists the returned document into
 * {@code chat_runs.context_fingerprint}.
 *
 * <p>Determinism is the whole contract (design D6, the head acceptance item): the same input must
 * produce the same bytes in any JVM, in any order the caller happened to build its maps in. That is
 * why this class <b>does not delegate serialization to a configured {@code ObjectMapper}</b> — key
 * order, number formatting and escaping all become explicit rules below:
 *
 * <ul>
 *   <li>object keys are sorted by their UTF-8 bytes (unsigned);</li>
 *   <li>array order is preserved — the caller is responsible for semantic order
 *       (history by {@code sequence}, tools by name, attachments by {@code fileId});</li>
 *   <li>numbers are normalized ({@code 1}, {@code 1.0} and {@code 1.00} are the same value;
 *       {@code -0.0} becomes {@code 0}; NaN/Infinity are rejected);</li>
 *   <li>strings are escaped with the fixed rule below (short escapes for control characters,
 *       {@code \\u00xx} otherwise) — no platform or Jackson-version variance;</li>
 *   <li>a missing key and an explicit {@code null} are <b>different</b> inputs (and different hashes).</li>
 * </ul>
 *
 * <p>Layers are a fixed, ordered set. Every layer is present in the output: one that the caller
 * cannot see yet is emitted as {@code {"unavailable": "<reason>"}} instead of being omitted — a
 * silently missing layer would read as "unchanged" in a diff (design §2.1/D5; PLAN-0666 D1).
 */
public final class ContextFingerprintCalculator {

    /** Hash algorithm recorded in the document; changing it is a schema change, not a constant tweak. */
    public static final String ALGO = "sha256";

    /** Fixed layer order (design §2.1); the document follows it, so diffs stay comparable. */
    public static final List<String> LAYER_ORDER = List.of(
            "template", "skills", "history", "memory", "userInput", "attachments", "config", "tools");

    /** Reason used when the caller has no payload for a CP-visible layer at all. */
    public static final String UNAVAILABLE_NOT_PROVIDED = "not_provided";

    /**
     * Stored-document states, a closed set (design D5, Lead 2026-11-05): a reader must be able to
     * tell "workspace switched it off" from "collection failed" from "the run never dispatched".
     * The absence of a stored document (legacy rows) is a <b>read-side</b> reason, never a fifth
     * status — see {@link ContextFingerprintReadService}.
     */
    public static final String STATUS_OK = "ok";

    public static final String STATUS_DISABLED = "disabled";

    public static final String STATUS_NOT_DISPATCHED = "not_dispatched";

    public static final String STATUS_ERROR = "error";

    /** Closed reason set used when a workspace switched fingerprinting off. */
    public static final String REASON_WORKSPACE_DISABLED = "workspace_disabled";

    /** Read-side reason: the run never reached dispatch, so no document was ever written. */
    public static final String REASON_NOT_DISPATCHED = "not_dispatched";

    /** Read-side reason: the row predates PLAN-0666 (or its write failed); indistinguishable by design. */
    public static final String REASON_PRE_PLAN = "pre_plan";

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private ContextFingerprintCalculator() {}

    /** Marks a layer the caller intentionally reports as not observable from this side. */
    public record Unavailable(String reason) {
        public Unavailable {
            if (reason == null || reason.isBlank()) {
                throw new IllegalArgumentException("unavailable layer needs a non-blank reason");
            }
        }
    }

    /** Hash + size summary of one layer. {@code count} is the payload's element count. */
    public record LayerFingerprint(String hash, int count, int bytes) {}

    /**
     * Build the fingerprint document.
     *
     * @param layerPayloads payload per layer key ({@link #LAYER_ORDER}); {@code null} values are
     *                      reported as {@link #UNAVAILABLE_NOT_PROVIDED}, {@link Unavailable}
     *                      values carry an explicit reason (e.g. {@code agent_side} for tools)
     * @param outbound      the full outbound dispatch document (or {@code null} to mark unavailable)
     * @param dispatchAttempt 1-based dispatch counter; v1 only ever passes 1 (design §2.2)
     */
    public static ObjectNode calculate(Map<String, Object> layerPayloads, Object outbound, int dispatchAttempt) {
        if (dispatchAttempt < 1) {
            throw new IllegalArgumentException("dispatchAttempt must be >= 1");
        }
        if (layerPayloads == null) {
            throw new IllegalArgumentException("layerPayloads must not be null; pass an empty map");
        }
        for (String key : layerPayloads.keySet()) {
            if (!LAYER_ORDER.contains(key)) {
                throw new IllegalArgumentException("unknown fingerprint layer: " + key);
            }
        }
        ObjectNode document = NODES.objectNode();
        document.put("enabled", true);
        document.put("status", STATUS_OK);
        document.put("algo", ALGO);
        document.put("dispatchAttempt", dispatchAttempt);
        ObjectNode layers = document.putObject("layers");
        for (String layer : LAYER_ORDER) {
            layers.set(layer, layerNode(layerPayloads.get(layer)));
        }
        if (outbound == null) {
            document.set("outbound", NODES.objectNode().put("unavailable", UNAVAILABLE_NOT_PROVIDED));
        } else {
            ObjectNode out = document.putObject("outbound");
            out.put("hash", hash(outbound));
            out.put("bytes", canonicalBytes(outbound).length);
        }
        return document;
    }

    /**
     * Document stored when the workspace switched fingerprinting off (D5). Deliberately carries
     * {@code enabled:false} + a reason, so a reader can never confuse "off" with "empty context".
     */
    public static ObjectNode disabled() {
        return disabled(REASON_WORKSPACE_DISABLED);
    }

    /** Same as {@link #disabled()}, with an explicit (closed-set) reason. */
    public static ObjectNode disabled(String reason) {
        requireText(reason, "disabled reason");
        ObjectNode document = NODES.objectNode();
        document.put("enabled", false);
        document.put("status", STATUS_DISABLED);
        document.put("reason", reason);
        return document;
    }

    /**
     * Synthetic document for "the run never reached dispatch". The dispatch path cannot write it
     * (there is no document to store), so only the read side emits it — still explicitly, never as
     * a missing column.
     */
    public static ObjectNode notDispatched() {
        ObjectNode document = NODES.objectNode();
        document.put("enabled", true);
        document.put("status", STATUS_NOT_DISPATCHED);
        document.put("reason", REASON_NOT_DISPATCHED);
        return document;
    }

    /**
     * Fail-open document (D5): hashing failed, the run was <b>not</b> affected. {@code enabled}
     * stays true so "collection failed" is distinguishable from "workspace disabled".
     */
    public static ObjectNode error(String reasonCode) {
        requireText(reasonCode, "error reasonCode");
        ObjectNode document = NODES.objectNode();
        document.put("enabled", true);
        document.put("status", STATUS_ERROR);
        document.put("reasonCode", reasonCode);
        return document;
    }

    private static void requireText(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(label + " must not be blank");
        }
    }
    private static ObjectNode layerNode(Object payload) {
        ObjectNode node = NODES.objectNode();
        if (payload == null) {
            return node.put("unavailable", UNAVAILABLE_NOT_PROVIDED);
        }
        if (payload instanceof Unavailable unavailable) {
            return node.put("unavailable", unavailable.reason());
        }
        byte[] canonical = canonicalBytes(payload);
        node.put("hash", sha256Hex(canonical));
        node.put("count", countOf(payload));
        node.put("bytes", canonical.length);
        return node;
    }

    /** Element count of a payload: array size, object property count, or 1 for a scalar. */
    public static int countOf(Object payload) {
        if (payload == null) {
            return 0;
        }
        if (payload instanceof JsonNode node) {
            if (node.isArray()) {
                return node.size();
            }
            if (node.isObject()) {
                return node.size();
            }
            return 1;
        }
        if (payload instanceof Map<?, ?> map) {
            return map.size();
        }
        if (payload instanceof Iterable<?> iterable) {
            int count = 0;
            for (Object ignored : iterable) {
                count += 1;
            }
            return count;
        }
        if (payload instanceof Object[] array) {
            return array.length;
        }
        return 1;
    }

    /** SHA-256 hex of the canonical JSON of {@code value} (the one hash used by every layer). */
    public static String hash(Object value) {
        return sha256Hex(canonicalBytes(value));
    }

    /** Canonical UTF-8 JSON bytes of {@code value}; see the class-level rules. */
    public static byte[] canonicalBytes(Object value) {
        return canonicalJson(value).getBytes(StandardCharsets.UTF_8);
    }

    /** Canonical JSON text of {@code value}; see the class-level rules. */
    public static String canonicalJson(Object value) {
        StringBuilder out = new StringBuilder(256);
        writeCanonical(value, out);
        return out.toString();
    }

    private static void writeCanonical(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
            return;
        }
        if (value instanceof JsonNode node) {
            writeNode(node, out);
            return;
        }
        if (value instanceof String string) {
            writeString(string, out);
            return;
        }
        if (value instanceof Boolean bool) {
            out.append(bool ? "true" : "false");
            return;
        }
        if (value instanceof Number number) {
            writeNumber(number, out);
            return;
        }
        if (value instanceof Character character) {
            writeString(character.toString(), out);
            return;
        }
        if (value instanceof Enum<?> enumValue) {
            writeString(enumValue.name(), out);
            return;
        }
        if (value instanceof Map<?, ?> map) {
            writeObject(map, out);
            return;
        }
        if (value instanceof Iterable<?> iterable) {
            writeArray(iterable, out);
            return;
        }
        if (value instanceof Object[] array) {
            writeArray(List.of(array), out);
            return;
        }
        throw new IllegalArgumentException("unsupported fingerprint value type: " + value.getClass().getName());
    }

    private static void writeNode(JsonNode node, StringBuilder out) {
        if (node.isNull()) {
            out.append("null");
        } else if (node.isObject()) {
            Map<String, JsonNode> fields = new LinkedHashMap<>();
            node.fields().forEachRemaining(entry -> fields.put(entry.getKey(), entry.getValue()));
            writeObject(fields, out);
        } else if (node.isArray()) {
            out.append('[');
            for (int index = 0; index < node.size(); index += 1) {
                if (index > 0) {
                    out.append(',');
                }
                writeNode(node.get(index), out);
            }
            out.append(']');
        } else if (node.isTextual()) {
            writeString(node.textValue(), out);
        } else if (node.isBoolean()) {
            out.append(node.booleanValue() ? "true" : "false");
        } else if (node.isNumber()) {
            writeJsonNumber(node, out);
        } else if (node.isBinary()) {
            writeString(node.asText(), out);
        } else {
            throw new IllegalArgumentException("unsupported JSON node type: " + node.getNodeType());
        }
    }

    private static void writeObject(Map<?, ?> map, StringBuilder out) {
        List<Map.Entry<?, ?>> entries = new ArrayList<>(map.entrySet());
        for (Map.Entry<?, ?> entry : entries) {
            if (!(entry.getKey() instanceof String)) {
                throw new IllegalArgumentException(
                        "fingerprint object keys must be strings, got: " + entry.getKey().getClass().getName());
            }
        }
        entries.sort((left, right) -> compareUtf8((String) left.getKey(), (String) right.getKey()));
        out.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> entry : entries) {
            if (!first) {
                out.append(',');
            }
            first = false;
            writeString((String) entry.getKey(), out);
            out.append(':');
            writeCanonical(entry.getValue(), out);
        }
        out.append('}');
    }

    private static void writeArray(Iterable<?> iterable, StringBuilder out) {
        out.append('[');
        boolean first = true;
        for (Object element : iterable) {
            if (!first) {
                out.append(',');
            }
            first = false;
            writeCanonical(element, out);
        }
        out.append(']');
    }

    private static void writeJsonNumber(JsonNode node, StringBuilder out) {
        if (node.isIntegralNumber()) {
            out.append(node.bigIntegerValue().toString());
            return;
        }
        BigDecimal value = node.decimalValue();
        if (!Double.isFinite(value.doubleValue())) {
            throw new IllegalArgumentException("fingerprint numbers must be finite: " + node);
        }
        writeBigDecimal(value, out);
    }

    private static void writeNumber(Number number, StringBuilder out) {
        if (number instanceof Integer || number instanceof Long || number instanceof Short
                || number instanceof Byte) {
            out.append(number.longValue());
            return;
        }
        if (number instanceof java.math.BigInteger bigInteger) {
            out.append(bigInteger.toString());
            return;
        }
        BigDecimal value;
        if (number instanceof BigDecimal decimal) {
            value = decimal;
        } else if (number instanceof java.math.BigInteger) {
            out.append(number);
            return;
        } else {
            double asDouble = number.doubleValue();
            if (!Double.isFinite(asDouble)) {
                throw new IllegalArgumentException("fingerprint numbers must be finite: " + number);
            }
            value = BigDecimal.valueOf(asDouble);
        }
        writeBigDecimal(value, out);
    }

    private static void writeBigDecimal(BigDecimal value, StringBuilder out) {
        if (value.signum() == 0) {
            out.append('0');
            return;
        }
        out.append(value.stripTrailingZeros().toPlainString());
    }

    /** Fixed string escaping: only the characters JSON requires, with a stable spelling. */
    private static void writeString(String value, StringBuilder out) {
        out.append('"');
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (character < 0x20) {
                        out.append(String.format("\\u%04x", (int) character));
                    } else {
                        out.append(character);
                    }
                }
            }
        }
        out.append('"');
    }

    private static int compareUtf8(String left, String right) {
        byte[] leftBytes = left.getBytes(StandardCharsets.UTF_8);
        byte[] rightBytes = right.getBytes(StandardCharsets.UTF_8);
        int limit = Math.min(leftBytes.length, rightBytes.length);
        for (int index = 0; index < limit; index += 1) {
            int compared = Integer.compare(leftBytes[index] & 0xFF, rightBytes[index] & 0xFF);
            if (compared != 0) {
                return compared;
            }
        }
        return Integer.compare(leftBytes.length, rightBytes.length);
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance(ALGO).digest(bytes));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is required by the JDK", exception);
        }
    }
}
