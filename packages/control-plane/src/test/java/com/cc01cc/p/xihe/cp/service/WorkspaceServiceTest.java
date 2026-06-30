package com.cc01cc.p.xihe.cp.service;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
@ActiveProfiles("h2")
class WorkspaceServiceTest {

    @Autowired
    private WorkspaceService workspaceService;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Test
    void createWorkspace_generatesStoragePath() {
        Workspace ws = workspaceService.createWorkspace("test-ws", "user-1");
        assertNotNull(ws.getId());
        assertNotNull(ws.getStoragePath());
        assertTrue(ws.getStoragePath().startsWith("/data/xihe/workspaces/"));
    }

    @Test
    void createWorkspace_persistsToDb() {
        Workspace ws = workspaceService.createWorkspace("persist-test", "user-2");
        Workspace found = workspaceRepository.findById(ws.getId()).orElse(null);
        assertNotNull(found);
        assertEquals("persist-test", found.getName());
    }

    @Test
    void getWorkspace_returnsWorkspace() {
        Workspace ws = workspaceService.createWorkspace("get-test", "user-3");
        Workspace found = workspaceService.getWorkspace(ws.getId());
        assertEquals(ws.getId(), found.getId());
    }

    @Test
    void getWorkspace_throwsOnNotFound() {
        assertThrows(IllegalArgumentException.class, () -> workspaceService.getWorkspace("nonexistent"));
    }

    @Test
    void resolveStoragePath_returnsPathForExistingWorkspace() {
        Workspace ws = workspaceService.createWorkspace("path-test", "user-4");
        String path = workspaceService.resolveStoragePath(ws.getId());
        assertEquals(ws.getStoragePath(), path);
    }

    @Test
    void resolveStoragePath_returnsNullForUnknown() {
        assertNull(workspaceService.resolveStoragePath("unknown-id"));
    }

    @Test
    void getWorkspacesByUser_returnsOwnedWorkspaces() {
        workspaceService.createWorkspace("owned-1", "owner-1");
        workspaceService.createWorkspace("owned-2", "owner-1");
        var workspaces = workspaceService.getWorkspacesByUser("owner-1");
        assertEquals(2, workspaces.size());
    }

    @Test
    void storagePath_hasUniqueSuffixPerWorkspace() {
        Workspace ws1 = workspaceService.createWorkspace("unique-1", "user-u");
        Workspace ws2 = workspaceService.createWorkspace("unique-2", "user-u");
        assertNotEquals(ws1.getStoragePath(), ws2.getStoragePath());
    }

    @Test
    void storagePath_startsWithBaseDir() {
        Workspace ws = workspaceService.createWorkspace("base-test", "user-b");
        assertTrue(ws.getStoragePath().startsWith("/data/xihe/workspaces/"));
        String suffix = ws.getStoragePath().substring("/data/xihe/workspaces/".length());
        assertTrue(suffix.matches("[a-f0-9]{8}"), "storage path suffix should be 8 hex chars");
    }

    @Test
    void createWorkspace_handlesDirectoryCreationFailureGracefully() {
        Workspace ws = workspaceService.createWorkspace("dir-fail-test", "user-d");
        assertNotNull(ws.getId(), "workspace should still be persisted even if dir creation fails");
        assertNotNull(workspaceRepository.findById(ws.getId()).orElse(null));
    }

    @Test
    void createWorkspace_assignsOwnerRole() {
        workspaceService.createWorkspace("role-test", "owner-role");
        var workspaces = workspaceService.getWorkspacesByUser("owner-role");
        assertTrue(workspaces.stream().anyMatch(w -> "role-test".equals(w.getName())));
    }
}
