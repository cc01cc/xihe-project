package com.cc01cc.p.xihe.cp.service;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import com.cc01cc.p.xihe.cp.entity.Workspace;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(properties = {"cp.workspace-base-path=/custom/workspace/path"})
@ActiveProfiles("h2")
class WorkspaceServiceCustomPathTest {

    @Autowired
    private WorkspaceService workspaceService;

    @Test
    void createWorkspace_usesConfiguredBasePath() {
        Workspace ws = workspaceService.createWorkspace("custom-path-test", "user-custom");
        assertNotNull(ws.getStoragePath());
        assertTrue(ws.getStoragePath().startsWith("/custom/workspace/path/"),
            "storage path should use the configured base path, got: " + ws.getStoragePath());
    }
}
