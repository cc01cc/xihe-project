package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
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
import java.util.UUID;

/**
 * PLAN-0635 M3: the real {@code /export} — a Markdown artifact, not a prompt.
 *
 * <p>The M1 stub sent a fixed English sentence to the model ("Export chat history"): no artifact,
 * no data read, and a wasted run. Export is a read of data CP already owns, so the document is
 * generated here from the existing message read surface and never touches the Agent or a provider.
 *
 * <p>BL-295: export is a <b>bounded artifact</b>, not an error face. The renderer
 * ({@link SessionExportService#MAX_MESSAGES}) already cap the document and disclose the cut in the
 * header ({@code messagesTruncated}/{@code contentTruncated}); the old session-wide count precheck
 * that refused with {@code 413 EXPORT_TOO_LARGE} was removed because it counted ALL session rows
 * (every branch/visibility) and therefore refused legitimate exports of a small branch in a large
 * session. The streaming read ({@link SessionExportStreamRenderer}) keeps memory decoupled from the
 * session size, so no numeric refusal is needed: a 20k-message session with 50 visible messages
 * exports 50 messages, and a session with more than 2000 visible messages exports the newest 2000
 * with an explicit disclosure.
 *
 * <p>PLAN-0670 M2c/B: the document is prepared inside a short read-only transaction by
 * {@link SessionExportStreamRenderer} (cursor-backed read; document capped at {@code 2M} chars) and
 * the response is written with {@link StreamingResponseBody} in fixed-size chunks, so the body is
 * never buffered by the servlet layer and a client that disconnects stops the write immediately.
 * Wire format is unchanged ({@code text/markdown; charset=UTF-8} + attachment disposition) and the
 * Markdown bytes are identical to the pre-streaming implementation.
 *
 * <p>Why the headers are set on {@link HttpServletResponse} instead of a {@code ResponseEntity}:
 * Spring MVC only dispatches {@link StreamingResponseBody} when it is the declared return type
 * (a {@code ResponseEntity<StreamingResponseBody>} falls through to the message converters and
 * fails with {@code HttpMessageNotWritableException}). Error faces therefore throw
 * {@link CpApiException}; the problem body stays RFC 9457 with the same fields.
 */
@RestController
@RequestMapping("/api/v1/sessions")
public class SessionExportController {

    private static final Logger logger = LoggerFactory.getLogger(SessionExportController.class);

    /** Chunk size for the streaming write; small enough to flush early, large enough to be cheap. */
    private static final int EXPORT_CHUNK_BYTES = 32 * 1024;

    private final SessionService sessionService;
    private final BranchPathService branchPathService;
    private final SessionExportStreamRenderer streamRenderer;

    public SessionExportController(SessionService sessionService,
                                   BranchPathService branchPathService,
                                   SessionExportStreamRenderer streamRenderer) {
        this.sessionService = sessionService;
        this.branchPathService = branchPathService;
        this.streamRenderer = streamRenderer;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/{sessionId}/export")
    public StreamingResponseBody export(@PathVariable String sessionId,
                                        @RequestParam(value = "branchId", required = false) String branchId,
                                        HttpServletResponse response) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            throw CpApiException.workspaceContextRequired();
        }
        if (!isUuid(sessionId)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sessionId must be a UUID");
        }
        try {
            sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            throw e;
        }
        if (branchId == null || branchId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "branchId is required");
        }
        String canonicalBranchId;
        try {
            canonicalBranchId = UUID.fromString(branchId).toString();
        } catch (IllegalArgumentException invalidBranchId) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "branchId must be a UUID");
        }
        BranchPathService.BranchVisibility visibility;
        String rootBranchId;
        try {
            visibility = branchPathService.resolveVisibility(sessionId, canonicalBranchId);
            rootBranchId = branchPathService.resolvePath(sessionId, canonicalBranchId);
        } catch (CpApiException e) {
            throw e;
        }
        // BL-295: bounded export, no numeric refusal. The renderer caps the document at
        // MAX_MESSAGES and discloses the cut in the header; the old session-wide count precheck was
        // removed (it refused a 50-message branch of a 20k-message session). Streaming decouples
        // memory from session size, so this path is always 200 for an authorised session/branch.
        SessionExportService.ExportResult result = streamRenderer.render(sessionId, workspaceId,
                rootBranchId, visibility);
        logger.info("[LIFECYCLE] service=cp event=session_export sessionId={} messages={} messagesTruncated={} contentTruncated={}",
                sessionId, result.messages(), result.messagesTruncated(), result.contentTruncated());
        byte[] payload = result.markdown().getBytes(StandardCharsets.UTF_8);
        response.setStatus(HttpStatus.OK.value());
        response.setContentType("text/markdown;charset=UTF-8");
        response.setHeader(HttpHeaders.CONTENT_DISPOSITION,
                ContentDisposition.attachment()
                        .filename("session-" + sessionId + ".md", StandardCharsets.UTF_8)
                        .build()
                        .toString());
        return output -> writeExport(output, payload, sessionId);
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
