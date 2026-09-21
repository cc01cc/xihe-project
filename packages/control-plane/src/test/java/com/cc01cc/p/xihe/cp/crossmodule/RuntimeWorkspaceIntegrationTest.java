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
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.util.UUID;
import java.nio.file.Path;

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

    @TempDir
    private Path tempWorkspace;

    @BeforeEach
    void setUp() {
        super.setUp();
    }

    @AfterEach
    void cleanup() {
        // Absolute request counts are asserted with wireMock.verify below, so
        // the request journal must stay scoped to one test.
        wireMock.resetRequests();
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
    void directAttachCreationProbesRuntimeAndIsIdempotent() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe"))
                .withRequestBody(matchingJsonPath("$.storageMode", equalTo("direct_attach")))
                .withRequestBody(matchingJsonPath("$.hostPath", equalTo(tempWorkspace.toString())))
                .withRequestBody(matchingJsonPath("$.executionMode", equalTo("windows-host")))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-host\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"stable\","
                                + "\"executionMode\":\"windows-host\",\"available\":true}")));

        String ownerId = UUID.randomUUID().toString();
        String idempotencyKey = "direct-attach-" + UUID.randomUUID();
        createdWorkspace = workspaceService.createWorkspace(
                "direct-attach", null, ownerId, null, null,
                "direct_attach", tempWorkspace.toString(), "windows-host", idempotencyKey);

        Workspace replay = workspaceService.createWorkspace(
                "direct-attach", null, ownerId, null, null,
                "direct_attach", tempWorkspace.toString(), "windows-host", idempotencyKey);

        assertEquals(createdWorkspace.getId(), replay.getId());
        assertEquals("direct_attach", createdWorkspace.getStorageMode());
        assertEquals(tempWorkspace.toString(), createdWorkspace.getHostPath());
        assertEquals("windows-host", createdWorkspace.getExecutionMode());
        assertTrue(workspaceService.capabilitySnapshot(createdWorkspace).get("available") instanceof Boolean value && value);

        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe"))
                .withRequestBody(matchingJsonPath("$.executionMode", equalTo("windows-mxc")))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-mxc\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"experimental\","
                                + "\"executionMode\":\"windows-mxc\",\"available\":true}")));
        Workspace switched = workspaceService.changeExecutionMode(
                createdWorkspace.getId().toString(), ownerId, false, "windows-mxc");
        assertEquals("windows-mxc", switched.getExecutionMode());
        wireMock.verify(3, postRequestedFor(
                urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe")));
    }

    /**
     * PLAN-0379 T3.7：创建前 probe 失败必须不落 Workspace（fail-closed 503，
     * 且不写库）——创建后的启动失败才保留 Workspace 并投影 blocked。
     */
    @Test
    void directAttachCreationFailsClosedWhenProbeReportsUnavailable() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-mxc\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"experimental\","
                                + "\"executionMode\":\"windows-mxc\",\"available\":false,"
                                + "\"reason\":\"MXC is not installed\"}")));

        String ownerId = UUID.randomUUID().toString();
        com.cc01cc.p.xihe.cp.config.CpApiException error = assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> workspaceService.createWorkspace(
                        "probe-unavailable", null, ownerId, null, null,
                        "direct_attach", tempWorkspace.toString(), "windows-mxc",
                        "probe-unavailable-" + UUID.randomUUID()));
        assertEquals("DIRECT_ATTACH_UNAVAILABLE", error.getCode());
        assertTrue(
                workspaceRepository.findAll().stream()
                        .noneMatch(workspace -> ownerId.equals(workspace.getOwnerId())),
                "a failed probe must not persist a Workspace");
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
    void deleteWorkspaceSucceedsAndDefersCleanupWhenRuntimeUnavailable() {
        // STO-1: the delete transaction commits unconditionally; a failing Runtime
        // cleanup is best-effort and reconciled later by Runtime orphan cleanup.
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces/delete"))
                .willReturn(aResponse().withStatus(500)));

        String ownerId = UUID.randomUUID().toString();
        createdWorkspace = workspaceService.createWorkspace(
                "offline-ws-" + UUID.randomUUID().toString().substring(0, 8), ownerId);
        String workspaceId = createdWorkspace.getId().toString();

        assertDoesNotThrow(() -> workspaceService.deleteWorkspace(workspaceId, ownerId));

        assertTrue(workspaceRepository.findByIdAndDeletedAtIsNull(createdWorkspace.getId()).isEmpty(),
                "DB delete is authoritative even when Runtime cleanup fails");
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
    void materializePassesThroughRuntime409WorkspaceDestroying() {
        // PLAN-0345 T2.4b (decision #11): the destroying-conflict must reach the
        // caller as 409 WORKSPACE_DESTROYING, never collapsed into 502.
        String ownerId = UUID.randomUUID().toString();
        createdWorkspace = workspaceService.createWorkspace("mat409-ws", ownerId);
        String target = createdWorkspace.getId().toString();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces/" + target + "/materialize"))
                .willReturn(aResponse().withStatus(409)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"type\":\"https://xihe.dev/problems/workspace_destroying\","
                                + "\"title\":\"Conflict\",\"status\":409,"
                                + "\"code\":\"WORKSPACE_DESTROYING\","
                                + "\"detail\":\"Workspace " + target + " is being destroyed\"}")));

        String email = "mat409-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        org.springframework.http.ResponseEntity<java.util.Map> reg = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                java.util.Map.of("email", email, "password", TestDataFactory.PASSWORD, "name", "Mat409"),
                java.util.Map.class);
        String memberUserId = userIdOf(email);
        workspaceUserRepository.save(new com.cc01cc.p.xihe.cp.entity.WorkspaceUser(
                target, memberUserId, com.cc01cc.p.xihe.cp.entity.WorkspaceRole.MEMBER));
        String token = (String) reg.getBody().get("accessToken");

        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        // The shared test RestTemplate treats only 5xx as errors, so a 409 comes
        // back as a normal response entity.
        org.springframework.http.ResponseEntity<java.util.Map> response = restTemplate.postForEntity(
                url("/api/v1/workspaces/" + target + "/materialize"),
                new org.springframework.http.HttpEntity<>(java.util.Map.of(), headers),
                java.util.Map.class);
        assertEquals(409, response.getStatusCode().value(),
                "destroying conflict must pass through, not collapse to 502");
        assertNotNull(response.getBody());
        assertEquals("WORKSPACE_DESTROYING", response.getBody().get("code"));
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
    void listWorkspacesReturnsAllActiveMemberships() {
        String email = "list-workspaces-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        org.springframework.http.ResponseEntity<java.util.Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                java.util.Map.of("email", email, "password", TestDataFactory.PASSWORD, "name", "List Workspaces"),
                java.util.Map.class);
        assertEquals(201, registration.getStatusCode().value());
        String token = (String) registration.getBody().get("accessToken");

        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        org.springframework.http.ResponseEntity<java.util.Map> created = restTemplate.postForEntity(
                url("/api/v1/workspaces"),
                new org.springframework.http.HttpEntity<>(java.util.Map.of("name", "Second Workspace"), headers),
                java.util.Map.class);
        assertEquals(201, created.getStatusCode().value());

        org.springframework.http.ResponseEntity<java.util.List> response = restTemplate.exchange(
                url("/api/v1/workspaces"),
                org.springframework.http.HttpMethod.GET,
                new org.springframework.http.HttpEntity<>(headers),
                java.util.List.class);

        assertEquals(200, response.getStatusCode().value());
        assertNotNull(response.getBody());
        assertEquals(2, response.getBody().size());
    }

    @Test
    void workspaceImportCanBeQueuedWithoutSession() {
        wireMock.resetAll();
        wireMock.stubFor(post(urlPathMatching("/internal/v1/runtime/workspaces/.*/imports"))
                .willReturn(aResponse().withStatus(202).withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"running\",\"importId\":\"runtime-import\"}")));
        wireMock.stubFor(get(urlPathMatching("/internal/v1/runtime/workspaces/.*/imports/.*"))
                .willReturn(aResponse().withStatus(200).withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"running\",\"filesCopied\":1}")));
        wireMock.stubFor(post(urlPathMatching("/internal/v1/runtime/workspaces/.*/imports/.*/cancel"))
                .willReturn(aResponse().withStatus(200).withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"cancelled\"}")));
        String email = "workspace-import-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        org.springframework.http.ResponseEntity<java.util.Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                java.util.Map.of("email", email, "password", TestDataFactory.PASSWORD, "name", "Workspace Import"),
                java.util.Map.class);
        assertEquals(201, registration.getStatusCode().value());
        String workspaceId = (String) registration.getBody().get("workspaceId");
        String token = (String) registration.getBody().get("accessToken");

        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        org.springframework.http.ResponseEntity<java.util.Map> accepted = restTemplate.postForEntity(
                url("/api/v1/workspaces/" + workspaceId + "/imports"),
                new org.springframework.http.HttpEntity<>(java.util.Map.of(
                        "sourcePath", "H:\\zeogit\\one",
                        "excludeRules", java.util.List.of("node_modules", "target"),
                        "idempotencyKey", "import-test-1"), headers),
                java.util.Map.class);

        assertEquals(202, accepted.getStatusCode().value());
        assertEquals("running", accepted.getBody().get("status"));
        String importId = (String) accepted.getBody().get("importId");

        org.springframework.http.ResponseEntity<java.util.Map> status = restTemplate.exchange(
                url("/api/v1/workspace-imports/" + importId),
                org.springframework.http.HttpMethod.GET,
                new org.springframework.http.HttpEntity<>(headers),
                java.util.Map.class);
        assertEquals(200, status.getStatusCode().value());
        assertEquals(importId, status.getBody().get("importId"));

        org.springframework.http.ResponseEntity<java.util.Map> cancelled = restTemplate.postForEntity(
                url("/api/v1/workspace-imports/" + importId + "/cancel"),
                new org.springframework.http.HttpEntity<>(java.util.Map.of(), headers),
                java.util.Map.class);
        assertEquals(200, cancelled.getStatusCode().value());
        assertEquals("cancelled", cancelled.getBody().get("status"));
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
