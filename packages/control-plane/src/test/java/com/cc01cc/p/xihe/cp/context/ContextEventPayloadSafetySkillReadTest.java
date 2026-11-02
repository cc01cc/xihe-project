package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.context.service.ContextEventPayloadSafety;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M2b (#6): a {@code skill_read} body must not reach durable history.
 *
 * <p>Why this is asserted at the sanitizer and not only end to end: the body is <b>workspace-private
 * content</b> and can be hundreds of kilobytes, while the event table is a long-lived asset. The
 * current Agent presentation already withholds the result, so the honest CP-side statement is a
 * <b>ceiling</b>: whatever shape arrives — the tool's own {@code structuredContent} object, a plain
 * string, a future schema — durable history may keep the hash, the length and a bounded preview, and
 * nothing else.</p>
 *
 * <p>The fixture is built so the assertion cannot pass by luck: a distinctive head marker sits inside
 * the allowed preview and a distinctive tail marker sits far beyond it, so "the preview survived" and
 * "the body did not" are two independent checks.</p>
 */
class ContextEventPayloadSafetySkillReadTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final String HEAD_MARKER = "SKILL-BODY-HEAD-MARKER ";
    private static final String TAIL_MARKER = " SKILL-BODY-TAIL-MARKER";
    private static final String BODY = HEAD_MARKER + "x".repeat(6_000) + TAIL_MARKER;

    private static JsonNode toolResult(JsonNode result) {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("schemaVersion", 1);
        payload.put("toolName", "skill_read");
        payload.put("toolCallId", "call-1");
        payload.set("result", result);
        return ContextEventPayloadSafety.sanitize("tool.result", payload, MAPPER);
    }

    @Test
    void structuredContentBodyIsReducedToHashLengthAndPreview() throws Exception {
        ObjectNode result = MAPPER.createObjectNode();
        result.put("skillId", "11111111-1111-1111-1111-111111111111");
        result.put("body", BODY);

        JsonNode safe = toolResult(result);
        JsonNode metadata = safe.path("result");

        // The body itself: gone past the preview bound.
        assertFalse(safe.toString().contains(TAIL_MARKER),
                "the tail of the body must not be persisted");
        assertFalse(safe.toString().contains("x".repeat(300)),
                "no long run of body text may survive the 256-character bound");
        // What is allowed to survive.
        assertTrue(metadata.path("preview").asText().startsWith(HEAD_MARKER));
        assertEquals(ContextEventPayloadSafety.SKILL_BODY_PREVIEW_CHARS,
                metadata.path("preview").asText().codePointCount(0,
                        metadata.path("preview").asText().length()));
        assertEquals(sha256Hex(BODY), metadata.path("contentHash").asText());
        assertEquals(BODY.getBytes(StandardCharsets.UTF_8).length, metadata.path("sizeBytes").asInt());
        assertTrue(metadata.path("truncated").asBoolean());
        // The call identity still belongs to the record — this is a redaction, not a deletion.
        assertEquals("call-1", safe.path("toolCallId").asText());
        assertEquals("skill_read", safe.path("toolName").asText());
    }

    @Test
    void plainStringBodyIsBoundedTheSameWay() throws Exception {
        JsonNode safe = toolResult(MAPPER.getNodeFactory().textNode(BODY));

        assertFalse(safe.toString().contains(TAIL_MARKER));
        assertEquals(sha256Hex(BODY), safe.path("result").path("contentHash").asText());
        assertTrue(safe.path("result").path("truncated").asBoolean());
    }

    @Test
    void toolRoleMessageKeepsOnlyTheBoundedDigest() throws Exception {
        ObjectNode message = MAPPER.createObjectNode();
        message.put("role", "tool");
        message.put("tool_name", "skill_read");
        message.put("content", BODY);
        ObjectNode payload = MAPPER.createObjectNode();
        payload.set("message", message);

        JsonNode safe = ContextEventPayloadSafety.sanitize("assistant.responded", payload, MAPPER);
        String content = safe.path("message").path("content").asText();

        assertFalse(content.contains(TAIL_MARKER));
        assertTrue(content.startsWith("[skill_read] body withheld from durable history"));
        assertTrue(content.contains(sha256Hex(BODY)));
        assertTrue(content.contains("sizeBytes=" + BODY.getBytes(StandardCharsets.UTF_8).length));
    }

    @Test
    void aShortBodyFitsEntirelyInThePreviewAndIsNotMarkedTruncated() {
        String shortBody = "small skill body";
        JsonNode safe = toolResult(MAPPER.getNodeFactory().textNode(shortBody));

        assertEquals(shortBody, safe.path("result").path("preview").asText());
        assertFalse(safe.path("result").path("truncated").asBoolean());
    }

    @Test
    void everyOtherToolStillGetsTheExistingPlaceholder() throws Exception {
        // Regression guard: the new branch must not widen any other tool's durable result.
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("toolName", "read_file");
        payload.put("toolCallId", "call-2");
        payload.put("result", "file contents that must not persist");

        JsonNode safe = ContextEventPayloadSafety.sanitize("tool.result", payload, MAPPER);

        assertEquals(ContextEventPayloadSafety.UNSAFE_TOOL_RESULT_PLACEHOLDER,
                safe.path("result").asText());
    }

    private static String sha256Hex(String value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
    }
}
