package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.RunCheckpointRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Workspace-level slice routes over a real CP application and a Runtime stub. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class RunCheckpointControllerTest extends AbstractH2Test {

    private static final String SLICE_REF = "refs/xihe/slices/1757980000000-ab12cd";
    private static final String RAW_REQUEST_MARKER = "secret-revert-request-marker";

    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceRepository workspaceRepository;
    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;
    @Autowired
    private SessionRepository sessionRepository;
    @Autowired
    private ChatRunRepository chatRunRepository;
    @Autowired
    private RunCheckpointRepository checkpointRepository;
    @Autowired
    private OperationItemRepository operationItemRepository;
    @Autowired
    private OperationService operationService;
    @Autowired
    private JwtTokenProvider jwtTokenProvider;
    @LocalServerPort
    private int serverPort;

    private static HttpServer runtimeServer;
    private static final Map<String, AtomicReference<StubResponse>> RESPONSES = new ConcurrentHashMap<>();
    private static final Map<String, AtomicInteger> CALLS = new ConcurrentHashMap<>();

    private record StubResponse(int status, String body, String contentType) {}

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        try {
            runtimeServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            runtimeServer.createContext("/", exchange -> {
                String key = routeKey(exchange.getRequestURI().getPath());
                CALLS.computeIfAbsent(key, ignored -> new AtomicInteger()).incrementAndGet();
                StubResponse response = RESPONSES.getOrDefault(key,
                        new AtomicReference<>(json(404, "{\"code\":\"CHECKPOINT_NOT_FOUND\"}"))).get();
                byte[] bytes = response.body() == null
                        ? new byte[0] : response.body().getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", response.contentType());
                exchange.sendResponseHeaders(response.status(), bytes.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(bytes);
                }
            });
            runtimeServer.start();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        registry.add("cp.mcp.runtime-url",
                () -> "http://127.0.0.1:" + runtimeServer.getAddress().getPort());
    }

    @AfterAll
    static void stopRuntimeServer() {
        if (runtimeServer != null) {
            runtimeServer.stop(0);
        }
    }

    private static String routeKey(String path) {
        if (path.endsWith("/revert/preview")) {
            return "preview";
        }
        if (path.endsWith("/revert")) {
            return "revert";
        }
        if (path.endsWith("/blob")) {
            return "blob";
        }
        if (path.endsWith("/git-status")) {
            return "git-status";
        }
        if (path.endsWith("/checkpoints/gc")) {
            return "gc";
        }
        if (path.endsWith("/checkpoints/cleanup")) {
            return "cleanup";
        }
        return "other";
    }

    private static StubResponse json(int status, String body) {
        return new StubResponse(status, body, "application/json");
    }

    private static StubResponse text(String body) {
        return new StubResponse(200, body, "text/plain; charset=utf-8");
    }

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;

    @BeforeEach
    void setUpCheckpointFixtures() {
        RESPONSES.clear();
        CALLS.clear();

        String email = "cp-ctrl-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "CheckpointCtrl"),
                AuthResponse.class);
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("cp-test-workspace", userId));
        workspaceId = workspace.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Checkpoint Test");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);

        runId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, sessionId, userId, workspaceId, "idem-" + runId, "hash",
                "openai", "gpt-test", "none", "succeeded");
        run.setTerminalOutcome("success");
        chatRunRepository.save(run);
    }

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private ResponseEntity<Map> get(String path) {
        return restTemplate.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(authHeaders()), Map.class);
    }

    private ResponseEntity<List> getList(String path) {
        return restTemplate.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(authHeaders()), List.class);
    }

    private ResponseEntity<Map> post(String path, Object body) {
        return restTemplate.exchange(url(path), HttpMethod.POST,
                new HttpEntity<>(body, authHeaders()), Map.class);
    }

    private int calls(String key) {
        AtomicInteger counter = CALLS.get(key);
        return counter == null ? 0 : counter.get();
    }

    private RunCheckpoint seedCheckpoint(String state) {
        return seedCheckpoint(state, SLICE_REF, runId);
    }

    private RunCheckpoint seedCheckpoint(String state, String sliceRef, String sourceRunId) {
        RunCheckpoint row = new RunCheckpoint();
        row.setId(UUID.randomUUID());
        row.setSourceRunId(sourceRunId);
        row.setSourceSessionId(sessionId);
        row.setWorkspaceId(workspaceId);
        row.setSliceRef(sliceRef);
        row.setCapturedAt(Instant.parse("2026-09-15T00:00:00Z"));
        row.setPredecessorRef("refs/xihe/slices/1757900000000-998877");
        row.setState(state);
        row.setChangedFiles("[{\"status\":\"M\",\"path\":\"src/a.txt\"}]");
        row.setOpaqueNestedRepos("[\"vendor/lib\"]");
        row.setCreatedAt(Instant.now());
        row.setUpdatedAt(Instant.now());
        return checkpointRepository.save(row);
    }

    private String previewBody() {
        return "{\"sliceRef\":\"" + SLICE_REF + "\","
                + "\"counts\":{\"restore\":2,\"delete\":1,\"typeConflict\":1},\"entries\":["
                + "{\"path\":\"src/a.txt\",\"action\":\"restore\",\"state\":\"planned\"},"
                + "{\"path\":\"c.txt\",\"action\":\"restore\",\"state\":\"typeConflict\","
                + "\"reason\":\"TYPE_CHANGED\"}],\"truncated\":false,"
                + "\"opaqueNestedRepos\":[\"vendor/lib\"]}";
    }

    private String revertBody() {
        return "{\"sliceRef\":\"" + SLICE_REF + "\","
                + "\"counts\":{\"restored\":2,\"deleted\":1,\"failed\":0},"
                + "\"entries\":[{\"path\":\"src/a.txt\",\"outcome\":\"restored\"}],"
                + "\"durationMs\":42,\"suspects\":[]}";
    }

    @Test
    void checkpointListReturnsSliceProjectionAndOmitsExpiredRows() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        seedCheckpoint(RunCheckpoint.STATE_EXPIRED, "refs/xihe/slices/1757980000001-expired",
                UUID.randomUUID().toString());

        ResponseEntity<List> response = getList("/api/v1/workspaces/" + workspaceId + "/checkpoints");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(1, response.getBody().size());
        Map<?, ?> view = (Map<?, ?>) response.getBody().get(0);
        assertEquals(SLICE_REF, view.get("sliceRef"));
        assertEquals("2026-09-15T00:00:00Z", view.get("capturedAt"));
        assertEquals(runId, view.get("sourceRunId"));
        assertEquals(sessionId, view.get("sourceSessionId"));
        assertEquals("refs/xihe/slices/1757900000000-998877", view.get("predecessorRef"));
        assertEquals(List.of("vendor/lib"), view.get("opaqueNestedRepos"));
        assertEquals(false, view.get("truncated"));
    }

    @Test
    void previewRequiresSliceRefAndRejectsOldFields() {
        ResponseEntity<Map> missing = post("/api/v1/workspaces/" + workspaceId
                + "/checkpoints/revert/preview", Map.of());
        assertEquals(HttpStatus.BAD_REQUEST, missing.getStatusCode());
        assertEquals("CHECKPOINT_INVALID_REQUEST", missing.getBody().get("code"));

        ResponseEntity<Map> legacy = post("/api/v1/workspaces/" + workspaceId
                + "/checkpoints/revert/preview", Map.of("sliceRef", SLICE_REF, "baseRef", "old"));
        assertEquals(HttpStatus.BAD_REQUEST, legacy.getStatusCode());
        assertEquals(0, calls("preview"));
    }

    @Test
    void previewPassesSliceRefAndOpaqueNestedRepos() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        RESPONSES.put("preview", new AtomicReference<>(json(200, previewBody())));

        ResponseEntity<Map> response = post("/api/v1/workspaces/" + workspaceId
                + "/checkpoints/revert/preview", Map.of("sliceRef", SLICE_REF));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(SLICE_REF, response.getBody().get("sliceRef"));
        assertEquals(false, response.getBody().get("truncated"));
        assertEquals(List.of("vendor/lib"), response.getBody().get("opaqueNestedRepos"));
        assertEquals(1, calls("preview"));
    }

    @Test
    void revertUsesWorkspaceSliceAndTypeAcknowledgements() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        var operation = operationService.startOperation(userId, sessionId, workspaceId, runId,
                UUID.randomUUID().toString(), "chat", "ui", "user", userId, null, null);
        RESPONSES.put("revert", new AtomicReference<>(json(200, revertBody())));

        ResponseEntity<Map> response = post("/api/v1/workspaces/" + workspaceId + "/checkpoints/revert",
                Map.of("sliceRef", SLICE_REF, "acknowledgeTypeChanges", List.of(RAW_REQUEST_MARKER)));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(SLICE_REF, response.getBody().get("sliceRef"));
        assertEquals(1, calls("revert"));
        RunCheckpoint row = checkpointRepository.findByWorkspaceIdAndSliceRef(workspaceId, SLICE_REF).orElseThrow();
        assertEquals(RunCheckpoint.REVERT_ROLLED_BACK, row.getRevertState());
        assertEquals(1, row.getRevertAttemptCount());
        assertFalse(row.getRevertSummary().contains(RAW_REQUEST_MARKER));

        List<OperationItem> items = operationItemRepository
                .findByOperationIdOrderBySequenceAsc(operation.operationId().toString());
        OperationItem revertItem = items.stream()
                .filter(item -> "revert_checkpoint".equals(item.getToolName()))
                .findFirst().orElseThrow();
        assertEquals("checkpoint", revertItem.getKind());
        assertEquals("ui", revertItem.getSource());
    }

    @Test
    void revertRejectsOldAcknowledgementFields() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);

        ResponseEntity<Map> response = post("/api/v1/workspaces/" + workspaceId + "/checkpoints/revert",
                Map.of("sliceRef", SLICE_REF, "acknowledgeConflicts", List.of("a.txt")));

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals(0, calls("revert"));
    }

    @Test
    void blobUsesSliceRefQueryAndMapsRuntimeErrors() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        RESPONSES.put("blob", new AtomicReference<>(text("file contents")));

        ResponseEntity<String> ok = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/checkpoints/blob?path=src/a.txt&sliceRef="
                        + SLICE_REF),
                HttpMethod.GET, new HttpEntity<>(authHeaders()), String.class);
        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals("file contents", ok.getBody());
        assertTrue(String.valueOf(ok.getHeaders().getContentType()).contains("text/plain"));

        RESPONSES.put("blob", new AtomicReference<>(json(404, "{\"code\":\"CHECKPOINT_NOT_FOUND\"}")));
        ResponseEntity<Map> missing = get("/api/v1/workspaces/" + workspaceId
                + "/checkpoints/blob?path=gone.txt&sliceRef=" + SLICE_REF);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertEquals("CHECKPOINT_NOT_FOUND", missing.getBody().get("code"));
    }

    @Test
    void existingWorkspaceGitStatusAndRetentionRoutesRemainAvailable() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        seedCheckpoint(RunCheckpoint.STATE_DEGRADED, "refs/xihe/slices/2-cdef",
                UUID.randomUUID().toString());
        RESPONSES.put("git-status", new AtomicReference<>(json(200,
                "{\"isRepository\":true,\"entries\":[{\"status\":\"M\",\"path\":\"a.txt\"}]}")));

        ResponseEntity<Map> status = get("/api/v1/workspaces/" + workspaceId + "/git-status");
        ResponseEntity<Map> retention = get("/api/v1/workspaces/" + workspaceId + "/checkpoints/retention");

        assertEquals(HttpStatus.OK, status.getStatusCode());
        assertEquals(true, status.getBody().get("isRepository"));
        assertEquals(1, ((List<?>) status.getBody().get("entries")).size());
        assertEquals(HttpStatus.OK, retention.getStatusCode());
        assertEquals(2, retention.getBody().get("currentRuns"));
        assertEquals(2L, ((Number) retention.getBody().get("currentRefs")).longValue());
    }

    @Test
    void cleanupRequiresConfirmationAndDeletesProjectionAfterRuntimeSuccess() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        RESPONSES.put("cleanup", new AtomicReference<>(json(200, "{\"removed\":true}")));

        ResponseEntity<Map> missingAck = post("/api/v1/workspaces/" + workspaceId
                + "/checkpoints/cleanup", Map.of("acknowledge", false));
        assertEquals(HttpStatus.BAD_REQUEST, missingAck.getStatusCode());
        assertEquals(0, calls("cleanup"));

        ResponseEntity<Map> response = post("/api/v1/workspaces/" + workspaceId
                + "/checkpoints/cleanup", Map.of("acknowledge", true));
        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(true, response.getBody().get("removed"));
        assertEquals(1, calls("cleanup"));
        assertEquals(0, checkpointRepository.countByWorkspaceId(workspaceId));
    }

    @Test
    void cleanupFailureLeavesProjectionForRetry() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        RESPONSES.put("cleanup", new AtomicReference<>(json(503,
                "{\"code\":\"CHECKPOINT_UNAVAILABLE\",\"reason\":\"runtime_down\"}")));

        ResponseEntity<Map> response = noErrorClient().exchange(
                url("/api/v1/workspaces/" + workspaceId + "/checkpoints/cleanup"), HttpMethod.POST,
                new HttpEntity<>(Map.of("acknowledge", true), authHeaders()), Map.class);

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        assertEquals(1, checkpointRepository.countByWorkspaceId(workspaceId));
    }

    @Test
    void workspaceRoutesUseAccessibleWorkspaceAndRetainGc() {
        RESPONSES.put("gc", new AtomicReference<>(json(200,
                "{\"counts\":{\"deleted\":3,\"kept\":50}}")));
        ResponseEntity<Map> response = post("/api/v1/workspaces/" + workspaceId + "/checkpoints/gc", Map.of());
        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(3, ((Map<?, ?>) response.getBody().get("counts")).get("deleted"));

        Workspace foreign = workspaceRepository.save(new Workspace("cp-foreign-ws", UUID.randomUUID().toString()));
        ResponseEntity<Map> denied = get("/api/v1/workspaces/" + foreign.getId() + "/checkpoints");
        assertEquals(HttpStatus.NOT_FOUND, denied.getStatusCode());
        assertEquals("WORKSPACE_NOT_FOUND", denied.getBody().get("code"));
        assertEquals(1, calls("gc"));
    }

    @Test
    void checkpointRoutesRequireAuthentication() {
        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/checkpoints"), HttpMethod.GET,
                new HttpEntity<>(new HttpHeaders()), String.class);
        assertTrue(response.getStatusCode().is4xxClientError());
        assertFalse(response.getStatusCode().is2xxSuccessful());
    }

    private RestTemplate noErrorClient() {
        RestTemplate client = new RestTemplate();
        client.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) {
                return false;
            }
        });
        return client;
    }
}
