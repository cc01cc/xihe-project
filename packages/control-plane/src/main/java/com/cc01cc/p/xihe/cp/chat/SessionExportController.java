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

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0635 M3: the real {@code /export} — a Markdown artifact, not a prompt.
 *
 * <p>The M1 stub sent a fixed English sentence to the model ("Export chat history"): no artifact,
 * no data read, and a wasted run. Export is a read of data CP already owns, so the document is
 * generated here from the existing message read surface
 * ({@link MessageReadService#listVisibleMessages}) and never touches the Agent or a provider.
 *
 * <p>BL-279 (A1): the read surface materialises the whole session, so the controller prechecks the
 * session-wide message count against {@link SessionExportService#MAX_MESSAGES} and refuses with
 * {@code 413 EXPORT_TOO_LARGE} **before reading any message**. The cap is on session size (the
 * memory driver), not on the visible branch path; the detail carries the actual count and limit so
 * the client can act, and the refusal is never a silent truncation.
 *
 * <p>Kept as its own controller (separate from {@link SessionCommandController}) so the registry
 * and the export artifact remain independently reviewable/committable.
 */
@RestController
@RequestMapping("/api/v1/sessions")
public class SessionExportController {

    private static final Logger logger = LoggerFactory.getLogger(SessionExportController.class);

    private final SessionService sessionService;
    private final MessageReadService messageReadService;
    private final BranchPathService branchPathService;
    private final SessionExportService exportService;

    public SessionExportController(SessionService sessionService,
                                   MessageReadService messageReadService,
                                   BranchPathService branchPathService,
                                   SessionExportService exportService) {
        this.sessionService = sessionService;
        this.messageReadService = messageReadService;
        this.branchPathService = branchPathService;
        this.exportService = exportService;
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
        List<Map<String, Object>> messages;
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
        messages = messageReadService.listVisibleMessages(sessionId, workspaceId, rootBranchId, visibility);
        SessionExportService.ExportResult result = exportService.render(sessionId, messages);
        logger.info("[LIFECYCLE] service=cp event=session_export sessionId={} messages={} messagesTruncated={} contentTruncated={}",
                sessionId, result.messages(), result.messagesTruncated(), result.contentTruncated());
        return ResponseEntity.ok()
                .contentType(new MediaType("text", "markdown", StandardCharsets.UTF_8))
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename("session-" + sessionId + ".md", StandardCharsets.UTF_8)
                                .build()
                                .toString())
                .body(result.markdown());
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
