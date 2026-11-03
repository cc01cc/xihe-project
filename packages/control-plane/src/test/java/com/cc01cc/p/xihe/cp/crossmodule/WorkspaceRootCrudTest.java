package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.cc01cc.p.xihe.cp.entity.WorkspaceRoot;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRootRepository;
import com.fasterxml.jackson.databind.JsonNode;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0639 M1 root CRUD: the gaps left by the M7/M8 closeout audit (task-14) — add / patch /
 * delete plus the two documented conflict codes.
 *
 * <p>Uses the WireMock lane because creating a {@code direct_attach} workspace needs a reachable
 * Runtime capability probe; the probe is stubbed READY below. Everything after creation
 * ({@code POST/PATCH/DELETE /api/v1/workspaces/{id}/roots…}) is pure CP.</p>
 */
class WorkspaceRootCrudTest extends AbstractWireMockTest {

    @org.springframework.test.context.DynamicPropertySource
    static void runtimeUrl(org.springframework.test.context.DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private WorkspaceRootRepository workspaceRootRepository;

    private String token;

    @BeforeEach
    void setUpRootCrud() {
        token = registerAndLogin();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-host\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"stable\","
                                + "\"executionMode\":\"windows-host\",\"available\":true}")));
    }

    private String tempPath(String suffix) {
        try {
            return Files.createTempDirectory("root-crud-" + suffix).toAbsolutePath().toString();
        } catch (IOException cause) {
            throw new IllegalStateException("cannot create the fixture host directory", cause);
        }
    }

    private ResponseEntity<String> createWorkspace(List<String> rootPaths) {
        List<Map<String, String>> roots = new java.util.ArrayList<>();
        for (String path : rootPaths) {
            roots.add(Map.of("path", path));
        }
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("name", "root-crud-" + UUID.randomUUID());
        body.put("storageMode", "direct_attach");
        body.put("executionMode", "windows-host");
        body.put("roots", roots);
        return restTemplate.exchange(url("/api/v1/workspaces"), HttpMethod.POST,
                entityWithAuth(body, token), String.class);
    }

    private String createWorkspaceOrFail(String rootPath) {
        ResponseEntity<String> created = createWorkspace(List.of(rootPath));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        return idOf(created.getBody());
    }

    private static String idOf(String json) {
        try {
            return objectMapperStatic().readTree(json).path("id").asText();
        } catch (IOException cause) {
            throw new IllegalStateException("invalid JSON: " + json, cause);
        }
    }

    private static com.fasterxml.jackson.databind.ObjectMapper objectMapperStatic() {
        return new com.fasterxml.jackson.databind.ObjectMapper();
    }

    private JsonNode getWorkspace(String workspaceId) throws IOException {
        ResponseEntity<String> view = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId), HttpMethod.GET,
                new HttpEntity<>(authHeaders()), String.class);
        assertEquals(HttpStatus.OK, view.getStatusCode(), String.valueOf(view.getBody()));
        return objectMapper.readTree(view.getBody());
    }

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        return headers;
    }

    /**
     * PATCH is not supported by the default {@code SimpleClientHttpRequestFactory}; the JDK client
     * factory speaks it. Same non-error handling for 4xx as the base {@link RestTemplate} so the
     * conflict assertions can read the problem body instead of catching an exception.
     */
    private org.springframework.web.client.RestTemplate patchTemplate() {
        org.springframework.web.client.RestTemplate client = new org.springframework.web.client.RestTemplate(
                new org.springframework.http.client.JdkClientHttpRequestFactory());
        client.getInterceptors().add(
                com.cc01cc.p.xihe.cp.support.Jackson2NodeWireInterceptor.INSTANCE);
        client.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
        return client;
    }

    private static String problemCode(String body) {
        try {
            return objectMapperStatic().readTree(body).path("code").asText();
        } catch (IOException cause) {
            throw new IllegalStateException("invalid problem JSON: " + body, cause);
        }
    }

    // ── create ───────────────────────────────────────────────────────────────

    @Test
    void createProjectsPrimaryRootInvariant() throws IOException {
        String path = tempPath("primary");
        String workspaceId = createWorkspaceOrFail(path);

        JsonNode roots = getWorkspace(workspaceId).path("roots");
        assertEquals(1, roots.size());
        assertEquals(workspaceId, roots.get(0).path("id").asText(),
                "root[0].id == workspace.id is the primary-root invariant");
        assertEquals(0, roots.get(0).path("position").asInt());

        // The projection deliberately exposes only id/alias/position; the canonical host path
        // lives on the row (design §2: lowercase canonical, one row per declared root).
        WorkspaceRoot row = workspaceRootRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        assertEquals(path.toLowerCase(java.util.Locale.ROOT), row.getHostPath());
        assertEquals(0, row.getPosition());
    }

    @Test
    void createRejectsPartiallyOverlappingRoots() {
        String base = tempPath("overlap");
        ResponseEntity<String> created = createWorkspace(List.of(base, base + "-2"));

        assertEquals(HttpStatus.BAD_REQUEST, created.getStatusCode());
        assertEquals("INVALID_ROOT_OVERLAP", problemCode(created.getBody()));
    }

    @Test
    void createAllowsNestedRoots() throws IOException {
        String parent = tempPath("parent");
        // D39-5b: a fully-contained nested root is allowed (own shadow repo, deepest-root
        // attribution); only partial overlap is refused. Windows roots keep `\`, so the
        // component-boundary check must normalise separators before comparing.
        ResponseEntity<String> created = createWorkspace(List.of(parent, parent + "\\nested"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));

        JsonNode roots = getWorkspace(idOf(created.getBody())).path("roots");
        assertEquals(2, roots.size());
    }

    // ── add ─────────────────────────────────────────────────────────────────

    @Test
    void addRootCreatesSecondRootAtNextPosition() throws IOException {
        String primary = tempPath("primary-add");
        String workspaceId = createWorkspaceOrFail(primary);
        String second = tempPath("second");

        ResponseEntity<String> added = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots"), HttpMethod.POST,
                entityWithAuth(Map.of("path", second, "alias", "beta"), token), String.class);
        assertEquals(HttpStatus.CREATED, added.getStatusCode(), String.valueOf(added.getBody()));

        JsonNode addedRoot = objectMapper.readTree(added.getBody());
        assertNotEquals(workspaceId, addedRoot.path("id").asText(), "a declared root is not the primary root");
        assertEquals(1, addedRoot.path("position").asInt());
        assertEquals("beta", addedRoot.path("alias").asText());

        JsonNode roots = getWorkspace(workspaceId).path("roots");
        assertEquals(2, roots.size());
        assertEquals(List.of(0, 1),
                List.of(roots.get(0).path("position").asInt(), roots.get(1).path("position").asInt()));
        assertEquals(workspaceId, roots.get(0).path("id").asText(), "position 0 stays the primary root");
    }

    @Test
    void addRootRejectsDuplicatePathConflict() {
        String primary = tempPath("primary-dup");
        String workspaceId = createWorkspaceOrFail(primary);

        ResponseEntity<String> duplicate = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots"), HttpMethod.POST,
                entityWithAuth(Map.of("path", primary), token), String.class);

        assertEquals(HttpStatus.CONFLICT, duplicate.getStatusCode(), String.valueOf(duplicate.getBody()));
        assertEquals("ROOT_PATH_CONFLICT", problemCode(duplicate.getBody()));
    }

    @Test
    void addRootRejectsPartialOverlapWithPrimaryRoot() {
        String primary = tempPath("primary-overlap");
        String workspaceId = createWorkspaceOrFail(primary);

        // `…-primary-overlap-2` shares a textual prefix with the primary root but is neither
        // equal nor nested — creation would answer 400 and POST /roots must agree.
        ResponseEntity<String> overlapping = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots"), HttpMethod.POST,
                entityWithAuth(Map.of("path", primary + "-2"), token), String.class);

        assertEquals(HttpStatus.BAD_REQUEST, overlapping.getStatusCode(),
                String.valueOf(overlapping.getBody()));
        assertEquals("INVALID_ROOT_OVERLAP", problemCode(overlapping.getBody()));
    }

    @Test
    void addRootAllowsFullyNestedRoot() throws IOException {
        String primary = tempPath("primary-nested");
        String workspaceId = createWorkspaceOrFail(primary);

        // D39-5b: fully nested is allowed (own shadow repo, deepest-root attribution).
        ResponseEntity<String> nested = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots"), HttpMethod.POST,
                entityWithAuth(Map.of("path", primary + "\\nested"), token), String.class);

        assertEquals(HttpStatus.CREATED, nested.getStatusCode(), String.valueOf(nested.getBody()));
        assertEquals(2, getWorkspace(workspaceId).path("roots").size());
    }

    @Test
    void patchRootUpdatesAliasAndReordersPositions() throws IOException {
        String primary = tempPath("primary-patch");
        String workspaceId = createWorkspaceOrFail(primary);
        String second = tempPath("patch-second");
        ResponseEntity<String> added = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots"), HttpMethod.POST,
                entityWithAuth(Map.of("path", second, "alias", "beta"), token), String.class);
        String rootId = objectMapper.readTree(added.getBody()).path("id").asText();

        ResponseEntity<String> patched = patchTemplate().exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots/" + rootId), HttpMethod.PATCH,
                entityWithAuth(Map.of("alias", "renamed", "position", 0), token), String.class);
        assertEquals(HttpStatus.OK, patched.getStatusCode(), String.valueOf(patched.getBody()));

        JsonNode roots = getWorkspace(workspaceId).path("roots");
        assertEquals("renamed", roots.get(0).path("alias").asText());
        assertEquals(rootId, roots.get(0).path("id").asText(), "position 0 now belongs to the patched root");
        assertEquals(workspaceId, roots.get(1).path("id").asText(), "the primary root shifted to position 1");
    }

    // ── delete ──────────────────────────────────────────────────────────────

    @Test
    void deleteRootSoftDeletesAndHidesItFromTheProjection() throws IOException {
        String primary = tempPath("primary-del");
        String workspaceId = createWorkspaceOrFail(primary);
        String second = tempPath("delete-second");
        ResponseEntity<String> added = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots"), HttpMethod.POST,
                entityWithAuth(Map.of("path", second), token), String.class);
        String rootId = objectMapper.readTree(added.getBody()).path("id").asText();

        ResponseEntity<String> deleted = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots/" + rootId), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders()), String.class);
        assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode(), String.valueOf(deleted.getBody()));

        JsonNode roots = getWorkspace(workspaceId).path("roots");
        assertEquals(1, roots.size(), "a soft-deleted root disappears from the projection");
        WorkspaceRoot row = workspaceRootRepository.findById(UUID.fromString(rootId)).orElseThrow();
        assertNotNull(row.getDeletedAt(), "the row is soft-deleted, never physically removed (slice attribution)");
    }

    @Test
    void deleteUnknownRootIsNotFound() {
        String workspaceId = createWorkspaceOrFail(tempPath("primary-404"));

        ResponseEntity<String> missing = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots/" + UUID.randomUUID()), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders()), String.class);

        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode(), String.valueOf(missing.getBody()));
        assertEquals("ROOT_NOT_FOUND", problemCode(missing.getBody()));
    }

    @Test
    void deletePrimaryRootIsRefusedAndKeepsTheProjection() throws IOException {
        String primary = tempPath("primary-immutable");
        String workspaceId = createWorkspaceOrFail(primary);

        // task-17 ruling: root[0] == workspace itself, so DELETE must not be able to remove it
        // (captureRoots always puts it first; a deletable primary would contradict that).
        ResponseEntity<String> refused = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/roots/" + workspaceId), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders()), String.class);

        assertEquals(HttpStatus.CONFLICT, refused.getStatusCode(), String.valueOf(refused.getBody()));
        assertEquals("PRIMARY_ROOT_IMMUTABLE", problemCode(refused.getBody()));

        JsonNode roots = getWorkspace(workspaceId).path("roots");
        assertEquals(1, roots.size(), "the primary root stays in the projection");
        assertEquals(workspaceId, roots.get(0).path("id").asText());
        WorkspaceRoot row = workspaceRootRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        assertEquals(null, row.getDeletedAt(), "no soft-delete marker is written for the primary root");
    }
}
