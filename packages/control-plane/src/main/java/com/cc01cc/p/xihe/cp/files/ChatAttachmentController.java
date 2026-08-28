package com.cc01cc.p.xihe.cp.files;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;
import com.cc01cc.p.xihe.cp.files.dto.BatchUploadResult;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/sessions/{sessionId}/attachments")
public class ChatAttachmentController {

    private static final Logger logger = LoggerFactory.getLogger(ChatAttachmentController.class);

    private final ChatAttachmentService chatAttachmentService;

    public ChatAttachmentController(ChatAttachmentService chatAttachmentService) {
        this.chatAttachmentService = chatAttachmentService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping
    public ResponseEntity<?> uploadAttachments(
            @PathVariable String sessionId,
            @RequestParam("files") List<MultipartFile> files) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            logger.warn("Attachment upload rejected: missing tenant context session={}", sessionId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        if (files == null || files.isEmpty()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "No files provided");
        }
        try {
            BatchUploadResult result = chatAttachmentService.upload(sessionId, files, userId, workspaceId);
            return ResponseEntity.ok(result);
        } catch (Exception e) {
            logger.error("Attachment upload failed session={}", sessionId, e);
            return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "UPLOAD_FAILED", "Attachment upload failed");
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @DeleteMapping("/{fileId}")
    public ResponseEntity<?> deleteAttachment(
            @PathVariable String sessionId,
            @PathVariable String fileId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        try {
            chatAttachmentService.delete(sessionId, fileId, userId, workspaceId);
            return ResponseEntity.ok(Map.of("deleted", fileId));
        } catch (IllegalArgumentException e) {
            logger.warn("Attachment delete failed session={} fileId={} reason={}", sessionId, fileId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "ATTACHMENT_NOT_FOUND", "Attachment not found");
        } catch (Exception e) {
            logger.error("Attachment delete failed session={} fileId={}", sessionId, fileId, e);
            return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "DELETE_FAILED", "Attachment deletion failed");
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/{fileId}")
    public ResponseEntity<?> getAttachmentMetadata(
            @PathVariable String sessionId,
            @PathVariable String fileId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        try {
            File file = chatAttachmentService.getMetadata(sessionId, fileId, userId, workspaceId);
            AttachmentInfo info = new AttachmentInfo(
                    file.getId(),
                    file.getFilename(),
                    file.getMimeType(),
                    file.getSizeBytes(),
                    "/files/" + file.getId()
            );
            return ResponseEntity.ok(info);
        } catch (IllegalArgumentException e) {
            logger.warn("Attachment metadata request failed session={} fileId={} reason={}", sessionId, fileId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "ATTACHMENT_NOT_FOUND", "Attachment not found");
        } catch (Exception e) {
            logger.error("Attachment metadata request failed session={} fileId={}", sessionId, fileId, e);
            return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "ATTACHMENT_FAILED", "Attachment request failed");
        }
    }
}
