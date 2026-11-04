package com.cc01cc.p.xihe.cp.chat;

import org.springframework.stereotype.Service;

import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0635 M3: render a session as Markdown for the {@code /export} command.
 *
 * <p>Why CP-side: the M1 stub sent a fixed English prompt to the model — i.e. it asked the LLM to
 * pretend to export, produced no artifact and burned a run. Export is a read of data we already
 * own, so it is generated here from the existing message read surface and never touches the Agent
 * or a provider.
 *
 * <p>Bounded by design: a session can be huge, so the renderer takes an already windowed view and
 * additionally caps the number of messages, each message's content, and the total document. Every
 * cap is disclosed in the document header (a silently truncated export is worse than none).
 *
 * <p>PLAN-0670 M2c/B: the renderer now consumes an {@link Iterator} instead of a materialised
 * {@code List}, so the export controller can stream the conversation through the read surface
 * (JDBC cursor, fetch size 200) without holding the session in heap. The document body is still
 * capped at {@link #MAX_DOCUMENT_CHARS}, which bounds the renderer's own footprint to ~4 MB even
 * for the worst allowed session. The output is **byte-for-byte identical** to the pre-streaming
 * implementation for every input (see {@code SessionExportServiceTest}'s differential golden test).
 */
@Service
public class SessionExportService {

    /**
     * Hard ceiling on exported messages (the read surface returns the visible branch path).
     *
     * <p>BL-279: this constant is the **single source** of the export cap — {@code
     * SessionExportController} prechecks the session-wide message count against it and refuses with
     * {@code 413 EXPORT_TOO_LARGE} before reading any message, so a huge session is never
     * materialised just to be truncated here. Do not duplicate the number.
     *
     * <p>PLAN-0670 M2c/B (deferred): the count is session-wide (all branches/visibility) while the
     * cap's motivation is memory. Streaming makes the memory driver disappear; raising/removing the
     * precheck is a separate semantic decision and deliberately **not** part of this change.
     */
    static final int MAX_MESSAGES = 2_000;
    /** Per-message content ceiling in characters (long tool results / pastes). */
    static final int MAX_MESSAGE_CHARS = 20_000;
    /** Total document ceiling in characters. */
    static final int MAX_DOCUMENT_CHARS = 2_000_000;

    private static final String TRUNCATION_MARKER = "\n…[truncated]";

    /** One rendered export: the Markdown body plus what was cut (for the header and the tests). */
    public record ExportResult(String markdown, int messages, boolean messagesTruncated,
                               boolean contentTruncated) { }

    /**
     * List-based entry point, kept for callers/tests that already hold the visible messages.
     * Behaviour is identical to {@link #render(String, Iterator)}.
     */
    public ExportResult render(String sessionId, List<Map<String, Object>> messages) {
        return render(sessionId, (messages == null ? List.<Map<String, Object>>of() : messages).iterator());
    }

    /**
     * @param messages message DTOs from the read surface, consumed lazily; only scalars are used
     *                 ({@code role}, {@code content}, {@code createdAt}) so no Jackson node ever
     *                 reaches the wire. The iterator is fully consumed (or abandoned at the
     *                 {@link #MAX_MESSAGES} cap) before this method returns — the HTTP response is
     *                 streamed only after the transaction that produced it has ended.
     */
    public ExportResult render(String sessionId, Iterator<Map<String, Object>> messages) {
        Iterator<Map<String, Object>> source =
                messages == null ? List.<Map<String, Object>>of().iterator() : messages;
        boolean messagesTruncated = false;
        boolean contentTruncated = false;
        StringBuilder body = new StringBuilder();
        int exported = 0;
        int considered = 0;
        while (source.hasNext()) {
            Map<String, Object> message = source.next();
            considered += 1;
            if (considered > MAX_MESSAGES) {
                messagesTruncated = true;
                break;
            }
            String role = scalar(message, "role", "unknown");
            String createdAt = scalar(message, "createdAt", scalar(message, "created_at", ""));
            String content = scalar(message, "content", "");
            if (content.isBlank()) {
                // Tool-call-only or empty rows carry no readable content; skipping keeps the
                // document honest instead of emitting empty sections.
                continue;
            }
            String rendered = content.length() > MAX_MESSAGE_CHARS
                    ? content.substring(0, MAX_MESSAGE_CHARS) + TRUNCATION_MARKER
                    : content;
            if (rendered.length() > MAX_MESSAGE_CHARS) {
                contentTruncated = true;
            }
            exported += 1;
            body.append("\n## ").append(exported).append(". ").append(role);
            if (!createdAt.isBlank()) {
                body.append(" · ").append(createdAt);
            }
            body.append("\n\n").append(rendered).append('\n');
            if (body.length() >= MAX_DOCUMENT_CHARS) {
                contentTruncated = true;
                body.append("\n…[document truncated at ").append(MAX_DOCUMENT_CHARS).append(" characters]\n");
                break;
            }
        }
        String header = "# Session export\n\n"
                + "- session: " + sessionId + "\n"
                + "- messages: " + exported + "\n"
                + "- messagesTruncated: " + messagesTruncated + "\n"
                + "- contentTruncated: " + contentTruncated + "\n"
                + "- generated by: xihe control plane\n";
        return new ExportResult(header + body, exported, messagesTruncated, contentTruncated);
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
