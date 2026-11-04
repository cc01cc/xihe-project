package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.crossmodule.AbstractWireMockTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;

import java.io.IOException;
import java.nio.file.Files;
import java.util.Map;
import java.util.UUID;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0641 T7.5 (BL-260, direction (a)): CP pushes the direct_attach
 * workspace hostPath + ordered roots to the Runtime registration route. Judged
 * here: create pushes once with the primary root; declaring a root pushes the
 * full ordered root set (overwrite semantics); managed workspaces never push;
 * a failing Runtime never rolls back the business transaction.
 */
class WorkspaceRegistrationPushTest extends AbstractWireMockTest {

    private static final String REGISTER_PATH = "/internal/v1/runtime/workspaces";

    @org.springframework.test.context.DynamicPropertySource
    static void runtimeUrl(org.springframework.test.context.DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    private String token;

    @BeforeEach
    void setUpRegistration() {
        token = registerAndLogin();
        // Workspace creation needs a READY direct-attach capability probe.
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-host\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"stable\","
                                + "\"executionMode\":\"windows-host\",\"available\":true}")));
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces/delete"))
                .willReturn(aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"ok\",\"jobIds\":[],\"jobsEnumerationFailed\":false}")));
        // Requests are class-scoped in WireMock: clear so each test's verify counts its own calls.
        wireMock.resetRequests();
    }

    private void stubRegistrationAccepted() {
        wireMock.stubFor(post(urlEqualTo(REGISTER_PATH))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"ok\"}")));
    }

    private String createDirectAttachWorkspace(String hostPath) {
        Map<String, Object> body = Map.of(
                "name", "registration-" + UUID.randomUUID(),
                "storageMode", "direct_attach",
                "executionMode", "windows-host",
                "hostPath", hostPath);
        ResponseEntity<String> created = restTemplate.exchange(url("/api/v1/workspaces"),
                HttpMethod.POST, entityWithAuth(body, token), String.class);
        assertTrue(created.getStatusCode().is2xxSuccessful(), String.valueOf(created.getBody()));
        try {
            return objectMapper.readTree(created.getBody()).path("id").asText();
        } catch (IOException cause) {
            throw new IllegalStateException("invalid create response", cause);
        }
    }

    @Test
    void createPushesThePrimaryRootRegistration() throws IOException {
        stubRegistrationAccepted();
        String hostPath = Files.createTempDirectory("registration-created-").toAbsolutePath().toString();
        String workspaceId = createDirectAttachWorkspace(hostPath);

        wireMock.verify(1, postRequestedFor(urlEqualTo(REGISTER_PATH))
                .withRequestBody(matchingJsonPath("$.workspaceId", com.github.tomakehurst.wiremock.client.WireMock.equalTo(workspaceId)))
                .withRequestBody(matchingJsonPath("$.workspacePath",
                        com.github.tomakehurst.wiremock.client.WireMock.equalTo(hostPath)))
                .withRequestBody(matchingJsonPath("$.executionMode",
                        com.github.tomakehurst.wiremock.client.WireMock.equalTo("windows-host")))
                .withRequestBody(matchingJsonPath("$.roots[0].rootId",
                        com.github.tomakehurst.wiremock.client.WireMock.equalTo(workspaceId))));
    }

    @Test
    void declaringARootPushesTheFullOrderedRootSet() throws IOException {
        stubRegistrationAccepted();
        String hostPath = Files.createTempDirectory("registration-parent-").toAbsolutePath().toString();
        String nestedPath = java.nio.file.Path.of(hostPath, "vendor", "lib").toString();
        Files.createDirectories(java.nio.file.Path.of(nestedPath));
        String workspaceId = createDirectAttachWorkspace(hostPath);
        wireMock.resetRequests();

        ResponseEntity<String> declared = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots"), HttpMethod.POST,
                entityWithAuth(Map.of("path", nestedPath), token), String.class);
        assertTrue(declared.getStatusCode().is2xxSuccessful(), String.valueOf(declared.getBody()));
        String rootId = objectMapper.readTree(declared.getBody()).path("id").asText();

        wireMock.verify(1, postRequestedFor(urlEqualTo(REGISTER_PATH))
                .withRequestBody(matchingJsonPath("$.roots[0].rootId",
                        com.github.tomakehurst.wiremock.client.WireMock.equalTo(workspaceId)))
                .withRequestBody(matchingJsonPath("$.roots[1].rootId",
                        com.github.tomakehurst.wiremock.client.WireMock.equalTo(rootId)))
                .withRequestBody(matchingJsonPath("$.roots[1].hostPath",
                        com.github.tomakehurst.wiremock.client.WireMock.equalTo(nestedPath.toLowerCase(java.util.Locale.ROOT)))));
    }

    @Test
    void managedWorkspaceCannotBeCreatedAndNeverPushes() {
        Map<String, Object> body = Map.of(
                "name", "registration-managed-" + UUID.randomUUID(),
                "storageMode", "managed_import");
        ResponseEntity<String> created = restTemplate.exchange(url("/api/v1/workspaces"),
                HttpMethod.POST, entityWithAuth(body, token), String.class);
        assertEquals(org.springframework.http.HttpStatus.CONFLICT, created.getStatusCode(),
                String.valueOf(created.getBody()));
        wireMock.verify(0, postRequestedFor(urlEqualTo(REGISTER_PATH)));
    }

    @Test
    void failingRuntimeRegistrationDoesNotRollBackTheWorkspace() throws IOException {
        wireMock.stubFor(post(urlEqualTo(REGISTER_PATH))
                .willReturn(aResponse().withStatus(500)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"code\":\"RUNTIME_ERROR\"}")));
        String hostPath = Files.createTempDirectory("registration-failure-").toAbsolutePath().toString();
        String workspaceId = createDirectAttachWorkspace(hostPath);

        ResponseEntity<String> fetched = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId), HttpMethod.GET,
                entityWithAuth(null, token), String.class);
        assertTrue(fetched.getStatusCode().is2xxSuccessful(),
                "a failed runtime registration must not roll back the workspace: " + fetched.getBody());
        wireMock.verify(1, postRequestedFor(urlEqualTo(REGISTER_PATH)));
    }
}
