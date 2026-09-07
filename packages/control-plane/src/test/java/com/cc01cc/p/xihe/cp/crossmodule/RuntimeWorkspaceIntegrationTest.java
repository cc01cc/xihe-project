package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static org.junit.jupiter.api.Assertions.*;

import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
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
        assertEquals(createdWorkspace.getId().toString(), createdWorkspace.getStorageRef());
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

        workspaceService.deleteWorkspace(createdWorkspace.getId().toString(), ownerId);

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces/delete"))
                .withRequestBody(matchingJsonPath("$.workspaceId", containing(createdWorkspace.getId().toString())))
                .withRequestBody(matchingJsonPath("$.storageRef", containing(createdWorkspace.getId().toString()))));

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
                () -> workspaceService.deleteWorkspace(createdWorkspace.getId().toString(), ownerId));

        assertEquals("RUNTIME_CLEANUP_FAILED", exception.getCode());
        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(createdWorkspace.getId()).isPresent());
        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces/delete")));
    }

    @Test
    void materializeProxiesToRuntimeAndReturns202() {
        String ownerId = UUID.randomUUID().toString();
        createdWorkspace = workspaceService.createWorkspace("mat-ws", ownerId);
        String target = createdWorkspace.getId().toString();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces/" + target + "/materialize"))
                .willReturn(aResponse().withStatus(202)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"workspaceId\":\"" + target + "\",\"state\":\"materializing\"}")));

        // Register a real user, then grant them membership to the workspace under test.
        String email = "mat-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        org.springframework.http.ResponseEntity<java.util.Map> reg = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                java.util.Map.of("email", email, "password", TestDataFactory.PASSWORD, "name", "Mat"),
                java.util.Map.class);
        assertEquals(201, reg.getStatusCode().value());
        String memberUserId = userIdOf(email);
        workspaceUserRepository.save(new com.cc01cc.p.xihe.cp.entity.WorkspaceUser(
                target, memberUserId, com.cc01cc.p.xihe.cp.entity.WorkspaceRole.MEMBER));
        String token = (String) reg.getBody().get("accessToken");

        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        org.springframework.http.ResponseEntity<java.util.Map> response = restTemplate.postForEntity(
                url("/api/v1/workspaces/" + target + "/materialize"),
                new org.springframework.http.HttpEntity<>(java.util.Map.of(), headers),
                java.util.Map.class);

        assertEquals(202, response.getStatusCode().value());
        assertNotNull(response.getBody());
        assertEquals("materializing", response.getBody().get("state"));
        wireMock.verify(postRequestedFor(
                urlEqualTo("/internal/v1/runtime/workspaces/" + target + "/materialize")));
    }

    @Test
    void materializeRejectsForeignWorkspaceWith404() {
        String token = registerAndLogin();
        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        org.springframework.http.ResponseEntity<java.util.Map> response = restTemplate.postForEntity(
                url("/api/v1/workspaces/00000000-0000-0000-0000-000000000000/materialize"),
                new org.springframework.http.HttpEntity<>(java.util.Map.of(), headers),
                java.util.Map.class);
        assertEquals(404, response.getStatusCode().value());
        assertEquals("WORKSPACE_NOT_FOUND", response.getBody().get("code"));
    }

    @Test
    void materializeReturns502WhenRuntimeUnreachable() {
        String ownerId = UUID.randomUUID().toString();
        createdWorkspace = workspaceService.createWorkspace("mat502-ws", ownerId);
        String target = createdWorkspace.getId().toString();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces/" + target + "/materialize"))
                .willReturn(aResponse().withStatus(500)));

        String email = "mat502-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        org.springframework.http.ResponseEntity<java.util.Map> reg = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                java.util.Map.of("email", email, "password", TestDataFactory.PASSWORD, "name", "Mat502"),
                java.util.Map.class);
        String memberUserId = userIdOf(email);
        workspaceUserRepository.save(new com.cc01cc.p.xihe.cp.entity.WorkspaceUser(
                target, memberUserId, com.cc01cc.p.xihe.cp.entity.WorkspaceRole.MEMBER));
        String token = (String) reg.getBody().get("accessToken");

        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        // The shared test RestTemplate throws on 5xx; assert on the caught status instead.
        try {
            restTemplate.postForEntity(
                    url("/api/v1/workspaces/" + target + "/materialize"),
                    new org.springframework.http.HttpEntity<>(java.util.Map.of(), headers),
                    java.util.Map.class);
            fail("expected 502 RUNTIME_UNAVAILABLE");
        } catch (org.springframework.web.client.HttpServerErrorException e) {
            assertEquals(502, e.getStatusCode().value());
            assertTrue(e.getResponseBodyAsString().contains("RUNTIME_UNAVAILABLE"));
        }
    }

    @Test
    void createWorkspaceReturnsFlatWorkspaceJson() {
        String email = "create-shape-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        org.springframework.http.ResponseEntity<java.util.Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                java.util.Map.of("email", email, "password", TestDataFactory.PASSWORD, "name", "Create Shape"),
                java.util.Map.class);
        assertEquals(201, registration.getStatusCode().value());
        String ownerId = userIdOf(email);
        String existingWorkspaceId = (String) registration.getBody().get("workspaceId");
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces/delete"))
                .willReturn(aResponse().withStatus(200)));
        workspaceService.deleteWorkspace(existingWorkspaceId, ownerId);

        String token = (String) registration.getBody().get("accessToken");
        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        org.springframework.http.ResponseEntity<java.util.Map> response = restTemplate.postForEntity(
                url("/api/v1/workspaces"),
                new org.springframework.http.HttpEntity<>(java.util.Map.of(
                        "name", "Created Workspace", "profile", "strict"), headers),
                java.util.Map.class);

        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        assertTrue(response.getBody().get("id") instanceof String);
        assertEquals("Created Workspace", response.getBody().get("name"));
        assertFalse(response.getBody().containsKey("body"), "Response must not nest ResponseEntity as body");
        createdWorkspace = workspaceRepository.findByIdAndDeletedAtIsNull(
                UUID.fromString((String) response.getBody().get("id"))).orElseThrow();
    }

    @Test
    void environmentUsesPerWorkspaceStatusInsteadOfGlobalHeartbeat() {
        String email = "env-status-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        org.springframework.http.ResponseEntity<java.util.Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                java.util.Map.of("email", email, "password", TestDataFactory.PASSWORD, "name", "Env Status"),
                java.util.Map.class);
        assertEquals(201, registration.getStatusCode().value());
        String workspaceId = (String) registration.getBody().get("workspaceId");
        createdWorkspace = workspaceRepository.findByIdAndDeletedAtIsNull(UUID.fromString(workspaceId)).orElseThrow();
        String token = (String) registration.getBody().get("accessToken");

        org.springframework.http.HttpHeaders internalHeaders = new org.springframework.http.HttpHeaders();
        internalHeaders.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        internalHeaders.setBearerAuth("dev-token-not-secure");
        restTemplate.postForEntity(
                url("/internal/v1/runtime/heartbeat"),
                new org.springframework.http.HttpEntity<>(java.util.Map.of("deviceId", "device-global", "status", "ready"), internalHeaders),
                java.util.Map.class);
        wireMock.stubFor(get(urlEqualTo("/internal/v1/runtime/workspaces/" + workspaceId + "/status"))
                .willReturn(aResponse().withStatus(404)));

        org.springframework.http.HttpHeaders userHeaders = new org.springframework.http.HttpHeaders();
        userHeaders.setBearerAuth(token);
        org.springframework.http.ResponseEntity<java.util.Map> response = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/environment"),
                org.springframework.http.HttpMethod.GET,
                new org.springframework.http.HttpEntity<>(userHeaders),
                java.util.Map.class);

        assertEquals(200, response.getStatusCode().value());
        assertEquals("unbound", response.getBody().get("status"));
        assertEquals("unbound", ((java.util.Map<?, ?>) response.getBody().get("runtime")).get("status"));
    }

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.UserRepository userRepository;

    private String userIdOf(String email) {
        return userRepository.findByEmail(email)
                .orElseThrow(() -> new AssertionError("registered user not found: " + email))
                .getId().toString();
    }
}
