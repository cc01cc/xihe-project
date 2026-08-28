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
    void createWorkspaceNotifiesRuntime() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces"))
                .willReturn(aResponse().withStatus(200)));

        createdWorkspace = workspaceService.createWorkspace(
                "test-ws-" + UUID.randomUUID().toString().substring(0, 8),
                "test-owner");

        assertNotNull(createdWorkspace.getId());
        assertNotNull(createdWorkspace.getStoragePath());

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces"))
                .withRequestBody(matchingJsonPath("$.workspaceId"))
                .withRequestBody(matchingJsonPath("$.workspacePath"))
                .withRequestBody(matchingJsonPath("$.image")));
    }

    @Test
    void deleteWorkspaceNotifiesRuntime() {
        String wsName = "del-ws-" + UUID.randomUUID().toString().substring(0, 8);

        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces"))
                .willReturn(aResponse().withStatus(200)));
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces/delete"))
                .willReturn(aResponse().withStatus(200)));

        createdWorkspace = workspaceService.createWorkspace(wsName, "test-owner");

        workspaceService.deleteWorkspace(createdWorkspace.getId());

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces/delete"))
                .withRequestBody(matchingJsonPath("$.workspaceId", containing(createdWorkspace.getId())))
                .withRequestBody(matchingJsonPath("$.workspacePath")));

        createdWorkspace = null;
    }

    @Test
    void createWorkspaceSucceedsEvenWhenRuntimeUnavailable() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces"))
                .willReturn(aResponse().withStatus(500)));

        createdWorkspace = workspaceService.createWorkspace(
                "offline-ws-" + UUID.randomUUID().toString().substring(0, 8),
                "test-owner");

        assertNotNull(createdWorkspace.getId());
        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces")));
    }
}
