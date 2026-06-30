package com.cc01cc.p.xihe.cp.files;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.multipart.MultipartFile;
import com.cc01cc.p.xihe.cp.config.TenantContext;

import java.io.File;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/files")
public class WorkspaceFileController {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceFileController.class);
    private static final long MAX_UPLOAD_SIZE = 500L * 1024 * 1024;

    private final String workspaceBasePath;
    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final PdfSplitService pdfSplitService;
    private final ObjectMapper objectMapper;

    public WorkspaceFileController(
            @Value("${cp.workspace-base-path:/data/xihe/workspaces}") String workspaceBasePath,
            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
            RestTemplate restTemplate,
            PdfSplitService pdfSplitService,
            ObjectMapper objectMapper) {
        this.workspaceBasePath = workspaceBasePath;
        this.runtimeUrl = runtimeUrl;
        this.restTemplate = restTemplate;
        this.pdfSplitService = pdfSplitService;
        this.objectMapper = objectMapper;
    }

    @GetMapping("/{*path}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<Resource> serveFile(@PathVariable String path) {
        try {
            String resolved = Paths.get(workspaceBasePath, path).normalize().toString();
            if (!resolved.startsWith(Paths.get(workspaceBasePath).normalize().toString())) {
                logger.warn("Path traversal attempt: {}", path);
                return ResponseEntity.status(403).build();
            }

            File file = new File(resolved);
            if (!file.exists() || !file.isFile()) {
                logger.warn("File not found: {}", resolved);
                return ResponseEntity.notFound().build();
            }

            Resource resource = new FileSystemResource(file);
            String contentType = resolveContentType(path);
            return ResponseEntity.ok()
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                    .contentType(MediaType.parseMediaType(contentType))
                    .body(resource);
        } catch (Exception e) {
            logger.error("Failed to serve file: {}", path, e);
            return ResponseEntity.status(500).build();
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
                return ResponseEntity.status(401).body(Map.of("error", "workspace not in context"));
            }

            long size = file.getSize();
            if (size > MAX_UPLOAD_SIZE) {
                logger.warn("Upload rejected: file too large ({} bytes)", size);
                return ResponseEntity.status(413).body(Map.of("error", "file too large, max " + MAX_UPLOAD_SIZE + " bytes"));
            }

            String originalName = file.getOriginalFilename();
            if (originalName == null || originalName.isBlank()) {
                return ResponseEntity.badRequest().body(Map.of("error", "filename required"));
            }

            boolean isPdf = originalName.toLowerCase().endsWith(".pdf");

            if (isPdf && size > 10L * 1024 * 1024 && splitPreference) {
                File tempFile = File.createTempFile("split-", ".pdf");
                try {
                    file.transferTo(tempFile);
                    List<String> chunks = pdfSplitService.splitPdf(tempFile.toPath(), originalName, wsId);
                    logger.info("PDF split complete: {} → {} chunks", originalName, chunks.size());
                    return ResponseEntity.ok(Map.of("chunks", chunks, "original", originalName));
                } finally {
                    tempFile.delete();
                }
            } else {
                String destPath = wsPath + "/" + originalName;
                File dest = new File(destPath);
                dest.getParentFile().mkdirs();
                file.transferTo(dest);
                logger.info("File uploaded: {} ({} bytes)", destPath, size);
                return ResponseEntity.ok(Map.of("path", originalName));
            }
        } catch (Exception e) {
            logger.error("Upload failed", e);
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/split-pdf")
    public ResponseEntity<?> splitPdf(@RequestBody Map<String, String> body) {
        try {
            String wsId = TenantContext.getWorkspaceId();
            String wsPath = TenantContext.getWorkspacePath();
            if (wsId == null || wsPath == null) {
                return ResponseEntity.status(401).body(Map.of("error", "workspace not in context"));
            }

            String path = body.get("path");
            if (path == null || path.isBlank()) {
                return ResponseEntity.badRequest().body(Map.of("error", "path required"));
            }

            Path pdfPath = Paths.get(wsPath, path).normalize();
            if (!pdfPath.startsWith(Paths.get(wsPath).normalize())) {
                return ResponseEntity.status(403).body(Map.of("error", "path traversal"));
            }

            File pdfFile = pdfPath.toFile();
            if (!pdfFile.exists() || !pdfFile.isFile()) {
                return ResponseEntity.notFound().build();
            }

            long fileSize = pdfFile.length();
            if (fileSize > MAX_UPLOAD_SIZE) {
                return ResponseEntity.status(413).body(Map.of("error", "file too large for splitting, max " + MAX_UPLOAD_SIZE + " bytes"));
            }

            List<String> chunks = pdfSplitService.splitPdf(pdfPath, path, wsId);
            logger.info("Lazy split complete: {} → {} chunks", path, chunks.size());
            return ResponseEntity.ok(Map.of("chunks", chunks));
        } catch (Exception e) {
            logger.error("Split failed", e);
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    @DeleteMapping("/{*path}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> deleteFile(@PathVariable String path) {
        try {
            String resolved = Paths.get(workspaceBasePath, path).normalize().toString();
            if (!resolved.startsWith(Paths.get(workspaceBasePath).normalize().toString())) {
                logger.warn("Path traversal attempt: {}", path);
                return ResponseEntity.status(403).build();
            }

            File file = new File(resolved);
            if (!file.exists()) {
                logger.warn("File not found: {}", resolved);
                return ResponseEntity.notFound().build();
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
                    File dir = new File(dirPath);
                    File[] chunks = dir.listFiles((d, name) -> name.matches(".+\\.p\\d+-\\d+\\.pdf$")
                            && PdfSplitService.baseNameOf(name).equals(baseName));
                    if (chunks != null) {
                        for (File chunk : chunks) {
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
                return ResponseEntity.status(500).body(Map.of("error", "delete failed"));
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

            String url = runtimeUrl + "/workspace/" + wsId + "/files/delete";
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
