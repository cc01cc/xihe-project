package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.verify;

class WorkspaceEventControllerTest {

    private WorkspaceService workspaceService;
    private WorkspaceEventManager eventManager;
    private WorkspaceEventController controller;

    @BeforeEach
    void setUp() {
        workspaceService = Mockito.mock(WorkspaceService.class);
        eventManager = new WorkspaceEventManager();
        controller = new WorkspaceEventController(workspaceService, eventManager);
        TenantContext.setUserId("user-1");
    }

    @AfterEach
    void tearDown() {
        eventManager.completeWorkspace("ws-1", "test_cleanup");
        TenantContext.clear();
    }

    @Test
    void checksWorkspaceMembershipBeforeOpeningStream() {
        SseEmitter emitter = controller.events("ws-1", null);

        assertNotNull(emitter);
        verify(workspaceService).requireAccessibleWorkspace("ws-1", "user-1");
    }

    @Test
    void rejectsMalformedLastEventId() {
        CpApiException exception = assertThrows(
                CpApiException.class,
                () -> controller.events("ws-1", "not-a-sequence"));

        assertEquals("INVALID_REQUEST", exception.getCode());
        verify(workspaceService).requireAccessibleWorkspace("ws-1", "user-1");
    }
}
