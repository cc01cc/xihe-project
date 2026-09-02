package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeWorkspaceFileClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
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
    private static final long MAX_UPLOAD_SIZE = 500L * 1024 * 1024;

    private final FileRepository fileRepository;
    private final SessionRepository sessionRepository;
    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final RuntimeWorkspaceFileClient runtimeFileClient;

    public WorkspaceFileController(
            FileRepository fileRepository,
            SessionRepository sessionRepository,
            WorkspaceRepository workspaceRepository,
            WorkspaceUserRepository workspaceUserRepository,
            RuntimeWorkspaceFileClient runtimeFileClient) {
        this.fileRepository = fileRepository;
        this.sessionRepository = sessionRepository;
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
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
            File file = fileRepository.findById(fileId).orElse(null);
            if (file == null) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "FILE_NOT_FOUND", "File not found");
            }
            Session session = file.getSessionId() == null
                    ? null : sessionRepository.findById(file.getSessionId()).orElse(null);
            if (session == null
                    || session.isArchived()
                    || !workspaceId.equals(session.getWorkspaceId())
                    || !userId.equals(session.getUserId())
                    || !workspaceId.equals(file.getWorkspaceId())
                    || !userId.equals(file.getUserId())) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.FORBIDDEN, "FORBIDDEN", "File access denied");
            }
            if (workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId).isEmpty()
                    || workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId).isEmpty()) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.FORBIDDEN, "FORBIDDEN", "File access denied");
            }
            // Chat attachments live in CP session storage (cp.attachments-base-path),
            // not in workspace storage; serving them does not cross the Runtime boundary.
            java.io.File physical = new java.io.File(file.getStoragePath());
            if (!physical.exists() || !physical.isFile()) {
                logger.warn("Attachment physical file missing: fileId={}", fileId);
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "FILE_NOT_FOUND", "File not found");
            }
            Resource resource = new org.springframework.core.io.FileSystemResource(physical);
            String contentType = file.getMimeType() != null ? file.getMimeType() : "application/octet-stream";
            return ResponseEntity.ok()
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                    .contentType(MediaType.parseMediaType(contentType))
                    .body(resource);
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
            if (workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(wsId, userId).isEmpty()) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found");
            }
            if (file.getSize() > MAX_UPLOAD_SIZE) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "File exceeds the upload limit");
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
