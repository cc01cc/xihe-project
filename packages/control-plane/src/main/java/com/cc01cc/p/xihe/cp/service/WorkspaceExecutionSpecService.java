package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceExecutionSpec;
import com.cc01cc.p.xihe.cp.repository.WorkspaceExecutionSpecRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.util.SandboxSpecHashUtil;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;

@Service
public class WorkspaceExecutionSpecService {

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceExecutionSpecRepository specRepository;

    public WorkspaceExecutionSpecService(WorkspaceRepository workspaceRepository,
                                         WorkspaceExecutionSpecRepository specRepository) {
        this.workspaceRepository = workspaceRepository;
        this.specRepository = specRepository;
    }

    @Transactional
    public WorkspaceExecutionSpec createExecutionSpec(
            String workspaceId, String sandboxSpecJson, String actor, String reason) {
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "actor is required");
        }
        if (reason == null || reason.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "reason is required");
        }
        if (sandboxSpecJson == null || sandboxSpecJson.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sandboxSpec is required");
        }

        // We intentionally use a non-locking find here. The caller (AuthService /
        // WorkspaceService) already holds a pessimistic lock on either the user row
        // or the workspace row within the same transaction; re-locking with
        // findByIdForUpdate after a save() can produce a stale entity copy and
        // triggers StaleObjectStateException.
        Workspace workspace = workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId)
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found"));
        int generation = workspace.getGeneration() == null ? 1 : workspace.getGeneration() + 1;
        String hash = SandboxSpecHashUtil.hash(sandboxSpecJson);

        WorkspaceExecutionSpec spec = new WorkspaceExecutionSpec();
        spec.setWorkspaceId(workspaceId);
        spec.setGeneration(generation);
        spec.setSandboxSpecHash(hash);
        spec.setSandboxSpec(sandboxSpecJson);
        spec.setStorageBackend(nonBlankOrDefault(workspace.getStorageBackend(), "host_directory"));
        spec.setStorageRef(nonBlankOrDefault(workspace.getStorageRef(), workspaceId));
        spec.setActor(actor);
        spec.setReason(reason);
        specRepository.save(spec);

        workspace.setGeneration(generation);
        workspace.setSandboxSpecHash(hash);
        workspace.setSandboxSpec(sandboxSpecJson);
        // saveAndFlush forces the row to leave the session state with the new generation
        // before downstream readers observe the workspace; this also prevents
        // StaleObjectStateException when the workspace was loaded earlier in the
        // same transaction.
        workspaceRepository.saveAndFlush(workspace);
        return spec;
    }

    @Transactional(readOnly = true)
    public WorkspaceExecutionSpec findCurrentExecutionSpec(String workspaceId) {
        workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId)
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found"));
        return specRepository.findTopByWorkspaceIdOrderByGenerationDesc(workspaceId)
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND,
                        "WORKSPACE_EXECUTION_SPEC_NOT_FOUND",
                        "Workspace execution spec not found"));
    }

    @Transactional(readOnly = true)
    public Map<String, Object> currentSummary(String workspaceId) {
        WorkspaceExecutionSpec spec = findCurrentExecutionSpec(workspaceId);
        return Map.of(
                "generation", spec.getGeneration(),
                "sandboxSpecHash", spec.getSandboxSpecHash(),
                "storageBackend", spec.getStorageBackend(),
                "storageRef", spec.getStorageRef());
    }

    private String nonBlankOrDefault(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }
}
