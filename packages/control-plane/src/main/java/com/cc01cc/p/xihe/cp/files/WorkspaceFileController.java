package com.cc01cc.p.xihe.cp.files;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.multipart.MultipartFile;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;

import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

@RestController
    @RequestMapping("/api/v1/files")
public class WorkspaceFileController {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceFileController.class);
    private static final long MAX_UPLOAD_SIZE = 500L * 1024 * 1024;

    private final String workspaceBasePath;
    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final PdfSplitService pdfSplitService;
    private final ObjectMapper objectMapper;
    private final FileRepository fileRepository;
    private final SessionRepository sessionRepository;
    private final WorkspaceUserRepository workspaceUserRepository;

    public WorkspaceFileController(
            @Value("${cp.workspace-base-path:/data/xihe/workspaces}") String workspaceBasePath,
            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
            RestTemplate restTemplate,
            PdfSplitService pdfSplitService,
            ObjectMapper objectMapper,
            FileRepository fileRepository,
            SessionRepository sessionRepository,
            WorkspaceUserRepository workspaceUserRepository) {
        this.workspaceBasePath = workspaceBasePath;
        this.runtimeUrl = runtimeUrl;
        this.restTemplate = restTemplate;
        this.pdfSplitService = pdfSplitService;
        this.objectMapper = objectMapper;
        this.fileRepository = fileRepository;
        this.sessionRepository = sessionRepository;
        this.workspaceUserRepository = workspaceUserRepository;
    }

    @GetMapping("/{fileId:[a-fA-F0-9\\\\-]{36}}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> serveAttachment(@PathVariable String fileId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            logger.warn("Attachment serve rejected: missing tenant context fileId={}", fileId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "File access denied");
        }
        try {
            File file = fileRepository.findById(fileId).orElse(null);
            if (file == null) {
                logger.warn("Attachment not found: {}", fileId);
                return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "FILE_NOT_FOUND", "File not found");
            }
            Session session = sessionRepository.findById(file.getSessionId()).orElse(null);
            if (session == null || !workspaceId.equals(session.getWorkspaceId())) {
                logger.warn("Attachment access denied fileId={} session={}", fileId, file.getSessionId());
                return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "File access denied");
            }
            if (!workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId).isPresent()) {
                logger.warn("Attachment access denied for user fileId={} userId={}", fileId, userId);
                return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "File access denied");
            }

            java.io.File physical = new java.io.File(file.getStoragePath());
            if (!physical.exists() || !physical.isFile()) {
                logger.warn("Attachment physical file missing: {}", file.getStoragePath());
                return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "FILE_NOT_FOUND", "File not found");
            }

            Resource resource = new FileSystemResource(physical);
            String contentType = file.getMimeType() != null ? file.getMimeType() : resolveContentType(file.getFilename());
            return ResponseEntity.ok()
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                    .contentType(MediaType.parseMediaType(contentType))
                    .body(resource);
        } catch (Exception e) {
            logger.error("Failed to serve attachment fileId={}", fileId, e);
            return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "FILE_READ_FAILED", "File read failed");
        }
    }

    @GetMapping("/{*path}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> serveFile(@PathVariable String path) {
        try {
            String resolved = Paths.get(workspaceBasePath, path).normalize().toString();
            if (!resolved.startsWith(Paths.get(workspaceBasePath).normalize().toString())) {
                logger.warn("Path traversal attempt: {}", path);
                return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "File access denied");
            }

            java.io.File file = new java.io.File(resolved);
            if (!file.exists() || !file.isFile()) {
                logger.warn("File not found: {}", resolved);
                return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "FILE_NOT_FOUND", "File not found");
            }

            Resource resource = new FileSystemResource(file);
            String contentType = resolveContentType(path);
            return ResponseEntity.ok()
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                    .contentType(MediaType.parseMediaType(contentType))
                    .body(resource);
        } catch (Exception e) {
            logger.error("Failed to serve file: {}", path, e);
            return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "FILE_READ_FAILED", "File read failed");
        }
    }

    @PostMapping("/upload")
    public ResponseEntity<?> uploadFile(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "splitPreference", defaultValue = "false") boolean splitPreference) {
        try {
            String wsId = TenantContext.getWorkspaceId();
            String wsPath = TenantContext.getWorkspacePath();
            if (wsId == null || wsPath == null) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
            }

            long size = file.getSize();
            if (size > MAX_UPLOAD_SIZE) {
                logger.warn("Upload rejected: file too large ({} bytes)", size);
                return ProblemDetailsHandler.problemResponse(HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "File exceeds the upload limit");
            }

            String originalName = file.getOriginalFilename();
            if (originalName == null || originalName.isBlank()) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Filename is required");
            }

            boolean isPdf = originalName.toLowerCase().endsWith(".pdf");

            if (isPdf && size > 10L * 1024 * 1024 && splitPreference) {
                java.io.File tempFile = java.io.File.createTempFile("split-", ".pdf");
                try {
                    file.transferTo(tempFile);
                    List<String> chunks = pdfSplitService.splitPdf(tempFile.toPath(), originalName, wsId);
                    logger.info("PDF split complete: {} -> {} chunks", originalName, chunks.size());
                    return ResponseEntity.ok(Map.of("chunks", chunks, "original", originalName));
                } finally {
                    tempFile.delete();
                }
            } else {
                String destPath = wsPath + "/" + originalName;
                java.io.File dest = new java.io.File(destPath);
                dest.getParentFile().mkdirs();
                file.transferTo(dest);
                logger.info("File uploaded: {} ({} bytes)", destPath, size);
                return ResponseEntity.ok(Map.of("path", originalName));
            }
        } catch (Exception e) {
            logger.error("Upload failed", e);
            return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "UPLOAD_FAILED", "File upload failed");
        }
    }

    @PostMapping("/split-pdf")
    public ResponseEntity<?> splitPdf(@RequestBody Map<String, String> body) {
        try {
            String wsId = TenantContext.getWorkspaceId();
            String wsPath = TenantContext.getWorkspacePath();
            if (wsId == null || wsPath == null) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
            }

            String path = body.get("path");
            if (path == null || path.isBlank()) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Path is required");
            }

            Path pdfPath = Paths.get(wsPath, path).normalize();
            if (!pdfPath.startsWith(Paths.get(wsPath).normalize())) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "Path access denied");
            }

            java.io.File pdfFile = pdfPath.toFile();
            if (!pdfFile.exists() || !pdfFile.isFile()) {
                return ResponseEntity.notFound().build();
            }

            long fileSize = pdfFile.length();
            if (fileSize > MAX_UPLOAD_SIZE) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "File exceeds the split limit");
            }

            List<String> chunks = pdfSplitService.splitPdf(pdfPath, path, wsId);
            logger.info("Lazy split complete: {} -> {} chunks", path, chunks.size());
            return ResponseEntity.ok(Map.of("chunks", chunks));
        } catch (Exception e) {
            logger.error("Split failed", e);
            return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "SPLIT_FAILED", "PDF split failed");
        }
    }

    @DeleteMapping("/{*path}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> deleteFile(@PathVariable String path) {
        try {
            String resolved = Paths.get(workspaceBasePath, path).normalize().toString();
            if (!resolved.startsWith(Paths.get(workspaceBasePath).normalize().toString())) {
                logger.warn("Path traversal attempt: {}", path);
                return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "File access denied");
            }

            java.io.File file = new java.io.File(resolved);
            if (!file.exists()) {
                logger.warn("File not found: {}", resolved);
                return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "FILE_NOT_FOUND", "File not found");
            }

            if (file.isFile()) {
                String fileName = file.getName();
                String dirPath = file.getParent();
                if (PdfSplitService.isChunkFile(fileName)) {
                    file.delete();
                    logger.info("Deleted chunk file: {}", path);
                    return ResponseEntity.ok(Map.of("deleted", path));
                }

                String baseName = PdfSplitService.baseNameOf(fileName);
                if (!baseName.equals(fileName)) {
                    java.io.File dir = new java.io.File(dirPath);
                    java.io.File[] chunks = dir.listFiles((d, name) -> name.matches(".+\\.p\\d+-\\d+\\.pdf$")
                            && PdfSplitService.baseNameOf(name).equals(baseName));
                    if (chunks != null) {
                        for (java.io.File chunk : chunks) {
                            if (chunk.delete()) {
                                logger.debug("Cascade deleted chunk: {}", chunk.getName());
                            }
                        }
                    }
                }
            }

            boolean deleted = deleteViaRuntime(path, workspaceBasePath);
            if (deleted) {
                logger.info("Deleted file: {}", path);
                return ResponseEntity.ok(Map.of("deleted", path));
            } else {
                return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "DELETE_FAILED", "File deletion failed");
            }
        } catch (Exception e) {
            logger.error("Failed to delete file: {}", path, e);
            return ResponseEntity.status(500).build();
        }
    }

    private boolean deleteViaRuntime(String path, String wsBasePath) {
        try {
            String wsId = TenantContext.getWorkspaceId();
            if (wsId == null) return false;

            String url = runtimeUrl + "/internal/v1/runtime/workspaces/" + wsId + "/files/delete";
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            org.springframework.http.HttpEntity<String> req =
                    new org.springframework.http.HttpEntity<>("{\"path\":\"" + path + "\"}", headers);
            restTemplate.postForEntity(url, req, String.class);
            return true;
        } catch (Exception e) {
            logger.warn("Runtime delete failed for {}: {}", path, e.getMessage());
            return false;
        }
    }

    private String resolveContentType(String path) {
        if (path.endsWith(".pdf")) return "application/pdf";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }
}
