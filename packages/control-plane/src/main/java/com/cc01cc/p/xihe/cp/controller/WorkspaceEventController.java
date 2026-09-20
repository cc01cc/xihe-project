package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/v1/workspaces")
public class WorkspaceEventController {

    private final WorkspaceService workspaceService;
    private final WorkspaceEventManager eventManager;

    public WorkspaceEventController(WorkspaceService workspaceService, WorkspaceEventManager eventManager) {
        this.workspaceService = workspaceService;
        this.eventManager = eventManager;
    }

    @GetMapping(path = "/{workspaceId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public SseEmitter events(
            @PathVariable String workspaceId,
            @RequestHeader(value = "Last-Event-ID", required = false) String lastEventId) {
        String userId = TenantContext.getUserId();
        workspaceService.requireAccessibleWorkspace(workspaceId, userId);
        return eventManager.subscribe(workspaceId, parseLastEventId(lastEventId));
    }

    private long parseLastEventId(String value) {
        if (value == null || value.isBlank()) return 0L;
        try {
            long parsed = Long.parseLong(value);
            if (parsed < 0) throw new NumberFormatException("negative");
            return parsed;
        } catch (NumberFormatException error) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Last-Event-ID must be a non-negative integer");
        }
    }
}
