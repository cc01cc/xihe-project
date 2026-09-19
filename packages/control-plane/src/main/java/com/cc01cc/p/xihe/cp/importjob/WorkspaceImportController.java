package com.cc01cc.p.xihe.cp.importjob;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.WorkspaceImport;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1")
public class WorkspaceImportController {
    private final WorkspaceImportService service;

    public WorkspaceImportController(WorkspaceImportService service) {
        this.service = service;
    }

    @PostMapping("/workspaces/{workspaceId}/imports")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> create(@PathVariable String workspaceId, @RequestBody Map<String, Object> body) {
        WorkspaceImport record = service.create(
                workspaceId,
                requireUserId(),
                (String) body.get("sourcePath"),
                body.getOrDefault("excludeRules", List.of()).toString(),
                (String) body.get("idempotencyKey"));
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(view(record));
    }

    @GetMapping("/workspace-imports/{importId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> get(@PathVariable String importId) {
        return ResponseEntity.ok(view(service.get(importId, requireUserId())));
    }

    @PostMapping("/workspace-imports/{importId}/cancel")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> cancel(@PathVariable String importId) {
        return ResponseEntity.ok(view(service.cancel(importId, requireUserId())));
    }

    @GetMapping("/workspaces/{workspaceId}/imports")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> list(@PathVariable String workspaceId) {
        return ResponseEntity.ok(service.list(workspaceId, requireUserId()).stream().map(this::view).toList());
    }

    private String requireUserId() {
        String userId = TenantContext.getUserId();
        if (userId == null) throw new com.cc01cc.p.xihe.cp.config.CpApiException(
                HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        return userId;
    }

    private Map<String, Object> view(WorkspaceImport record) {
        return Map.ofEntries(
                Map.entry("importId", record.getId().toString()),
                Map.entry("workspaceId", record.getWorkspaceId().toString()),
                Map.entry("sourcePath", record.getSourcePath()),
                Map.entry("status", record.getStatus()),
                Map.entry("filesScanned", record.getFilesScanned()),
                Map.entry("filesCopied", record.getFilesCopied()),
                Map.entry("filesSkipped", record.getFilesSkipped()),
                Map.entry("bytesCopied", record.getBytesCopied()),
                Map.entry("bytesSkipped", record.getBytesSkipped()),
                Map.entry("currentPath", record.getCurrentPath() == null ? "" : record.getCurrentPath()),
                Map.entry("errorCode", record.getErrorCode() == null ? "" : record.getErrorCode()),
                Map.entry("errorDetail", record.getErrorDetail() == null ? "" : record.getErrorDetail()),
                Map.entry("createdAt", record.getCreatedAt()),
                Map.entry("updatedAt", record.getUpdatedAt()));
    }
}
