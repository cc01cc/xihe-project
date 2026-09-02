package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Workspace;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class WorkspaceServiceCustomPathTest {

    @Autowired
    private WorkspaceService workspaceService;

    @Test
    void createWorkspace_persistsAndIsDiscoverable() {
        String userId = UUID.randomUUID().toString();
        Workspace ws = workspaceService.createWorkspace("custom-path-test", userId);
        assertNotNull(ws.getId());
        assertEquals("host_directory", ws.getStorageBackend());
        // storageRef is now the workspace id; host path is the Runtime's concern.
        assertEquals(ws.getId(), ws.getStorageRef());
    }
}
