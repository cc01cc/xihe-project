package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Iterator;
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
 *
 * <p>PLAN-0670 M2c/B: the renderer now consumes an {@link Iterator} (streaming export). The
 * regression contract is "byte-for-byte identical output"; {@link #differentialGolden} keeps a copy
 * of the <b>pre-streaming algorithm</b> and compares it with the shipped renderer over representative
 * fixtures (empty / blanks / huge rows / over-cap / document-cap). If someone changes the format,
 * that test fails with a full-string diff instead of letting a silent drift reach the UI download.
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

    @Test
    void documentCapMarkerIsPreserved() {
        List<Map<String, Object>> messages = new ArrayList<>();
        for (int index = 0; index < 200; index++) {
            messages.add(message("tool", "2026-11-02T10:00:00Z",
                    "y".repeat(SessionExportService.MAX_MESSAGE_CHARS)));
        }
        SessionExportService.ExportResult result = service.render(SESSION, messages);
        assertTrue(result.contentTruncated(), "hitting the document cap must be disclosed");
        assertTrue(result.markdown().contains(
                        "\n…[document truncated at " + SessionExportService.MAX_DOCUMENT_CHARS + " characters]\n"),
                "document-cap marker text must be byte-identical to the pre-streaming implementation");
        // The cap is on the document, not on the message count: ~100 rows of 20k chars fill 2M chars.
        assertTrue(result.messages() >= 99 && result.messages() <= 101,
                "document cap must stop after the row that crosses 2M chars, got " + result.messages());
    }

    @Test
    void streamingIteratorProducesTheSameBytesAsTheListPath() {
        List<Map<String, Object>> messages = List.of(
                message("user", "2026-11-02T10:00:00Z", "alpha"),
                message("assistant", "2026-11-02T10:00:01Z", "   "),
                message("tool", "2026-11-02T10:00:02Z", "beta"));
        SessionExportService.ExportResult listResult = service.render(SESSION, messages);
        SessionExportService.ExportResult iteratorResult = service.render(SESSION, messages.iterator());
        assertEquals(listResult.markdown(), iteratorResult.markdown());
        assertEquals(listResult.messages(), iteratorResult.messages());
        assertEquals(listResult.messagesTruncated(), iteratorResult.messagesTruncated());
        assertEquals(listResult.contentTruncated(), iteratorResult.contentTruncated());
    }

    @Test
    void differentialGoldenAgainstThePreStreamingImplementation() {
        assertEquals(legacyRender(SESSION, List.of()),
                service.render(SESSION, List.of()).markdown(), "empty session");

        assertEquals(legacyRender(SESSION, List.of(
                        message("user", "2026-11-02T10:00:00Z", "hello"),
                        message("assistant", "2026-11-02T10:00:01Z", "world"))),
                service.render(SESSION, List.of(
                        message("user", "2026-11-02T10:00:00Z", "hello"),
                        message("assistant", "2026-11-02T10:00:01Z", "world"))).markdown(),
                "plain conversation");

        List<Map<String, Object>> blanks = List.of(
                message("user", "2026-11-02T10:00:00Z", "keep"),
                message("assistant", "2026-11-02T10:00:01Z", "  "),
                message("tool", "2026-11-02T10:00:02Z", ""));
        assertEquals(legacyRender(SESSION, blanks), service.render(SESSION, blanks).markdown(),
                "blank rows are skipped identically");

        List<Map<String, Object>> huge = List.of(
                message("user", "2026-11-02T10:00:00Z",
                        "z".repeat(SessionExportService.MAX_MESSAGE_CHARS + 700)));
        assertEquals(legacyRender(SESSION, huge), service.render(SESSION, huge).markdown(),
                "per-message truncation marker is identical");

        List<Map<String, Object>> overCap = new ArrayList<>();
        for (int index = 0; index < SessionExportService.MAX_MESSAGES + 3; index++) {
            overCap.add(message("user", "2026-11-02T10:00:00Z", "m" + index));
        }
        assertEquals(legacyRender(SESSION, overCap), service.render(SESSION, overCap).markdown(),
                "over-cap truncation and header flag are identical");

        List<Map<String, Object>> documentCap = new ArrayList<>();
        for (int index = 0; index < 200; index++) {
            documentCap.add(message("tool", "2026-11-02T10:00:00Z",
                    "q".repeat(SessionExportService.MAX_MESSAGE_CHARS)));
        }
        assertEquals(legacyRender(SESSION, documentCap),
                service.render(SESSION, documentCap).markdown(),
                "document-cap truncation marker is identical");
    }

    /**
     * Golden oracle: a verbatim copy of the pre-streaming implementation (develop {@code 4debbe76}),
     * deliberately kept in the test so a format drift fails as a string diff. Do not "fix" this copy
     * when changing the renderer — update it only together with a decision that changes the format.
     */
    private static String legacyRender(String sessionId, List<Map<String, Object>> messages) {
        List<Map<String, Object>> visible = messages == null ? List.of() : messages;
        boolean messagesTruncated = visible.size() > SessionExportService.MAX_MESSAGES;
        int limit = Math.min(visible.size(), SessionExportService.MAX_MESSAGES);
        boolean contentTruncated = false;
        StringBuilder body = new StringBuilder();
        int exported = 0;
        for (int index = 0; index < limit; index++) {
            Map<String, Object> message = visible.get(index);
            String role = scalar(message, "role", "unknown");
            String createdAt = scalar(message, "createdAt", scalar(message, "created_at", ""));
            String content = scalar(message, "content", "");
            if (content.isBlank()) {
                continue;
            }
            String rendered = content.length() > SessionExportService.MAX_MESSAGE_CHARS
                    ? content.substring(0, SessionExportService.MAX_MESSAGE_CHARS) + "\n…[truncated]"
                    : content;
            if (rendered.length() > SessionExportService.MAX_MESSAGE_CHARS) {
                contentTruncated = true;
            }
            exported += 1;
            body.append("\n## ").append(exported).append(". ").append(role);
            if (!createdAt.isBlank()) {
                body.append(" · ").append(createdAt);
            }
            body.append("\n\n").append(rendered).append('\n');
            if (body.length() >= SessionExportService.MAX_DOCUMENT_CHARS) {
                contentTruncated = true;
                body.append("\n…[document truncated at ")
                        .append(SessionExportService.MAX_DOCUMENT_CHARS).append(" characters]\n");
                break;
            }
        }
        String header = "# Session export\n\n"
                + "- session: " + sessionId + "\n"
                + "- messages: " + exported + "\n"
                + "- messagesTruncated: " + messagesTruncated + "\n"
                + "- contentTruncated: " + contentTruncated + "\n"
                + "- generated by: xihe control plane\n";
        return header + body;
    }

    private static String scalar(Map<String, Object> message, String key, String fallback) {
        if (message == null) {
            return fallback;
        }
        Object value = message.get(key);
        if (value == null) {
            return fallback;
        }
        String text = String.valueOf(value);
        return text.isBlank() ? fallback : text;
    }
}
