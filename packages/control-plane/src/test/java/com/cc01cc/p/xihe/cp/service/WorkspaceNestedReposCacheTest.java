package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.crossmodule.AbstractWireMockTest;
import com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;

import java.io.IOException;
import java.nio.file.Files;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0641 T2.3/T2.4 judges over the full CP surface (contract §3):
 * cold probe returns the typed classification list; a cache hit never re-probes
 * the Runtime; an expired entry re-probes; an unknown workspace answers 404
 * before the Runtime is touched; declaring a root evicts the cache so the
 * {@code declared} label re-projects; the capture warm path (classify-only)
 * pre-fills the cache without a probe.
 */
class WorkspaceNestedReposCacheTest extends AbstractWireMockTest {

    @org.springframework.test.context.DynamicPropertySource
    static void runtimeUrl(org.springframework.test.context.DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private WorkspaceNestedReposCache cache;

    @Autowired
    private WorkspaceNestedReposService service;

    @Autowired
    private WorkspaceService workspaceService;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.WorkspaceRepository workspaceRepository;

    private String token;

    @BeforeEach
    void setUpNestedRepos() {
        token = registerAndLogin();
        // Workspace creation needs a READY direct-attach capability probe.
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-host\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"stable\","
                                + "\"executionMode\":\"windows-host\",\"available\":true}")));
    }

    private String probePath(String workspaceId) {
        return "/internal/v1/runtime/workspaces/" + workspaceId + "/nested-repos";
    }

    private void stubProbe(String workspaceId, String itemsJson) {
        wireMock.stubFor(get(urlEqualTo(probePath(workspaceId)))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"items\":[" + itemsJson + "]}")));
    }

    private record Fixture(String workspaceId, String hostPath) {}

    private Fixture createWorkspaceOrFail() {
        try {
            String hostPath = Files.createTempDirectory("nested-repos-" + UUID.randomUUID())
                    .toAbsolutePath().toString();
            Map<String, Object> body = Map.of(
                    "name", "nested-repos-" + UUID.randomUUID(),
                    "storageMode", "direct_attach",
                    "executionMode", "windows-host",
                    "roots", List.of(Map.of("path", hostPath)));
            ResponseEntity<String> created = restTemplate.exchange(url("/api/v1/workspaces"),
                    HttpMethod.POST, entityWithAuth(body, token), String.class);
            assertTrue(created.getStatusCode().is2xxSuccessful(), String.valueOf(created.getBody()));
            return new Fixture(objectMapper.readTree(created.getBody()).path("id").asText(), hostPath);
        } catch (IOException cause) {
            throw new IllegalStateException("cannot build the fixture workspace", cause);
        }
    }

    private ResponseEntity<String> readNested(String workspaceId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return restTemplate.exchange(url("/api/v1/workspaces/" + workspaceId + "/nested-repos"),
                HttpMethod.GET, new HttpEntity<>(headers), String.class);
    }

    private JsonNode bodyOf(ResponseEntity<String> response) {
        try {
            return objectMapper.readTree(response.getBody());
        } catch (IOException cause) {
            throw new IllegalStateException("invalid JSON: " + response.getBody(), cause);
        }
    }

    @Test
    void probeReturnsTypedClassificationList() {
        Fixture fixture = createWorkspaceOrFail();
        String workspaceId = fixture.workspaceId();
        stubProbe(workspaceId,
                "{\"path\":\"mirror.git\",\"type\":\"bare\",\"declared\":false},"
                        + "{\"path\":\"vendor/lib\",\"type\":\"nested\",\"declared\":false}");

        ResponseEntity<String> response = readNested(workspaceId);
        assertEquals(org.springframework.http.HttpStatus.OK, response.getStatusCode(),
                String.valueOf(response.getBody()));
        JsonNode body = bodyOf(response);
        assertEquals(workspaceId, body.path("workspaceId").asText());
        assertTrue(body.has("cachedAt"), "F2 carries cachedAt: " + body);
        assertEquals(2, body.path("items").size());
        assertEquals("mirror.git", body.path("items").get(0).path("path").asText());
        assertEquals("bare", body.path("items").get(0).path("type").asText());
        assertFalse(body.path("items").get(0).path("declared").asBoolean());
        assertEquals("vendor/lib", body.path("items").get(1).path("path").asText());
        assertEquals("nested", body.path("items").get(1).path("type").asText());
    }

    @Test
    void cacheHitNeverReprobesTheRuntime() {
        Fixture fixture = createWorkspaceOrFail();
        String workspaceId = fixture.workspaceId();
        stubProbe(workspaceId,
                "{\"path\":\"vendor/lib\",\"type\":\"nested\",\"declared\":false}");

        readNested(workspaceId);
        readNested(workspaceId);
        readNested(workspaceId);
        wireMock.verify(1, getRequestedFor(urlEqualTo(probePath(workspaceId))));
    }

    @Test
    void expiredCacheEntryTriggersReprobe() {
        Fixture fixture = createWorkspaceOrFail();
        String workspaceId = fixture.workspaceId();
        stubProbe(workspaceId,
                "{\"path\":\"vendor/lib\",\"type\":\"nested\",\"declared\":false}");

        readNested(workspaceId);
        // Test hook: stamp a stale entry — no sleeps, per workspace rules.
        cache.putAt(workspaceId,
                List.of(new RuntimeCheckpointClient.NestedRepoItem("stale", "nested", false)),
                Instant.now().minus(WorkspaceNestedReposCache.TTL.plusSeconds(5)));

        JsonNode second = bodyOf(readNested(workspaceId));
        assertEquals("vendor/lib", second.path("items").get(0).path("path").asText(),
                "expired entries are re-probed, not served stale: " + second);
        wireMock.verify(2, getRequestedFor(urlEqualTo(probePath(workspaceId))));
    }

    @Test
    void unknownWorkspaceAnswers404WithoutProbing() {
        String unknown = UUID.randomUUID().toString();
        ResponseEntity<String> response = readNested(unknown);
        assertEquals(org.springframework.http.HttpStatus.NOT_FOUND, response.getStatusCode(),
                String.valueOf(response.getBody()));
        wireMock.verify(0, getRequestedFor(urlEqualTo(probePath(unknown))));
    }

    @Test
    void declaringRootEvictsSoDeclaredLabelReProjects() throws IOException {
        Fixture fixture = createWorkspaceOrFail();
        String workspaceId = fixture.workspaceId();
        stubProbe(workspaceId,
                "{\"path\":\"vendor/lib\",\"type\":\"nested\",\"declared\":false}");
        JsonNode before = bodyOf(readNested(workspaceId));
        assertFalse(before.path("items").get(0).path("declared").asBoolean());

        // The Runtime re-probe now labels the declared root (post-refresh behavior).
        stubProbe(workspaceId,
                "{\"path\":\"vendor/lib\",\"type\":\"nested\",\"declared\":true}");
        // The declared root must sit inside the primary root (0639 containment rule).
        String nestedPath = java.nio.file.Path.of(fixture.hostPath(), "vendor", "lib")
                .toAbsolutePath().toString();
        java.nio.file.Path nestedDir = java.nio.file.Path.of(nestedPath);
        Files.createDirectories(nestedDir);
        ResponseEntity<String> declared = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots"), HttpMethod.POST,
                entityWithAuth(Map.of("path", nestedPath), token), String.class);
        assertTrue(declared.getStatusCode().is2xxSuccessful(), String.valueOf(declared.getBody()));

        JsonNode after = bodyOf(readNested(workspaceId));
        assertTrue(after.path("items").get(0).path("declared").asBoolean(),
                "the declare must evict the cache so the label re-projects: " + after);
        wireMock.verify(2, getRequestedFor(urlEqualTo(probePath(workspaceId))));
    }

    @Test
    void warmFromCapturePrefillsCacheWithoutProbe() {
        Fixture fixture = createWorkspaceOrFail();
        String workspaceId = fixture.workspaceId();
        wireMock.stubFor(post(urlEqualTo(probePath(workspaceId) + "/classify"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"items\":[{\"path\":\"vendor/lib\",\"type\":\"nested\","
                                + "\"declared\":false}]}")));

        service.warmFromCapture(workspaceId, workspaceId, List.of("vendor/lib"));
        JsonNode body = bodyOf(readNested(workspaceId));
        assertEquals("vendor/lib", body.path("items").get(0).path("path").asText(),
                "the warm entry serves the read face: " + body);
        wireMock.verify(0, getRequestedFor(urlEqualTo(probePath(workspaceId))));
    }

    // ---- PLAN-0641 T7.5 (BL-260) 懒重试 -------------------------------------------------

    @Test
    void lazyRetryReRegistersOnceThenSucceeds() {
        Fixture fixture = createWorkspaceOrFail();
        String workspaceId = fixture.workspaceId();
        String registerPath = "/internal/v1/runtime/workspaces";
        wireMock.stubFor(post(urlEqualTo(registerPath))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"ok\",\"workspaceId\":\"" + workspaceId + "\"}")));
        // 冷探针先 404（Runtime 还不认识该 direct_attach 工作区），重试一次后成功。
        wireMock.stubFor(get(urlEqualTo(probePath(workspaceId)))
                .inScenario("lazy-retry")
                .whenScenarioStateIs(com.github.tomakehurst.wiremock.stubbing.Scenario.STARTED)
                .willReturn(aResponse()
                        .withStatus(404)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"code\":\"WORKSPACE_NOT_FOUND\"}"))
                .willSetStateTo("retried"));
        wireMock.stubFor(get(urlEqualTo(probePath(workspaceId)))
                .inScenario("lazy-retry")
                .whenScenarioStateIs("retried")
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"items\":[{\"path\":\"vendor/lib\",\"type\":\"nested\","
                                + "\"declared\":false}]}")));
        wireMock.resetRequests();

        ResponseEntity<String> response = readNested(workspaceId);

        assertTrue(response.getStatusCode().is2xxSuccessful(), String.valueOf(response.getBody()));
        assertEquals("vendor/lib", bodyOf(response).path("items").get(0).path("path").asText());
        wireMock.verify(1, postRequestedFor(urlEqualTo(registerPath)));
        wireMock.verify(2, getRequestedFor(urlEqualTo(probePath(workspaceId))));
    }

    @Test
    void lazyRetryNeverTriggersForManagedWorkspace() {
        com.cc01cc.p.xihe.cp.entity.Workspace managed =
                new com.cc01cc.p.xihe.cp.entity.Workspace("managed-" + UUID.randomUUID());
        managed.setStorageBackend("docker");
        managed.setStorageMode("managed_import");
        managed.setExecutionMode("docker");
        com.cc01cc.p.xihe.cp.entity.Workspace saved = workspaceRepository.save(managed);
        saved.setStorageRef(saved.getId().toString());
        saved = workspaceRepository.save(saved);
        wireMock.resetRequests();

        assertFalse(workspaceService.registerWorkspaceWithRuntimeBestEffort(saved.getId().toString()),
                "managed workspaces must never re-register through the lazy path");
        wireMock.verify(0, postRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces")));
    }
}
