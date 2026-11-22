package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.crossmodule.AbstractWireMockTest;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;

import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-787: a direct_attach workspace is registered with the Runtime inside the
 * create call (PLAN-0641 T7.5), so the environment projection is {@code ready}
 * right after create — {@code unbound} is not the post-create state any more.
 *
 * <p>{@code unbound} remains the projection for "Runtime has no status for this
 * workspace" (404 / released), which is asserted here as the second half of the
 * same state machine. The workspace list itself carries no status field.
 *
 * <p>The HTTP environment projection cannot be exercised on the H2 lane: the
 * endpoint's first authorization check goes through action atoms, and those SQL
 * tables do not exist under {@code ddl-auto=create-drop}
 * ({@link AbstractWireMockTest} documents this). The projection ladder itself
 * is pinned in {@link WorkspaceEnvironmentControllerTest}.
 */
class WorkspaceCreateReadinessTest extends AbstractWireMockTest {

    @org.springframework.test.context.DynamicPropertySource
    static void runtimeUrl(org.springframework.test.context.DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    private static final String REGISTER_PATH = "/internal/v1/runtime/workspaces";

    private String token;

    @BeforeEach
    void setUpCreate() {
        token = registerAndLogin();
        wireMock.resetAll();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-host\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"stable\","
                                + "\"executionMode\":\"windows-host\",\"available\":true}")));
        wireMock.stubFor(post(urlEqualTo(REGISTER_PATH))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"ok\"}")));
    }

    private String createWorkspace() throws IOException {
        String hostPath = Files.createTempDirectory("ws-readiness-" + UUID.randomUUID())
                .toAbsolutePath().toString();
        Map<String, Object> body = Map.of(
                "name", "ws-readiness-" + UUID.randomUUID(),
                "storageMode", "direct_attach",
                "executionMode", "windows-host",
                "roots", List.of(Map.of("path", hostPath)));
        ResponseEntity<String> created = restTemplate.exchange(url("/api/v1/workspaces"),
                HttpMethod.POST, entityWithAuth(body, token), String.class);
        assertTrue(created.getStatusCode().is2xxSuccessful(), String.valueOf(created.getBody()));
        return objectMapper.readTree(created.getBody()).path("id").asText();
    }

    @Test
    void createPushesTheRuntimeRegistrationThatMakesItReady() throws IOException {
        String workspaceId = createWorkspace();

        wireMock.verify(1, postRequestedFor(urlEqualTo(REGISTER_PATH)));
        JsonNode registration = objectMapper.readTree(
                wireMock.findAll(postRequestedFor(urlEqualTo(REGISTER_PATH))).get(0).getBodyAsString());
        assertEquals(workspaceId, registration.path("workspaceId").asText());
        assertEquals(workspaceId, registration.path("roots").get(0).path("rootId").asText());
        assertEquals("windows-host", registration.path("executionMode").asText());
    }

    @Test
    void workspaceListCarriesNoRuntimeStatus() throws IOException {
        String workspaceId = createWorkspace();
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        ResponseEntity<String> listed = restTemplate.exchange(url("/api/v1/workspaces"),
                HttpMethod.GET, new HttpEntity<>(headers), String.class);
        assertEquals(200, listed.getStatusCode().value(), String.valueOf(listed.getBody()));

        JsonNode entries = objectMapper.readTree(listed.getBody());
        JsonNode match = null;
        for (JsonNode entry : entries) {
            if (workspaceId.equals(entry.path("id").asText())) {
                match = entry;
                break;
            }
        }
        assertTrue(match != null, "created workspace must be listed: " + entries);
        assertFalse(match.has("status"), "status is an environment projection, not a list field: " + match);
    }
}
