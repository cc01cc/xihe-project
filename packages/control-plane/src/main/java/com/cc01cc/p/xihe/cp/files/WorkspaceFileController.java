package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.runtime.RuntimeWorkspaceFileClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceBackendPolicy;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpRange;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.List;
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
    /**
     * BL-381 / PLAN-0683: attachment preview budget. A single ranged response is
     * clamped to this many bytes; the {@code Content-Range} total stays the real
     * file length (the budget caps bytes-on-wire, never the reported file size).
     */
    private static final long ATTACHMENT_PREVIEW_BUDGET_BYTES = 8L * 1024 * 1024;

    private final ChatAttachmentService chatAttachmentService;
    private final WorkspaceService workspaceService;
    private final WorkspaceBackendPolicy backendPolicy;
    private final RuntimeWorkspaceFileClient runtimeFileClient;

    public WorkspaceFileController(
            ChatAttachmentService chatAttachmentService,
            WorkspaceService workspaceService,
            WorkspaceBackendPolicy backendPolicy,
            RuntimeWorkspaceFileClient runtimeFileClient) {
        this.chatAttachmentService = chatAttachmentService;
        this.workspaceService = workspaceService;
        this.backendPolicy = backendPolicy;
        this.runtimeFileClient = runtimeFileClient;
    }

    @GetMapping("/{fileId:[a-fA-F0-9\\\\-]{36}}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> serveAttachment(
            @PathVariable String fileId,
            @RequestHeader(value = HttpHeaders.RANGE, required = false) String rangeHeader) {
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
            String contentType = download.mimeType() != null ? download.mimeType() : "application/octet-stream";
            MediaType mediaType = MediaType.parseMediaType(contentType);
            if (rangeHeader == null || rangeHeader.isBlank()) {
                // No Range header: keep the historical 200 full-body behaviour byte for byte.
                Resource resource = new FileSystemResource(physical);
                return ResponseEntity.ok()
                        .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                        .contentType(mediaType)
                        .body(resource);
            }
            return serveAttachmentRange(physical, mediaType, rangeHeader);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (Exception e) {
            logger.error("Failed to serve attachment fileId={}", fileId, e);
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.INTERNAL_SERVER_ERROR, "FILE_READ_FAILED", "File read failed");
        }
    }

    /**
     * BL-381 / PLAN-0683: single-segment byte ranges with a server-side preview budget.
     *
     * <p>Only the response length is clamped ({@code end = min(end, start + budget - 1)}),
     * never the start offset, and {@code Content-Range} always reports the real file
     * length. Multi-range requests are rejected explicitly: the implicit Spring MVC
     * range handling answers them with 206 + no {@code Content-Range} + a concatenated
     * body (see {@code plans/PLAN-0683-.../evidence/t0.3-cp-range-probe.md}), which is not
     * an acceptable wire contract.</p>
     */
    private ResponseEntity<?> serveAttachmentRange(
            java.io.File physical, MediaType mediaType, String rangeHeader) throws IOException {
        long total = physical.length();
        List<HttpRange> ranges;
        try {
            ranges = HttpRange.parseRanges(rangeHeader);
        } catch (IllegalArgumentException e) {
            return rangeProblem(HttpStatus.BAD_REQUEST, "INVALID_RANGE",
                    "Invalid Range header", total);
        }
        if (ranges.size() != 1) {
            return rangeProblem(HttpStatus.BAD_REQUEST, "INVALID_RANGE",
                    "Multiple ranges are not supported", total);
        }
        HttpRange range = ranges.get(0);
        long start;
        long end;
        try {
            start = range.getRangeStart(total);
            end = range.getRangeEnd(total);
        } catch (IllegalArgumentException e) {
            return rangeProblem(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
                    "RANGE_NOT_SATISFIABLE", "Requested range is not satisfiable", total);
        }
        if (start < 0 || start >= total || end < start) {
            return rangeProblem(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
                    "RANGE_NOT_SATISFIABLE", "Requested range is not satisfiable", total);
        }
        long clampedEnd = Math.min(end, start + ATTACHMENT_PREVIEW_BUDGET_BYTES - 1);
        byte[] slice = readRange(physical, start, clampedEnd - start + 1);
        return ResponseEntity.status(HttpStatus.PARTIAL_CONTENT)
                .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                .header(HttpHeaders.CONTENT_RANGE, "bytes " + start + "-" + clampedEnd + "/" + total)
                .contentType(mediaType)
                .body(slice);
    }

    private static byte[] readRange(java.io.File physical, long start, long length) throws IOException {
        byte[] buffer = new byte[(int) length];
        try (RandomAccessFile file = new RandomAccessFile(physical, "r")) {
            file.seek(start);
            file.readFully(buffer);
        }
        return buffer;
    }

    private static ResponseEntity<Map<String, Object>> rangeProblem(
            HttpStatus status, String code, String detail, long total) {
        Map<String, Object> body = ProblemDetailsHandler.problemResponse(status, code, detail).getBody();
        return ResponseEntity.status(status)
                .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                .header(HttpHeaders.CONTENT_RANGE, "bytes */" + total)
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(body);
    }

    @PostMapping("/upload")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> uploadFile(
            @RequestParam("file") MultipartFile file) {
        try {
            String userId = TenantContext.getUserId();
            String wsId = TenantContext.getWorkspaceId();
            if (userId == null || wsId == null) {
                return ProblemDetailsHandler.workspaceContextRequired();
            }
            if (!workspaceService.isWorkspaceMember(wsId, userId)) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found");
            }
            // PLAN-0612 M4: an existing docker workspace's file operations fail closed (503)
            // while the backend is frozen; direct_attach workspaces are unaffected.
            Workspace workspace = workspaceService.requireAccessibleWorkspace(wsId, userId);
            backendPolicy.requireOperationAllowed(workspace);
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
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (IOException e) {
            logger.error("Upload failed", e);
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.INTERNAL_SERVER_ERROR, "UPLOAD_FAILED", "File upload failed");
        }
    }
}
