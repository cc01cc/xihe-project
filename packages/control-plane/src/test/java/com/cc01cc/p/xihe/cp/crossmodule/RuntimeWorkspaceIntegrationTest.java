package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static org.junit.jupiter.api.Assertions.*;

import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.util.UUID;

class RuntimeWorkspaceIntegrationTest extends AbstractWireMockTest {

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private WorkspaceService workspaceService;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    private Workspace createdWorkspace;

    @BeforeEach
    void setUp() {
        super.setUp();
    }

    @AfterEach
    void cleanup() {
        if (createdWorkspace != null) {
            workspaceUserRepository.deleteAll(
                    workspaceUserRepository.findByIdWorkspaceId(createdWorkspace.getId()));
            workspaceRepository.deleteById(createdWorkspace.getId());
            createdWorkspace = null;
        }
    }

    @Test
    void createWorkspaceDoesNotCallRuntime() {
        // Lazy workspace execution: CP only persists metadata; the Runtime
        // materializes the Sandbox when it fetches the WorkspaceExecutionSpec.
        createdWorkspace = workspaceService.createWorkspace(
                "test-ws-" + UUID.randomUUID().toString().substring(0, 8),
                UUID.randomUUID().toString());

        assertNotNull(createdWorkspace.getId());
        assertEquals(createdWorkspace.getId(), createdWorkspace.getStorageRef());
        assertEquals("host_directory", createdWorkspace.getStorageBackend());

        wireMock.verify(0, postRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces")));
    }

    @Test
    void deleteWorkspaceNotifiesRuntime() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces/delete"))
                .willReturn(aResponse().withStatus(200)));

        String ownerId = UUID.randomUUID().toString();
        createdWorkspace = workspaceService.createWorkspace(
                "del-ws-" + UUID.randomUUID().toString().substring(0, 8), ownerId);

        workspaceService.deleteWorkspace(createdWorkspace.getId(), ownerId);

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces/delete"))
                .withRequestBody(matchingJsonPath("$.workspaceId", containing(createdWorkspace.getId())))
                .withRequestBody(matchingJsonPath("$.storageRef", containing(createdWorkspace.getId()))));

        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(createdWorkspace.getId()).isEmpty());
    }

    @Test
    void deleteWorkspaceReturnsStableFailureWhenRuntimeUnavailable() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces/delete"))
                .willReturn(aResponse().withStatus(500)));

        String ownerId = UUID.randomUUID().toString();
        createdWorkspace = workspaceService.createWorkspace(
                "offline-ws-" + UUID.randomUUID().toString().substring(0, 8), ownerId);

        com.cc01cc.p.xihe.cp.config.CpApiException exception = assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> workspaceService.deleteWorkspace(createdWorkspace.getId(), ownerId));

        assertEquals("RUNTIME_CLEANUP_FAILED", exception.getCode());
        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(createdWorkspace.getId()).isPresent());
        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces/delete")));
    }
}
