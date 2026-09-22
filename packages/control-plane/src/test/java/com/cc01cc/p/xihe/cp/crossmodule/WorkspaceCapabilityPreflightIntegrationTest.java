package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.HttpServerErrorException;

import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0384 T1.3/V2: the public capability preflight route plus the reason
 * fidelity of the existing environment capability snapshot.
 *
 * <p>A reachable Runtime that reports {@code available:false} is a valid
 * {@code 200} carrying its {@code reason}; only an unreachable Runtime or an
 * invalid JSON body collapses into {@code 502 RUNTIME_UNAVAILABLE}.
 */
class WorkspaceCapabilityPreflightIntegrationTest extends AbstractWireMockTest {

    private static final String PROBE_PATH =
            "/internal/v1/runtime/capabilities/direct-attach/probe";

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private WorkspaceService workspaceService;

    @AfterEach
    void cleanup() {
        wireMock.resetRequests();
    }

    @Test
    void preflightDefaultsStorageModeAndPassesThroughTheRuntimeSnapshot() {
        wireMock.stubFor(post(urlEqualTo(PROBE_PATH))
                .withRequestBody(matchingJsonPath("$.storageMode", equalTo("direct_attach")))
                .withRequestBody(matchingJsonPath("$.hostPath", equalTo("C:/work/repo")))
                .withRequestBody(matchingJsonPath("$.executionMode", equalTo("windows-mxc")))
                .willReturn(aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-mxc\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"experimental\","
                                + "\"executionMode\":\"windows-mxc\",\"available\":true}")));

        String token = registerAndLogin();
        ResponseEntity<Map> response = restTemplate.postForEntity(
                url("/api/v1/workspaces/capabilities/preflight"),
                entityWithAuth(Map.of("hostPath", "C:/work/repo", "executionMode", "windows-mxc"), token),
                Map.class);

