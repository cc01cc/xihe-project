package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class WorkspaceServiceTest {

    @Autowired
    private WorkspaceService workspaceService;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.UserRepository userRepository;

    @Test
    void createWorkspace_persistsToDb() {
        String userId = java.util.UUID.randomUUID().toString();
        Workspace ws = workspaceService.createWorkspace("persist-test", userId);
        assertNotNull(workspaceRepository.findByIdAndDeletedAtIsNull(ws.getId()).orElse(null));
        assertEquals("persist-test", ws.getName());
    }

    @Test
    void createWorkspace_secondCallForSameOwnerReturns409() {
        String userId = java.util.UUID.randomUUID().toString();
        workspaceService.createWorkspace("only-one", userId);
        com.cc01cc.p.xihe.cp.config.CpApiException e = assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> workspaceService.createWorkspace("again", userId));
        assertEquals("WORKSPACE_ALREADY_EXISTS", e.getCode());
    }

    @Test
    void getWorkspace_returnsWorkspace() {
        String userId = java.util.UUID.randomUUID().toString();
        Workspace ws = workspaceService.createWorkspace("get-test", userId);
        Workspace found = workspaceService.getWorkspace(ws.getId());
        assertEquals(ws.getId(), found.getId());
    }

    @Test
    void getWorkspace_throwsOnNotFound() {
        assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> workspaceService.getWorkspace("nonexistent"));
    }

    @Test
    void createWorkspace_assignsOwnerRole() {
        String userId = java.util.UUID.randomUUID().toString();
        Workspace ws = workspaceService.createWorkspace("role-test", userId);
        assertTrue(workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(ws.getId(), userId)
                .map(wu -> wu.getRole() == WorkspaceRole.OWNER)
                .orElse(false));
    }

    @Test
    void deleteWorkspace_runtimeUnavailableLeavesWorkspaceActive() {
        String userId = java.util.UUID.randomUUID().toString();
        Workspace ws = workspaceService.createWorkspace("delete-test", userId);
        com.cc01cc.p.xihe.cp.config.CpApiException e = assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> workspaceService.deleteWorkspace(ws.getId(), userId));
        assertEquals("RUNTIME_CLEANUP_FAILED", e.getCode());
        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(ws.getId()).isPresent(),
                "Failed Runtime cleanup must not report a logically deleted workspace");
    }

    @Test
    void getOrCreateDefault_returnsExisting() {
        String suffix = java.util.UUID.randomUUID().toString().substring(0, 8);
        com.cc01cc.p.xihe.cp.entity.User user = userRepository.save(
                new com.cc01cc.p.xihe.cp.entity.User(
                        "user-default-" + suffix + "@test.com", "hash",
                        com.cc01cc.p.xihe.cp.entity.UserRole.USER, "Default"));
        Workspace first = workspaceService.createWorkspace("default-test", user.getId());
        Workspace second = workspaceService.getOrCreateDefaultWorkspace(user.getId());
        assertEquals(first.getId(), second.getId());
    }

    @Test
    void createWorkspace_profilePassthroughAndImageAllowlist() {
        String userId = java.util.UUID.randomUUID().toString();
        Workspace ws = workspaceService.createWorkspace(
                "strict-test", null, userId, "STRICT", null);
        assertNotNull(workspaceRepository.findByIdAndDeletedAtIsNull(ws.getId()).orElse(null));
    }

    @Test
    void createWorkspace_invalidProfileReturns400() {
        String userId = java.util.UUID.randomUUID().toString();
        com.cc01cc.p.xihe.cp.config.CpApiException e = assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> workspaceService.createWorkspace("bad-profile", null, userId, "containerd", null));
        assertEquals("INVALID_PROFILE", e.getCode());
        assertEquals(org.springframework.http.HttpStatus.BAD_REQUEST, e.getStatus());
    }

    @Test
    void createWorkspace_disallowedImageReturns400() {
        String userId = java.util.UUID.randomUUID().toString();
        com.cc01cc.p.xihe.cp.config.CpApiException e = assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> workspaceService.createWorkspace(
                        "bad-image", null, userId, "coding", "evil/image:latest"));
        assertEquals("INVALID_IMAGE", e.getCode());
        assertEquals(org.springframework.http.HttpStatus.BAD_REQUEST, e.getStatus());
    }
}
