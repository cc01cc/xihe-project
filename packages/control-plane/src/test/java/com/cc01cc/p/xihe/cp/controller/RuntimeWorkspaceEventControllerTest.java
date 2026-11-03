package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.event.WorkspaceEvent;
import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class RuntimeWorkspaceEventControllerTest {

    @Test
    void acceptsRuntimeEventAfterActiveWorkspaceCheck() {
        WorkspaceService workspaceService = Mockito.mock(WorkspaceService.class);
        WorkspaceEventManager eventManager = Mockito.mock(WorkspaceEventManager.class);
        RuntimeWorkspaceEventController controller =
                new RuntimeWorkspaceEventController(workspaceService, eventManager);
        RuntimeWorkspaceEventController.PublishWorkspaceEventRequest request =
                new RuntimeWorkspaceEventController.PublishWorkspaceEventRequest(
                        "file_changed", "src/main.ts", "modified", "runtime", null, null, null);
        when(eventManager.publish("ws-1", null, "file_changed", "src/main.ts", "modified", "runtime",
                null, null))
                .thenReturn(new WorkspaceEvent("ws-1", "ws-1", 7L, "file_changed", "src/main.ts",
                        "modified", "runtime", null, null));

        ResponseEntity<?> response = controller.publish("ws-1", request);

        verify(workspaceService).requireActiveWorkspace("ws-1");
        verify(eventManager).publish(eq("ws-1"), isNull(), eq("file_changed"), eq("src/main.ts"),
                eq("modified"), eq("runtime"), isNull(), isNull());
        assertEquals(202, response.getStatusCode().value());
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertTrue((Boolean) body.get("accepted"));
        assertEquals(7L, body.get("sequence"));
    }

    /**
     * PLAN-0639 M7 (VM14): the Runtime attributes a host event to the deepest
     * declared root and sends that root on the wire; dropping it here (the pre-M7
     * shape) made every multi-root file event arrive labelled with the workspace id.
     */
    @Test
    void forwardsTheRuntimeRootAttribution() {
        WorkspaceService workspaceService = Mockito.mock(WorkspaceService.class);
        WorkspaceEventManager eventManager = Mockito.mock(WorkspaceEventManager.class);
        RuntimeWorkspaceEventController controller =
                new RuntimeWorkspaceEventController(workspaceService, eventManager);
        RuntimeWorkspaceEventController.PublishWorkspaceEventRequest request =
                new RuntimeWorkspaceEventController.PublishWorkspaceEventRequest(
                        "file_changed", "notes/a.md", "modified", "runtime", null, null, "root-b");
        when(eventManager.publish("ws-1", "root-b", "file_changed", "notes/a.md", "modified",
                "runtime", null, null))
                .thenReturn(new WorkspaceEvent("ws-1", "root-b", 9L, "file_changed", "notes/a.md",
                        "modified", "runtime", null, null));

        controller.publish("ws-1", request);

        verify(eventManager).publish(eq("ws-1"), eq("root-b"), eq("file_changed"), eq("notes/a.md"),
                eq("modified"), eq("runtime"), isNull(), isNull());
    }
}
