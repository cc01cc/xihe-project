package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/** Read-only Run Trace endpoint; authorization and projection live in the service. */
@RestController
public class RunTraceController {

    private final RunTraceReadService runTraceReadService;

    public RunTraceController(RunTraceReadService runTraceReadService) {
        this.runTraceReadService = runTraceReadService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/chat/runs/{runId}/trace")
    public ResponseEntity<?> getTrace(@PathVariable String runId,
                                      @RequestParam(required = false) String cursor,
                                      @RequestParam(required = false) String limit) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        UUID runUuid;
        try {
            runUuid = UUID.fromString(runId);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND,
                    "RUN_NOT_FOUND", "Chat run not found");
        }
        try {
            return ResponseEntity.ok(runTraceReadService.getTrace(
                    runUuid, userId, workspaceId, cursor, limit));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
