package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Session;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * PLAN-0608 C′ (decision #8): the explicit, <em>path-addressed</em> session
 * creation surface. Unlike {@code POST /api/v1/sessions} it never depends on
 * "what the tab happened to have selected", which is what made the UI path
 * unusable for multi-workspace members (review P0-1).
 *
 * <p>Conflicts and ambiguity are owned by {@link SessionCreationService}; this
 * controller only maps HTTP to that single decision point.
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/sessions")
public class WorkspaceSessionController {

    private final SessionCreationService sessionCreationService;

    public WorkspaceSessionController(SessionCreationService sessionCreationService) {
        this.sessionCreationService = sessionCreationService;
    }

    @PostMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> create(@PathVariable String workspaceId,
                                    @RequestBody(required = false) SessionController.CreateSessionRequest request,
                                    @RequestHeader(value = "X-Workspace-Id", required = false) String workspaceHeader) {
        try {
            Session session = sessionCreationService.create(TenantContext.getUserId(), workspaceId, workspaceHeader,
                    SessionController.paramsFrom(request));
            return ResponseEntity.status(HttpStatus.CREATED).body(SessionController.toView(session));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}

