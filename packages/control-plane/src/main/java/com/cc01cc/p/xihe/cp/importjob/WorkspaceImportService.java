package com.cc01cc.p.xihe.cp.importjob;

import com.cc01cc.p.xihe.cp.entity.WorkspaceImport;
import com.cc01cc.p.xihe.cp.repository.WorkspaceImportRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
public class WorkspaceImportService {
    private final WorkspaceImportRepository repository;
    private final WorkspaceService workspaceService;

    public WorkspaceImportService(WorkspaceImportRepository repository, WorkspaceService workspaceService) {
        this.repository = repository;
        this.workspaceService = workspaceService;
    }

    @Transactional
    public WorkspaceImport create(String workspaceId, String ownerId, String sourcePath,
                                  String excludeRules, String idempotencyKey) {
        workspaceService.requireAccessibleWorkspace(workspaceId, ownerId);
        if (sourcePath == null || sourcePath.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "IMPORT_SOURCE_REQUIRED", "sourcePath is required");
        }
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "IMPORT_IDEMPOTENCY_REQUIRED", "idempotencyKey is required");
        }
        OptionalExisting existing = findExisting(ownerId, idempotencyKey);
        if (existing.value != null) return existing.value;
        UUID workspaceUuid = UUID.fromString(workspaceId);
        if (repository.existsActiveByWorkspaceId(workspaceUuid)) {
            throw new CpApiException(HttpStatus.CONFLICT, "IMPORT_ALREADY_ACTIVE", "An import is already active for this workspace");
        }
        return repository.save(new WorkspaceImport(workspaceUuid, ownerId, sourcePath, excludeRules, idempotencyKey));
    }

    @Transactional(readOnly = true)
    public WorkspaceImport get(String importId, String ownerId) {
        return repository.findByIdAndOwnerId(UUID.fromString(importId), ownerId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "IMPORT_NOT_FOUND", "Import not found"));
    }

    @Transactional
    public WorkspaceImport cancel(String importId, String ownerId) {
        WorkspaceImport record = get(importId, ownerId);
        if ("completed".equals(record.getStatus()) || "failed".equals(record.getStatus())) return record;
        record.cancel();
        return repository.save(record);
    }

    @Transactional(readOnly = true)
    public List<WorkspaceImport> list(String workspaceId, String ownerId) {
        workspaceService.requireAccessibleWorkspace(workspaceId, ownerId);
        return repository.findByWorkspaceIdOrderByCreatedAtDesc(UUID.fromString(workspaceId));
    }

    private OptionalExisting findExisting(String ownerId, String idempotencyKey) {
        return new OptionalExisting(repository.findByOwnerIdAndIdempotencyKey(ownerId, idempotencyKey).orElse(null));
    }

    private record OptionalExisting(WorkspaceImport value) {}
}
