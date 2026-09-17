package com.cc01cc.p.xihe.cp.chat;

import com.sun.net.httpserver.HttpServer;
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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0338: the public Run-scoped checkpoint surface over the slice model —
 * ownership/terminal gates, Runtime passthrough of preview/restore/blob, expired
 * flip, and the workspace-scoped git-status/retention/gc routes. The Runtime is a
 * local stub; everything else (security, JPA, service wiring) is real.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class RunCheckpointControllerTest extends AbstractH2Test {

    private static final String SLICE_REF = "refs/xihe/slices/1757980000000-ab12cd";

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
    private static final String RAW_REQUEST_MARKER = "secret-revert-request-marker";

    private record StubResponse(int status, String body, String contentType) {}

    private static StubResponse json(int status, String body) {
        return new StubResponse(status, body, "application/json");
    }

    private static StubResponse text(String body) {
        return new StubResponse(200, body, "text/plain; charset=utf-8");
    }

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

    /** Static helper usable from the static handler lambda. */
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
        return "other";
    }

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;
    private ChatRun run;

    @BeforeEach
    void setUpCheckpointFixtures() throws IOException {
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
        run = new ChatRun(runId, sessionId, userId, workspaceId, "idem-" + runId, "hash",
                "openai", "gpt-test", "none", "succeeded");
        run.setTerminalOutcome("success");
        run = chatRunRepository.save(run);
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

    private ResponseEntity<Map> post(String path, Object body) {
        return restTemplate.exchange(url(path), HttpMethod.POST,
                new HttpEntity<>(body, authHeaders()), Map.class);
    }

    private static boolean isCapturedState(String state) {
        return RunCheckpoint.STATE_CAPTURED.equals(state)
                || RunCheckpoint.STATE_ABNORMAL_CAPTURED.equals(state);
    }

    private RunCheckpoint seedCheckpoint(String state) {
        return seedCheckpoint(runId, state);
    }

    private RunCheckpoint seedCheckpoint(String checkpointRunId, String state) {
        RunCheckpoint row = new RunCheckpoint();
        row.setId(UUID.randomUUID());
        row.setRunId(checkpointRunId);
        row.setWorkspaceId(workspaceId);
        row.setState(state);
        if (isCapturedState(state)) {
            row.setEndRef(SLICE_REF);
            row.setChangedFiles("[{\"status\":\"M\",\"path\":\"src/a.txt\"}]");
            row.setSealedAt(Instant.now());
        }
        row.setCreatedAt(Instant.now());
        row.setUpdatedAt(Instant.now());
        return checkpointRepository.save(row);
    }

    private int calls(String key) {
        AtomicInteger counter = CALLS.get(key);
        return counter == null ? 0 : counter.get();
    }

    private static String previewBody() {
        return "{\"sliceRef\":\"" + SLICE_REF + "\","
                + "\"counts\":{\"restore\":2,\"delete\":1,\"typeConflict\":1},\"entries\":["
                + "{\"path\":\"src/a.txt\",\"action\":\"restore\",\"state\":\"planned\"},"
                + "{\"path\":\"c.txt\",\"action\":\"restore\",\"state\":\"typeConflict\","
                + "\"reason\":\"TYPE_CHANGED\"}],\"truncated\":false}";
    }

    private static String revertBody() {
        return "{\"sliceRef\":\"" + SLICE_REF + "\","
                + "\"counts\":{\"restored\":2,\"deleted\":1,\"failed\":0},"
                + "\"entries\":[{\"path\":\"src/a.txt\",\"outcome\":\"restored\"}],\"durationMs\":42,"
                + "\"suspects\":[]}";
    }

    // ── Run-scoped projection ───────────────────────────────────────────────

    @Test
    void checkpointProjectionEnforcesRunOwnership() {
        ChatRun foreign = chatRunRepository.save(new ChatRun(UUID.randomUUID().toString(), sessionId,
                UUID.randomUUID().toString(), workspaceId, "idem-foreign", "hash", "openai",
                "gpt-test", "none", "succeeded"));

        ResponseEntity<Map> forbidden = get("/api/v1/chat/runs/" + foreign.getId() + "/checkpoint");
        assertEquals(HttpStatus.FORBIDDEN, forbidden.getStatusCode());
        assertEquals("FORBIDDEN", forbidden.getBody().get("code"));

        ResponseEntity<Map> missing = get("/api/v1/chat/runs/" + UUID.randomUUID() + "/checkpoint");
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertEquals("RUN_NOT_FOUND", missing.getBody().get("code"));

        ResponseEntity<Map> malformed = get("/api/v1/chat/runs/not-a-uuid/checkpoint");
        assertEquals(HttpStatus.NOT_FOUND, malformed.getStatusCode());
    }

    @Test
    void checkpointProjectionReturnsNoneWithoutRow() {
        ResponseEntity<Map> response = get("/api/v1/chat/runs/" + runId + "/checkpoint");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(runId, response.getBody().get("runId"));
        assertEquals("none", response.getBody().get("state"));
        assertEquals(0, response.getBody().get("changedCount"));
        assertNull(response.getBody().get("sealedAt"));
        @SuppressWarnings("unchecked")
        Map<String, Object> revert = (Map<String, Object>) response.getBody().get("revert");
        assertEquals("none", revert.get("state"));
        assertNull(revert.get("counts"));
    }

    @Test
    void checkpointProjectionReturnsCapturedRowAndRevertState() {
        RunCheckpoint row = seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        row.setRevertState(RunCheckpoint.REVERT_ROLLED_BACK);
        row.setRevertRef(SLICE_REF);
        row.setRevertedAt(Instant.parse("2026-09-15T12:00:00Z"));
        row.setRevertSummary("{\"counts\":{\"restored\":1,\"deleted\":0,\"failed\":0}}");
        row.setRevertAttemptCount(1);
        checkpointRepository.save(row);

        ResponseEntity<Map> response = get("/api/v1/chat/runs/" + runId + "/checkpoint");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("captured", response.getBody().get("state"));
        assertEquals(1, response.getBody().get("changedCount"));
        assertNotNull(response.getBody().get("sealedAt"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> files = (List<Map<String, Object>>) response.getBody().get("changedFiles");
        assertEquals(1, files.size());
        assertEquals("src/a.txt", files.get(0).get("path"));
        @SuppressWarnings("unchecked")
        Map<String, Object> revert = (Map<String, Object>) response.getBody().get("revert");
        assertEquals("rolled_back", revert.get("state"));
        assertEquals(SLICE_REF, revert.get("ref"));
        assertEquals("2026-09-15T12:00:00Z", revert.get("at"));
        @SuppressWarnings("unchecked")
        Map<String, Object> counts = (Map<String, Object>) revert.get("counts");
        assertEquals(1, counts.get("restored"));
    }

    // ── Revert preview / execute ────────────────────────────────────────────

    @Test
    void previewRevertRequiresTerminalRunAndNeverCallsRuntime() {
        run.setStatus("running");
        chatRunRepository.save(run);
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        RESPONSES.put("preview", new AtomicReference<>(json(200, previewBody())));

        ResponseEntity<Map> response = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert/preview", null);

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("RUN_ACTIVE", response.getBody().get("code"));
        assertEquals(0, calls("preview"));
    }

    @Test
    void previewRevertPassesThroughSlicePreview() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        RESPONSES.put("preview", new AtomicReference<>(json(200, previewBody())));

        ResponseEntity<Map> response = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert/preview", null);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(SLICE_REF, response.getBody().get("sliceRef"));
        @SuppressWarnings("unchecked")
        Map<String, Object> counts = (Map<String, Object>) response.getBody().get("counts");
        assertEquals(2, counts.get("restore"));
        assertEquals(1, counts.get("typeConflict"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> entries = (List<Map<String, Object>>) response.getBody().get("entries");
        assertEquals(2, entries.size());
        assertEquals("typeConflict", entries.get(1).get("state"));
        assertEquals("TYPE_CHANGED", entries.get(1).get("reason"));
        assertEquals(false, response.getBody().get("truncated"));
        assertEquals(1, calls("preview"));
    }

    @Test
    void previewRevertBlocksDegradedAndReflessRowsWithoutRuntimeCall() {
        RunCheckpoint degraded = seedCheckpoint(RunCheckpoint.STATE_DEGRADED);
        degraded.setUnrollableReason("UNAVAILABLE");
        checkpointRepository.save(degraded);

        ResponseEntity<Map> response = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert/preview", null);

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("CHECKPOINT_NOT_AVAILABLE", response.getBody().get("code"));
        assertTrue(String.valueOf(response.getBody().get("detail")).contains("UNAVAILABLE"));
        assertEquals(0, calls("preview"));

        checkpointRepository.deleteAll();
        RunCheckpoint noRef = seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        noRef.setEndRef(null);
        checkpointRepository.save(noRef);
        ResponseEntity<Map> noSlice = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert/preview", null);
        assertEquals(HttpStatus.CONFLICT, noSlice.getStatusCode());
        assertEquals("CHECKPOINT_NOT_AVAILABLE", noSlice.getBody().get("code"));
        assertEquals(0, calls("preview"));
    }

    @Test
    void previewRevertForwardsTypeConflictsAndExpiresMissingSliceOnce() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        RESPONSES.put("preview", new AtomicReference<>(json(409,
                "{\"code\":\"CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED\",\"paths\":[\"a.txt\",\"b.txt\"]}")));

        ResponseEntity<Map> conflicts = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert/preview", null);
        assertEquals(HttpStatus.CONFLICT, conflicts.getStatusCode());
        assertEquals("CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED", conflicts.getBody().get("code"));

        RESPONSES.put("preview", new AtomicReference<>(json(404, "{\"code\":\"CHECKPOINT_NOT_FOUND\"}")));
        ResponseEntity<Map> expired = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert/preview", null);
        assertEquals(HttpStatus.CONFLICT, expired.getStatusCode());
        assertEquals("CHECKPOINT_NOT_AVAILABLE", expired.getBody().get("code"));
        assertTrue(String.valueOf(expired.getBody().get("detail")).contains("EXPIRED"));
        assertEquals(RunCheckpoint.STATE_EXPIRED,
                checkpointRepository.findByRunIdAndWorkspaceId(runId, workspaceId).orElseThrow().getState());

        ResponseEntity<Map> afterExpiry = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert/preview", null);
        assertEquals(HttpStatus.CONFLICT, afterExpiry.getStatusCode());
        assertEquals("CHECKPOINT_NOT_AVAILABLE", afterExpiry.getBody().get("code"));
        assertEquals(2, calls("preview"), "an expired row must not call the Runtime again");
    }

    @Test
    void revertHappyPathUpdatesRowLedgerAndAttemptCount() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        var operation = operationService.startOperation(userId, sessionId, workspaceId, runId,
                UUID.randomUUID().toString(), "chat", "ui", "user", userId, null, null);
        RESPONSES.put("revert", new AtomicReference<>(json(200, revertBody())));

        ResponseEntity<Map> response = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert",
                Map.of("acknowledgeTypeChanges", List.of(RAW_REQUEST_MARKER)));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(SLICE_REF, response.getBody().get("sliceRef"));
        @SuppressWarnings("unchecked")
        Map<String, Object> counts = (Map<String, Object>) response.getBody().get("counts");
        assertEquals(2, counts.get("restored"));
        assertEquals(42, response.getBody().get("durationMs"));
        assertEquals(1, calls("revert"));

        RunCheckpoint row = checkpointRepository.findByRunIdAndWorkspaceId(runId, workspaceId).orElseThrow();
        assertEquals(RunCheckpoint.REVERT_ROLLED_BACK, row.getRevertState());
        assertEquals(SLICE_REF, row.getRevertRef());
        assertEquals(1, row.getRevertAttemptCount());
        assertNotNull(row.getRevertedAt());
        assertTrue(row.getRevertSummary().contains("\"marker\":\"revert\""));
        assertTrue(row.getRevertSummary().contains("\"sliceRef\":\"" + SLICE_REF + "\""));
        assertTrue(row.getRevertSummary().contains("\"allowedBy\":\"user_ui\""));
        assertFalse(row.getRevertSummary().contains(RAW_REQUEST_MARKER));
        assertFalse(row.getRevertSummary().contains("arguments"));
        assertFalse(row.getRevertSummary().contains("details"));

        List<OperationItem> items = operationItemRepository
                .findByOperationIdOrderBySequenceAsc(operation.operationId().toString());
        OperationItem revertItem = items.stream()
                .filter(item -> "revert_checkpoint".equals(item.getToolName()))
                .findFirst().orElseThrow();
        assertEquals("checkpoint", revertItem.getKind());
        assertEquals("ui", revertItem.getSource());
        assertEquals("completed", revertItem.getStatus());
        assertTrue(revertItem.getArgumentsPreview().contains("\"marker\":\"revert\""));
        assertFalse(revertItem.getArgumentsPreview().contains(RAW_REQUEST_MARKER));
        assertFalse(revertItem.getArgumentsPreview().contains("arguments"));
        assertFalse(revertItem.getArgumentsPreview().contains("details"));
    }

    @Test
    void revertPartialKeepsPartialStateAndFailureReason() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        RESPONSES.put("revert", new AtomicReference<>(json(200,
                "{\"sliceRef\":\"" + SLICE_REF + "\","
                        + "\"counts\":{\"restored\":1,\"deleted\":0,\"failed\":1},"
                        + "\"entries\":[{\"path\":\"c.txt\",\"outcome\":\"failed\","
                        + "\"reason\":\"IO_ERROR\"}],\"durationMs\":7,\"suspects\":[\"c.txt\"]}")));

        ResponseEntity<Map> response = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert", Map.of());

        assertEquals(HttpStatus.OK, response.getStatusCode());
        RunCheckpoint row = checkpointRepository.findByRunIdAndWorkspaceId(runId, workspaceId).orElseThrow();
        assertEquals(RunCheckpoint.REVERT_PARTIAL, row.getRevertState());
        assertTrue(row.getRevertSummary().contains("\"reason\":\"FAILED\""));
        assertTrue(row.getRevertSummary().contains("c.txt"));
    }

    @Test
    void revertMapsRestoreLockedAndTypeChangesRuntimeConflicts() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        RESPONSES.put("revert", new AtomicReference<>(json(409,
                "{\"code\":\"CHECKPOINT_RESTORE_LOCKED\"}")));

        ResponseEntity<Map> locked = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert", Map.of());
        assertEquals(HttpStatus.CONFLICT, locked.getStatusCode());
        assertEquals("CHECKPOINT_RESTORE_LOCKED", locked.getBody().get("code"));

        RESPONSES.put("revert", new AtomicReference<>(json(409,
                "{\"code\":\"CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED\",\"paths\":[\"a.txt\"]}")));
        ResponseEntity<Map> typeChanges = post("/api/v1/chat/runs/" + runId + "/checkpoint/revert", Map.of());
        assertEquals(HttpStatus.CONFLICT, typeChanges.getStatusCode());
        assertEquals("CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED", typeChanges.getBody().get("code"));

        assertEquals(RunCheckpoint.STATE_CAPTURED,
                checkpointRepository.findByRunIdAndWorkspaceId(runId, workspaceId).orElseThrow().getState(),
                "a rejected revert must not change the row");
    }

    @Test
    void checkpointFileReturnsPlainTextAndMapsTooLarge() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        RESPONSES.put("blob", new AtomicReference<>(text("file contents")));

        ResponseEntity<String> ok = restTemplate.exchange(
                url("/api/v1/chat/runs/" + runId + "/checkpoint/file?path=src%2Fa.txt&ref="
                        + "refs%2Fxihe%2Fslices%2F1757980000000-ab12cd"),
                HttpMethod.GET, new HttpEntity<>(authHeaders()), String.class);
        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals("file contents", ok.getBody());
        assertTrue(String.valueOf(ok.getHeaders().getContentType()).contains("text/plain"));

        RESPONSES.put("blob", new AtomicReference<>(json(413,
                "{\"code\":\"CHECKPOINT_BLOB_TOO_LARGE\",\"path\":\"big.bin\",\"size\":9,\"max\":5}")));
        ResponseEntity<Map> tooLarge = get(
                "/api/v1/chat/runs/" + runId + "/checkpoint/file?path=big.bin&ref=" + SLICE_REF);
        assertEquals(413, tooLarge.getStatusCode().value());
        assertEquals("CHECKPOINT_BLOB_TOO_LARGE", tooLarge.getBody().get("code"));
        assertEquals(9, tooLarge.getBody().get("size"));

        RESPONSES.put("blob", new AtomicReference<>(json(404,
                "{\"code\":\"CHECKPOINT_NOT_FOUND\",\"detail\":\"path gone.txt is not present\"}")));
        ResponseEntity<Map> missing = get(
                "/api/v1/chat/runs/" + runId + "/checkpoint/file?path=gone.txt&ref=" + SLICE_REF);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertEquals("CHECKPOINT_NOT_FOUND", missing.getBody().get("code"));
    }

    // ── Workspace-scoped routes ─────────────────────────────────────────────

    @Test
    void workspaceGitStatusIsOwnershipScoped() {
        RESPONSES.put("git-status", new AtomicReference<>(json(200,
                "{\"isRepository\":true,\"entries\":[{\"status\":\"M\",\"path\":\"a.txt\"},"
                        + "{\"status\":\"??\",\"path\":\"new.txt\"}]}")));

        ResponseEntity<Map> ok = get("/api/v1/workspaces/" + workspaceId + "/git-status");
        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals(true, ok.getBody().get("isRepository"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> entries = (List<Map<String, Object>>) ok.getBody().get("entries");
        assertEquals(2, entries.size());
        assertEquals("M", entries.get(0).get("status"));

        Workspace foreign = workspaceRepository.save(new Workspace("cp-foreign-ws", UUID.randomUUID().toString()));
        ResponseEntity<Map> denied = get("/api/v1/workspaces/" + foreign.getId() + "/git-status");
        assertEquals(HttpStatus.NOT_FOUND, denied.getStatusCode());
        assertEquals("WORKSPACE_NOT_FOUND", denied.getBody().get("code"));

        RESPONSES.put("git-status", new AtomicReference<>(json(503,
                "{\"code\":\"CHECKPOINT_UNAVAILABLE\",\"reason\":\"git_unavailable\"}")));
        ResponseEntity<Map> unavailable = noErrorClient().exchange(
                url("/api/v1/workspaces/" + workspaceId + "/git-status"), HttpMethod.GET,
                new HttpEntity<>(authHeaders()), Map.class);
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, unavailable.getStatusCode());
        assertEquals("CHECKPOINT_UNAVAILABLE", unavailable.getBody().get("code"));
    }

    /** 5xx assertions must not go through the throwing default error handler. */
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

    @Test
    void retentionReturnsConstantsAndCurrentCounts() {
        seedCheckpoint(RunCheckpoint.STATE_CAPTURED);
        seedCheckpoint(UUID.randomUUID().toString(), RunCheckpoint.STATE_DEGRADED);

        ResponseEntity<Map> response = get("/api/v1/workspaces/" + workspaceId + "/checkpoints/retention");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(50, response.getBody().get("maxRuns"));
        assertEquals(30, response.getBody().get("ttlDays"));
        assertEquals(true, response.getBody().get("unsealedNeverDeleted"));
        assertEquals(2, response.getBody().get("currentRuns"));
        assertEquals(1, response.getBody().get("currentRefs"));
    }

    @Test
    void gcProxiesRuntimeSweepAndOwnership() {
        RESPONSES.put("gc", new AtomicReference<>(json(200,
                "{\"counts\":{\"deleted\":3,\"kept\":50}}")));

        ResponseEntity<Map> response = post("/api/v1/workspaces/" + workspaceId + "/checkpoints/gc", Map.of());

        assertEquals(HttpStatus.OK, response.getStatusCode());
        @SuppressWarnings("unchecked")
        Map<String, Object> counts = (Map<String, Object>) response.getBody().get("counts");
        assertEquals(3, counts.get("deleted"));
        assertEquals(1, calls("gc"));

        Workspace foreign = workspaceRepository.save(new Workspace("cp-foreign-gc", UUID.randomUUID().toString()));
        ResponseEntity<Map> denied = post("/api/v1/workspaces/" + foreign.getId() + "/checkpoints/gc", Map.of());
        assertEquals(HttpStatus.NOT_FOUND, denied.getStatusCode());
        assertEquals(1, calls("gc"), "foreign workspace must not reach the Runtime");
    }

    @Test
    void checkpointRoutesRequireAuthentication() {
        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/chat/runs/" + runId + "/checkpoint"), HttpMethod.GET,
                new HttpEntity<>(new HttpHeaders()), String.class);
        assertTrue(response.getStatusCode().is4xxClientError(),
                "unauthenticated access must be rejected: " + response.getStatusCode());
        assertFalse(response.getStatusCode().is2xxSuccessful());
    }
}
