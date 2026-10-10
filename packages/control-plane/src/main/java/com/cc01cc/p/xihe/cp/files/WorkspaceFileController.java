package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.runtime.RuntimeWorkspaceFileClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.Map;

/**
 * Workspace file endpoints always go through the Runtime. CP no longer reads
 * or writes {@code storagePath} directly. The legacy CP-hosted workspace file
 * route has been removed; for non-attachment files, clients should call the
 * Runtime directly with the workspace-scoped bearer token.
 */
@RestController
@RequestMapping("/api/v1/files")
public class WorkspaceFileController {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceFileController.class);
    private static final long MAX_UPLOAD_SIZE = RuntimeWorkspaceFileClient.MAX_WORKSPACE_FILE_BYTES;

    private final ChatAttachmentService chatAttachmentService;
    private final WorkspaceService workspaceService;
    private final RuntimeWorkspaceFileClient runtimeFileClient;

    public WorkspaceFileController(
            ChatAttachmentService chatAttachmentService,
            WorkspaceService workspaceService,
            RuntimeWorkspaceFileClient runtimeFileClient) {
        this.chatAttachmentService = chatAttachmentService;
        this.workspaceService = workspaceService;
        this.runtimeFileClient = runtimeFileClient;
    }

    @GetMapping("/{fileId:[a-fA-F0-9\\\\-]{36}}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> serveAttachment(@PathVariable String fileId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.FORBIDDEN, "FORBIDDEN", "File access denied");
        }
        try {
            var attachment = chatAttachmentService.findWorkspaceAttachmentForDownload(
                    fileId, userId, workspaceId);
            if (attachment.isEmpty()) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "FILE_NOT_FOUND", "File not found");
            }
            // Chat attachments live in CP session storage (cp.attachments-base-path),
            // not in workspace storage; serving them does not cross the Runtime boundary.
            var download = attachment.orElseThrow();
            java.io.File physical = download.storagePath().toFile();
            if (!physical.exists() || !physical.isFile()) {
                logger.warn("Attachment physical file missing: fileId={}", fileId);
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "FILE_NOT_FOUND", "File not found");
            }
            Resource resource = new org.springframework.core.io.FileSystemResource(physical);
            String contentType = download.mimeType() != null ? download.mimeType() : "application/octet-stream";
            return ResponseEntity.ok()
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                    .contentType(MediaType.parseMediaType(contentType))
                    .body(resource);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (Exception e) {
            logger.error("Failed to serve attachment fileId={}", fileId, e);
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.INTERNAL_SERVER_ERROR, "FILE_READ_FAILED", "File read failed");
        }
    }

    @PostMapping("/upload")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> uploadFile(
            @RequestParam("file") MultipartFile file) {
        try {
            String userId = TenantContext.getUserId();
            String wsId = TenantContext.getWorkspaceId();
            if (userId == null || wsId == null) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
            }
            if (!workspaceService.isWorkspaceMember(wsId, userId)) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found");
            }
            if (file.getSize() > MAX_UPLOAD_SIZE) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE",
                        "Workspace file exceeds the 64 MiB file-tool limit");
            }
            String originalName = file.getOriginalFilename();
            if (originalName == null || originalName.isBlank()) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Filename is required");
            }
            if (!runtimeFileClient.writeBinary(wsId, originalName, file.getBytes())) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime rejected the upload");
            }
            return ResponseEntity.ok(Map.of("path", originalName, "size", file.getSize()));
        } catch (IOException e) {
            logger.error("Upload failed", e);
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.INTERNAL_SERVER_ERROR, "UPLOAD_FAILED", "File upload failed");
        }
    }
}
