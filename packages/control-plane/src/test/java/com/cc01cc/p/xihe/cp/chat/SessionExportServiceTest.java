package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0635 M3: {@code /export} must produce a real Markdown artifact from the existing message
 * read surface — not "send a fixed English prompt to the model" (the M1 stub behaviour).
 *
 * <p>Assertions are on <b>document content</b>: header facts, ordinal + role + timestamp, and the
 * message bodies, because the defect being replaced was exactly "no artifact, only a message".
 */
class SessionExportServiceTest {
    private static final String SESSION = "8f1c2b3d-0000-4000-8000-000000000001";

    private final SessionExportService service = new SessionExportService();

    private static Map<String, Object> message(String role, String createdAt, String content) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("role", role);
        dto.put("createdAt", createdAt);
        dto.put("content", content);
        return dto;
    }

    @Test
    void rendersHeaderOrdinalRoleTimestampAndBody() {
        SessionExportService.ExportResult result = service.render(SESSION, List.of(
                message("user", "2026-11-02T10:00:00Z", "帮我重构一下 NestedAgentsMdResolver"),
                message("assistant", "2026-11-02T10:00:03Z", "好的，先看调用链。"),
                message("tool", "2026-11-02T10:00:04Z", "{\"ok\":true}")));

        String markdown = result.markdown();
        assertTrue(markdown.startsWith("# Session export\n"), "document must start with a title");
        assertTrue(markdown.contains("- session: " + SESSION), "header must carry the session id");
        assertTrue(markdown.contains("- messages: 3"), "header must carry the exported message count");
        assertTrue(markdown.contains("## 1. user · 2026-11-02T10:00:00Z"), "ordinal + role + timestamp");
        assertTrue(markdown.contains("## 2. assistant · 2026-11-02T10:00:03Z"));
        assertTrue(markdown.contains("帮我重构一下 NestedAgentsMdResolver"), "body text must be exported");
        assertTrue(markdown.contains("{\"ok\":true}"));
        assertEquals(3, result.messages());
        assertFalse(result.messagesTruncated());
        assertFalse(result.contentTruncated());
    }

    @Test
    void skipsRowsWithoutReadableContent() {
        SessionExportService.ExportResult result = service.render(SESSION, List.of(
                message("user", "2026-11-02T10:00:00Z", "real content"),
                message("assistant", "2026-11-02T10:00:01Z", "   "),
                message("tool", "2026-11-02T10:00:02Z", "")));
        assertEquals(1, result.messages(), "empty rows must not inflate the export");
        assertFalse(result.markdown().contains("## 2."));
    }

    @Test
    void truncatesOversizedSessionsAndDisclosesIt() {
        List<Map<String, Object>> messages = new ArrayList<>();
        for (int index = 0; index < SessionExportService.MAX_MESSAGES + 5; index++) {
            messages.add(message("user", "2026-11-02T10:00:00Z", "line " + index));
        }
        SessionExportService.ExportResult result = service.render(SESSION, messages);
        assertEquals(SessionExportService.MAX_MESSAGES, result.messages());
        assertTrue(result.messagesTruncated());
        assertTrue(result.markdown().contains("- messagesTruncated: true"), "truncation must be disclosed");
    }

    @Test
    void truncatesOneHugeMessageWithAnExplicitMarker() {
        String huge = "x".repeat(SessionExportService.MAX_MESSAGE_CHARS + 500);
        SessionExportService.ExportResult result = service.render(SESSION, List.of(
                message("user", "2026-11-02T10:00:00Z", huge)));
        assertTrue(result.contentTruncated());
        assertTrue(result.markdown().contains("[truncated]"));
        assertFalse(result.markdown().contains("x".repeat(SessionExportService.MAX_MESSAGE_CHARS + 100)));
    }

    @Test
    void emptySessionStillProducesAValidDocument() {
        SessionExportService.ExportResult result = service.render(SESSION, List.of());
        assertEquals(0, result.messages());
        assertTrue(result.markdown().contains("- messages: 0"));
        assertFalse(result.contentTruncated());
    }
}
