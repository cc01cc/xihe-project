package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.event.WorkspaceEvent;
import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** Runtime-to-CP ingress for normalized Workspace events. */
@RestController
@RequestMapping("/internal/v1/runtime/workspaces")
public class RuntimeWorkspaceEventController {

    private final WorkspaceService workspaceService;
    private final WorkspaceEventManager eventManager;

    public RuntimeWorkspaceEventController(
            WorkspaceService workspaceService,
            WorkspaceEventManager eventManager) {
        this.workspaceService = workspaceService;
        this.eventManager = eventManager;
    }

    @PostMapping("/{workspaceId}/events")
    public ResponseEntity<?> publish(
            @PathVariable String workspaceId,
            @RequestBody PublishWorkspaceEventRequest request) {
        workspaceService.requireActiveWorkspace(workspaceId);
        if (request == null || request.kind() == null || request.source() == null) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST",
                    "kind and source are required");
        }
        WorkspaceEvent event = eventManager.publish(
                workspaceId,
                request.kind(),
                request.path(),
                request.changeType(),
                request.source(),
                request.snapshotVersion(),
                request.status());
        return ResponseEntity.accepted().body(Map.of(
                "accepted", true,
                "workspaceId", workspaceId,
                "sequence", event.sequence()));
    }

    public record PublishWorkspaceEventRequest(
            String kind,
            String path,
            String changeType,
            String source,
            String snapshotVersion,
            String status) {
    }
}
