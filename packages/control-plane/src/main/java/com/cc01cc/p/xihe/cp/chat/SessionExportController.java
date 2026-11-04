package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0635 M3: the real {@code /export} — a Markdown artifact, not a prompt.
 *
 * <p>The M1 stub sent a fixed English sentence to the model ("Export chat history"): no artifact,
 * no data read, and a wasted run. Export is a read of data CP already owns, so the document is
 * generated here from the existing message read surface and never touches the Agent or a provider.
 *
 * <p>BL-279 (A1): the read surface used to materialise the whole session, so the controller
 * prechecks the session-wide message count against {@link SessionExportService#MAX_MESSAGES} and
 * refuses with {@code 413 EXPORT_TOO_LARGE} **before reading any message**. The cap is on session
 * size (the memory driver), not on the visible branch path; the detail carries the actual count and
 * limit so the client can act, and the refusal is never a silent truncation.
 *
 * <p>PLAN-0670 M2c/B: the document is now prepared inside a short read-only transaction by
 * {@link SessionExportStreamRenderer} (cursor-backed read; document capped at {@code 2M} chars) and
 * the response is written with {@link StreamingResponseBody} in fixed-size chunks, so the body is
 * never buffered by the servlet layer and a client that disconnects stops the write immediately.
 * Wire format is unchanged: {@code text/markdown; charset=UTF-8} + attachment disposition, and the
 * Markdown bytes are identical to the pre-streaming implementation.
 */
@RestController
@RequestMapping("/api/v1/sessions")
public class SessionExportController {

    private static final Logger logger = LoggerFactory.getLogger(SessionExportController.class);

    /** Chunk size for the streaming write; small enough to flush early, large enough to be cheap. */
    private static final int EXPORT_CHUNK_BYTES = 32 * 1024;

    private final SessionService sessionService;
    private final MessageReadService messageReadService;
    private final BranchPathService branchPathService;
    private final SessionExportStreamRenderer streamRenderer;

    public SessionExportController(SessionService sessionService,
                                   MessageReadService messageReadService,
                                   BranchPathService branchPathService,
                                   SessionExportStreamRenderer streamRenderer) {
        this.sessionService = sessionService;
        this.messageReadService = messageReadService;
        this.branchPathService = branchPathService;
        this.streamRenderer = streamRenderer;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/{sessionId}/export")
    public ResponseEntity<?> export(@PathVariable String sessionId,
                                    @RequestParam(value = "branchId", required = false) String branchId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        if (!isUuid(sessionId)) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sessionId must be a UUID");
        }
        try {
            sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        if (branchId == null || branchId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "branchId is required");
        }
        String canonicalBranchId;
        try {
            canonicalBranchId = UUID.fromString(branchId).toString();
        } catch (IllegalArgumentException invalidBranchId) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "branchId must be a UUID");
        }
        BranchPathService.BranchVisibility visibility;
        String rootBranchId;
        try {
            visibility = branchPathService.resolveVisibility(sessionId, canonicalBranchId);
            rootBranchId = branchPathService.resolvePath(sessionId, canonicalBranchId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        // BL-279 A1: refuse before any message row is materialised. `MAX_MESSAGES` is the single
        // source of the export cap (shared with the renderer) — never introduce a second literal.
        long totalMessages = messageReadService.countSessionMessages(sessionId);
        if (totalMessages > SessionExportService.MAX_MESSAGES) {
            logger.warn("[LIFECYCLE] service=cp event=session_export_refused sessionId={} messages={} "
                            + "limit={} reason=EXPORT_TOO_LARGE",
                    sessionId, totalMessages, SessionExportService.MAX_MESSAGES);
            Map<String, Object> extra = new LinkedHashMap<>();
            extra.put("messages", totalMessages);
            extra.put("limit", SessionExportService.MAX_MESSAGES);
            return ProblemDetailsHandler.problemResponse(HttpStatus.PAYLOAD_TOO_LARGE,
                    "EXPORT_TOO_LARGE",
                    "session has " + totalMessages + " messages, exceeding the export limit of "
                            + SessionExportService.MAX_MESSAGES
                            + "; export a smaller session or split the history before exporting",
                    extra);
        }
        SessionExportService.ExportResult result;
        try {
            result = streamRenderer.render(sessionId, workspaceId, rootBranchId, visibility);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        logger.info("[LIFECYCLE] service=cp event=session_export sessionId={} messages={} messagesTruncated={} contentTruncated={}",
                sessionId, result.messages(), result.messagesTruncated(), result.contentTruncated());
        byte[] payload = result.markdown().getBytes(StandardCharsets.UTF_8);
        StreamingResponseBody body = output -> writeExport(output, payload, sessionId);
        return ResponseEntity.ok()
                .contentType(new MediaType("text", "markdown", StandardCharsets.UTF_8))
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename("session-" + sessionId + ".md", StandardCharsets.UTF_8)
                                .build()
                                .toString())
                .body(body);
    }

    /**
     * Writes the prepared document in fixed-size chunks. A client disconnect surfaces as an
     * {@link IOException}; we log it once (with how much made it out) and stop — never retry the
     * read, never keep draining the session.
     */
    private void writeExport(OutputStream output, byte[] payload, String sessionId) throws IOException {
        int written = 0;
        try {
            while (written < payload.length) {
                int length = Math.min(EXPORT_CHUNK_BYTES, payload.length - written);
                output.write(payload, written, length);
                written += length;
                output.flush();
            }
        } catch (IOException disconnected) {
            logger.warn("[LIFECYCLE] service=cp event=session_export_client_disconnected sessionId={} "
                    + "writtenBytes={} totalBytes={}", sessionId, written, payload.length);
            throw disconnected;
        }
    }

    private static boolean isUuid(String value) {
        try {
            UUID.fromString(value);
            return true;
        } catch (IllegalArgumentException invalidUuid) {
            return false;
        }
    }
}
