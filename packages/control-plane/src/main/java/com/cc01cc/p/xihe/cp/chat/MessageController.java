package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/sessions/{sessionId}/messages")
public class MessageController {

    private static final org.slf4j.Logger logger =
            org.slf4j.LoggerFactory.getLogger(MessageController.class);

    private final SessionService sessionService;
    private final BranchPathService branchPathService;
    private final MessageReadService messageReadService;
    private final MessageDeletionService messageDeletionService;

    public MessageController(SessionService sessionService,
                             BranchPathService branchPathService,
                             MessageReadService messageReadService,
                             MessageDeletionService messageDeletionService) {
        this.sessionService = sessionService;
        this.branchPathService = branchPathService;
        this.messageReadService = messageReadService;
        this.messageDeletionService = messageDeletionService;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> listMessages(@PathVariable String sessionId,
                                          @RequestParam(value = "branchId", required = false) String branchId,
                                          @RequestParam(value = "limit", required = false) Integer limit,
                                          @RequestParam(value = "before", required = false) String before) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
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
        try {
            branchId = UUID.fromString(branchId).toString();
        } catch (IllegalArgumentException invalidBranchId) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "branchId must be a UUID");
        }

        BranchPathService.BranchVisibility visibility;
        String rootBranchId;
        try {
            visibility = branchPathService.resolveVisibility(sessionId, branchId);
            rootBranchId = branchPathService.resolvePath(sessionId, branchId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }

        // PLAN-0670 M2: no pagination parameter keeps the legacy full-list contract byte-for-byte
        // (old clients must not suddenly receive only 50 rows). Any pagination parameter switches to
        // the cursor envelope; an absent `limit` then defaults to 50 and values above 200 are
        // truncated (the effective limit is echoed in the response).
        if (limit == null && before == null) {
            // PLAN-0670 M2b: compatibility must not mean unbounded memory. Refuse BEFORE reading a
            // single row (same "count first" pattern as the BL-279 A1 export guard, same 2000 cap):
            // a normal session keeps the old byte-for-byte response, a long one gets an actionable
            // 413 instead of a ~90 MB heap spike. Never silently truncate the legacy contract.
            long totalMessages = messageReadService.countSessionMessages(sessionId);
            if (totalMessages > MessageReadService.MAX_FULL_READ_MESSAGES) {
                logger.warn("[LIFECYCLE] service=cp event=session_messages_pagination_required "
                                + "sessionId={} messages={} limit={}", sessionId, totalMessages,
                        MessageReadService.MAX_FULL_READ_MESSAGES);
                Map<String, Object> extra = new java.util.LinkedHashMap<>();
                extra.put("messages", totalMessages);
                extra.put("limit", MessageReadService.MAX_FULL_READ_MESSAGES);
                return ProblemDetailsHandler.problemResponse(HttpStatus.PAYLOAD_TOO_LARGE,
                        "PAGINATION_REQUIRED",
                        "session has " + totalMessages + " messages, exceeding the full-read limit of "
                                + MessageReadService.MAX_FULL_READ_MESSAGES
                                + "; request a page with limit/before (the paginated response returns nextCursor)",
                        extra);
            }
            return ResponseEntity.ok(messageReadService.listVisibleMessages(
                    sessionId, workspaceId, rootBranchId, visibility));
        }
        if (limit != null && limit < 1) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "limit must be a positive integer");
        }
        int effectiveLimit = limit == null ? DEFAULT_PAGE_LIMIT : Math.min(limit,
                MessageReadService.MAX_PAGE_LIMIT);
        MessageReadService.MessagePage page;
        try {
            page = messageReadService.listVisibleMessagesPage(
                    sessionId, workspaceId, rootBranchId, visibility, effectiveLimit, before);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        Map<String, Object> response = new java.util.LinkedHashMap<>();
        response.put("messages", page.messages());
        response.put("limit", page.limit());
        response.put("truncated", page.truncated());
        if (page.nextCursor() != null) {
            response.put("nextCursor", page.nextCursor());
        }
        return ResponseEntity.ok(response);
    }

    /** PLAN-0670 M2 default page size when a pagination parameter is present but `limit` is not. */
    private static final int DEFAULT_PAGE_LIMIT = 50;

    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{messageId}")
    public ResponseEntity<?> deleteMessage(@PathVariable String sessionId, @PathVariable String messageId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        try {
            String deletedMessageId = messageDeletionService.delete(sessionId, messageId, userId, workspaceId);
            return ResponseEntity.ok(Map.of("deleted", deletedMessageId));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

}
