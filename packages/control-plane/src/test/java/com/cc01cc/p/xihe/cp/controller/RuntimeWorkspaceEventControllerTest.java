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
                        "file_changed", "src/main.ts", "modified", "runtime", null, null);
        when(eventManager.publish("ws-1", "file_changed", "src/main.ts", "modified", "runtime", null, null))
                .thenReturn(new WorkspaceEvent("ws-1", 7L, "file_changed", "src/main.ts", "modified", "runtime", null, null));

        ResponseEntity<?> response = controller.publish("ws-1", request);

        verify(workspaceService).requireActiveWorkspace("ws-1");
        verify(eventManager).publish(eq("ws-1"), eq("file_changed"), eq("src/main.ts"), eq("modified"), eq("runtime"), eq(null), eq(null));
        assertEquals(202, response.getStatusCode().value());
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertTrue((Boolean) body.get("accepted"));
        assertEquals(7L, body.get("sequence"));
    }
}