        assertEquals(200, response.getStatusCode().value());
        Map<?, ?> body = response.getBody();
        assertNotNull(body);
        assertEquals("v1", body.get("contractVersion"));
        assertEquals("windows-mxc", body.get("backendKind"));
        assertEquals("builtin", body.get("backendRevision"));
        assertEquals("experimental", body.get("maturity"));
        assertEquals("windows-mxc", body.get("executionMode"));
        assertEquals(true, body.get("available"));
        assertNotNull(body.get("checkedAt"), "preflight must record the CP read timestamp");
        assertFalse(body.containsKey("reason"));
        wireMock.verify(postRequestedFor(urlEqualTo(PROBE_PATH)));
    }

    @Test
    void preflightKeepsTheRuntimeReasonWhenTheBackendIsUnavailable() {
        wireMock.stubFor(post(urlEqualTo(PROBE_PATH))
                .willReturn(aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-mxc\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"experimental\","
                                + "\"executionMode\":\"windows-mxc\",\"available\":false,"
                                + "\"reason\":\"MXC_EXECUTABLE_MISSING\"}")));

        String token = registerAndLogin();
        ResponseEntity<Map> response = restTemplate.postForEntity(
                url("/api/v1/workspaces/capabilities/preflight"),
                entityWithAuth(Map.of(
                        "storageMode", "direct_attach",
                        "hostPath", "C:/work/repo",
                        "executionMode", "windows-mxc"), token),
                Map.class);

        assertEquals(200, response.getStatusCode().value(),
                "available:false is a valid preflight result, not an error");
        Map<?, ?> body = response.getBody();
        assertNotNull(body);
        assertEquals(false, body.get("available"));
        assertEquals("MXC_EXECUTABLE_MISSING", body.get("reason"));
        assertNotNull(body.get("checkedAt"));
    }

    @Test
    void preflightMapsAnUnreachableRuntimeTo502() {
        wireMock.stubFor(post(urlEqualTo(PROBE_PATH))
                .willReturn(aResponse().withStatus(500)));

        String token = registerAndLogin();
        try {
            restTemplate.postForEntity(
                    url("/api/v1/workspaces/capabilities/preflight"),
                    entityWithAuth(Map.of("hostPath", "C:/work/repo", "executionMode", "windows-host"), token),
                    Map.class);
            fail("expected 502 RUNTIME_UNAVAILABLE");
        } catch (HttpServerErrorException e) {
            assertEquals(502, e.getStatusCode().value());
            assertTrue(e.getResponseBodyAsString().contains("RUNTIME_UNAVAILABLE"));
        }
    }

    @Test
    void preflightMapsInvalidRuntimeJsonTo502() {
        wireMock.stubFor(post(urlEqualTo(PROBE_PATH))
                .willReturn(aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{not-json")));

        String token = registerAndLogin();
        try {
            restTemplate.postForEntity(
                    url("/api/v1/workspaces/capabilities/preflight"),
                    entityWithAuth(Map.of("hostPath", "C:/work/repo", "executionMode", "windows-host"), token),
                    Map.class);
            fail("expected 502 RUNTIME_UNAVAILABLE");
        } catch (HttpServerErrorException e) {
            assertEquals(502, e.getStatusCode().value());
            assertTrue(e.getResponseBodyAsString().contains("RUNTIME_UNAVAILABLE"));
        }
    }

    @Test
    void preflightRejectsIncompatibleStorageAndExecutionModes() {
        String token = registerAndLogin();

        ResponseEntity<Map> managedImport = restTemplate.postForEntity(
                url("/api/v1/workspaces/capabilities/preflight"),
                entityWithAuth(Map.of(
                        "storageMode", "managed_import",
                        "executionMode", "docker"), token),
                Map.class);
        assertEquals(400, managedImport.getStatusCode().value());
        assertNotNull(managedImport.getBody());
        assertEquals("INVALID_STORAGE_MODE", managedImport.getBody().get("code"));

        ResponseEntity<Map> docker = restTemplate.postForEntity(
                url("/api/v1/workspaces/capabilities/preflight"),
                entityWithAuth(Map.of(
                        "storageMode", "direct_attach",
                        "hostPath", "C:/work/repo",
                        "executionMode", "docker"), token),
                Map.class);
        assertEquals(400, docker.getStatusCode().value());
        assertNotNull(docker.getBody());
        assertEquals("INVALID_EXECUTION_MODE", docker.getBody().get("code"));

        ResponseEntity<Map> missingPath = restTemplate.postForEntity(
                url("/api/v1/workspaces/capabilities/preflight"),
                entityWithAuth(Map.of("executionMode", "windows-host"), token),
                Map.class);
        assertEquals(400, missingPath.getStatusCode().value());
        assertNotNull(missingPath.getBody());
        assertEquals("INVALID_REQUEST", missingPath.getBody().get("code"));

        wireMock.verify(0, postRequestedFor(urlEqualTo(PROBE_PATH)));
    }

    /**
     * Requirement 3: the environment capability snapshot must keep the Runtime
     * reason ({@code MXC_EXECUTABLE_MISSING}) instead of collapsing it into the
     * CP code {@code DIRECT_ATTACH_UNAVAILABLE}.
     */
    @Test
    void capabilitySnapshotPreservesTheRuntimeReason() {
        wireMock.stubFor(post(urlEqualTo(PROBE_PATH))
                .willReturn(aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-mxc\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"experimental\","
                                + "\"executionMode\":\"windows-mxc\",\"available\":false,"
                                + "\"reason\":\"MXC_EXECUTABLE_MISSING\"}")));

        Workspace workspace = new Workspace("preflight-snapshot", UUID.randomUUID().toString());
        workspace.setStorageMode("direct_attach");
        workspace.setHostPath("C:/work/repo");
        workspace.setExecutionMode("windows-mxc");

        Map<String, Object> snapshot = workspaceService.capabilitySnapshot(workspace);

        assertEquals(false, snapshot.get("available"));
        assertEquals("MXC_EXECUTABLE_MISSING", snapshot.get("reason"),
                "the Runtime reason must survive the capability projection");
    }
}
