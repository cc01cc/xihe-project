package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** Workspace-scoped durable Job projection; execution remains a later adapter concern. */
@RestController
public class WorkspaceJobController {

    private final OperationService operationService;
    private final WorkspaceService workspaceService;

    public WorkspaceJobController(OperationService operationService, WorkspaceService workspaceService) {
        this.operationService = operationService;
        this.workspaceService = workspaceService;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/jobs")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> list(@PathVariable String workspaceId) {
        try {
            workspaceService.requireAccessibleWorkspace(workspaceId, TenantContext.getUserId());
            return ResponseEntity.ok(operationService.listWorkspaceJobs(workspaceId));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
