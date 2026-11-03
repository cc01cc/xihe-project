package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.RunCheckpointRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0640 T1: revert preview/execution surfaces descendant-session impact
 * (BFS over the durable V37 spawn edge) without blocking the restore.
 */
class RunCheckpointDescendantWarningTest extends AbstractH2Test {

    private static final String PARENT_SLICE = "refs/xihe/slices/1757980000000-parent";
    private static final String CHILD_SLICE = "refs/xihe/slices/1758066400000-child";
    private static final String GRANDCHILD_SLICE = "refs/xihe/slices/1758152800000-grandchild";
    private static final Instant PARENT_CAPTURED_AT = Instant.parse("2026-09-15T00:00:00Z");
    private static final Instant AFTER_PARENT = Instant.parse("2026-09-16T00:00:00Z");
    private static final Instant BEFORE_PARENT = Instant.parse("2026-09-14T00:00:00Z");

    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceFixture workspaceFixture;
    @Autowired
    private SessionRepository sessionRepository;
    @Autowired
    private ChatRunRepository chatRunRepository;
    @Autowired
    private RunCheckpointRepository checkpointRepository;
    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private static HttpServer runtimeServer;
    private static final Map<String, AtomicReference<StubResponse>> RESPONSES = new ConcurrentHashMap<>();
    private static final Map<String, AtomicInteger> CALLS = new ConcurrentHashMap<>();

    private record StubResponse(int status, String body) {}

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        try {
            runtimeServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            runtimeServer.createContext("/", exchange -> {
                String key = exchange.getRequestURI().getPath().endsWith("/revert/preview") ? "preview" : "revert";
                CALLS.computeIfAbsent(key, ignored -> new AtomicInteger()).incrementAndGet();
                StubResponse response = RESPONSES.getOrDefault(key,
                        new AtomicReference<>(new StubResponse(404, "{\"code\":\"CHECKPOINT_NOT_FOUND\"}"))).get();
                byte[] bytes = response.body().getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
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

    private String authToken;
    private String userId;
    private String workspaceId;
    private String parentSessionId;
    private String parentRunId;

    @BeforeEach
    void setUpFixtures() {
        RESPONSES.clear();
        CALLS.clear();

        String email = "cp-desc-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "DescendantWarn"),
                AuthResponse.class);
        assertTrue(reg.getStatusCode().is2xxSuccessful());
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("cp-desc-workspace", userId);
        workspaceId = workspace.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId, WorkspaceRole.OWNER);
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId, 0);

        parentSessionId = UUID.randomUUID().toString();
        Session parent = new Session(workspaceId, userId, "Parent Session");
        parent.setId(UUID.fromString(parentSessionId));
        sessionRepository.save(parent);

        parentRunId = seedRun(parentSessionId);
        seedCheckpoint(PARENT_SLICE, parentRunId, parentSessionId, PARENT_CAPTURED_AT,
                "[{\"status\":\"M\",\"path\":\"src/a.txt\"}]");
    }

    private String seedRun(String sessionUuid) {
        String runUuid = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runUuid, sessionUuid, userId, workspaceId,
                "idem-" + runUuid, "hash", "openai", "gpt-test", "none", "succeeded");
        run.setOrigin(ChatRun.ORIGIN_SPAWN);
        run.setTerminalOutcome("success");
        chatRunRepository.save(run);
        return runUuid;
    }

    private String spawnSession(String spawnedFromSessionUuid) {
        Session child = new Session(workspaceId, userId, "Spawned Session");
        child.setId(UUID.randomUUID());
        child.setKind(Session.KIND_SPAWN);
        child.setSpawnedFromSessionId(UUID.fromString(spawnedFromSessionUuid));
        sessionRepository.save(child);
        return child.getId().toString();
    }

    private RunCheckpoint seedCheckpoint(String sliceRef, String sourceRunId, String sourceSessionId,
                                         Instant capturedAt, String changedFiles) {
        RunCheckpoint row = new RunCheckpoint();
        row.setId(UUID.randomUUID());
        row.setSourceRunId(sourceRunId);
        row.setSourceSessionId(sourceSessionId);
        row.setWorkspaceId(workspaceId);
        row.setRootId(workspaceId);
        row.setSliceRef(sliceRef);
        row.setCapturedAt(capturedAt);
        row.setState(RunCheckpoint.STATE_CAPTURED);
        row.setChangedFiles(changedFiles);
        row.setCreatedAt(Instant.now());
        row.setUpdatedAt(Instant.now());
        return checkpointRepository.save(row);
    }

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private ResponseEntity<Map> post(String path, Object body) {
        return restTemplate.exchange(url(path), HttpMethod.POST,
                new HttpEntity<>(body, authHeaders()), Map.class);
    }

    private int calls(String key) {
        AtomicInteger counter = CALLS.get(key);
        return counter == null ? 0 : counter.get();
    }

    private static String previewStub() {
        return "{\"sliceRef\":\"" + PARENT_SLICE + "\","
                + "\"counts\":{\"restore\":1,\"delete\":0,\"typeConflict\":0},"
                + "\"entries\":[{\"path\":\"src/a.txt\",\"action\":\"restore\",\"state\":\"planned\"}],"
                + "\"truncated\":false}";
    }

    private static String revertStub() {
        return "{\"sliceRef\":\"" + PARENT_SLICE + "\","
                + "\"counts\":{\"restored\":1,\"deleted\":0,\"failed\":0},"
                + "\"entries\":[{\"path\":\"src/a.txt\",\"outcome\":\"restored\"}],"
                + "\"durationMs\":7,\"suspects\":[]}";
    }

    @Test
    void previewWarnsWhenDescendantSliceOverlapsRollbackPaths() {
        String childSessionId = spawnSession(parentSessionId);
        String childRunId = seedRun(childSessionId);
        seedCheckpoint(CHILD_SLICE, childRunId, childSessionId, AFTER_PARENT,
                "[{\"status\":\"A\",\"path\":\"src/child-a.txt\"},"
                        + "{\"status\":\"M\",\"path\":\"src/a.txt\"}]");
        RESPONSES.put("preview", new AtomicReference<>(new StubResponse(200, previewStub())));

        ResponseEntity<Map> response = post("/api/v1/workspaces/" + workspaceId
                + "/checkpoints/revert/preview", Map.of("sliceRef", PARENT_SLICE));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        List<?> affected = (List<?>) response.getBody().get("descendantsAffected");
        assertEquals(1, affected.size());
        Map<?, ?> impacted = (Map<?, ?>) affected.get(0);
        assertEquals(childSessionId, impacted.get("sessionId"));
        List<?> paths = (List<?>) impacted.get("overlappingPaths");
        assertTrue(paths.contains("src/child-a.txt"));
        assertTrue(paths.contains("src/a.txt"));
    }

    @Test
    void previewOmitsDescendantsWithoutPostTargetSlices() {
        String childSessionId = spawnSession(parentSessionId);
        String childRunId = seedRun(childSessionId);
        seedCheckpoint(CHILD_SLICE, childRunId, childSessionId, BEFORE_PARENT,
                "[{\"status\":\"A\",\"path\":\"src/child-a.txt\"}]");
        RESPONSES.put("preview", new AtomicReference<>(new StubResponse(200, previewStub())));

        ResponseEntity<Map> response = post("/api/v1/workspaces/" + workspaceId
                + "/checkpoints/revert/preview", Map.of("sliceRef", PARENT_SLICE));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(List.of(), response.getBody().get("descendantsAffected"));
    }

    @Test
    void previewTracesMultiLevelSpawnChain() {
        String childSessionId = spawnSession(parentSessionId);
        String childRunId = seedRun(childSessionId);
        seedCheckpoint(CHILD_SLICE, childRunId, childSessionId, BEFORE_PARENT,
                "[{\"status\":\"A\",\"path\":\"src/child-a.txt\"}]");
        String grandchildSessionId = spawnSession(childSessionId);
        String grandchildRunId = seedRun(grandchildSessionId);
        seedCheckpoint(GRANDCHILD_SLICE, grandchildRunId, grandchildSessionId, AFTER_PARENT,
                "[{\"status\":\"A\",\"path\":\"src/grandchild-a.txt\"}]");
        RESPONSES.put("preview", new AtomicReference<>(new StubResponse(200, previewStub())));

        ResponseEntity<Map> response = post("/api/v1/workspaces/" + workspaceId
                + "/checkpoints/revert/preview", Map.of("sliceRef", PARENT_SLICE));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        List<?> affected = (List<?>) response.getBody().get("descendantsAffected");
        assertEquals(1, affected.size());
        Map<?, ?> impacted = (Map<?, ?>) affected.get(0);
        assertEquals(grandchildSessionId, impacted.get("sessionId"));
        assertTrue(((List<?>) impacted.get("overlappingPaths")).contains("src/grandchild-a.txt"));
    }

    @Test
    void revertWarnsWithoutBlockingRestore() {
        String childSessionId = spawnSession(parentSessionId);
        String childRunId = seedRun(childSessionId);
        seedCheckpoint(CHILD_SLICE, childRunId, childSessionId, AFTER_PARENT,
                "[{\"status\":\"A\",\"path\":\"src/child-a.txt\"}]");
        RESPONSES.put("revert", new AtomicReference<>(new StubResponse(200, revertStub())));

        ResponseEntity<Map> response = post("/api/v1/workspaces/" + workspaceId
                + "/checkpoints/revert", Map.of("sliceRef", PARENT_SLICE,
                "acknowledgeTypeChanges", List.of()));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(1, calls("revert"));
        List<?> affected = (List<?>) response.getBody().get("descendantsAffected");
        assertEquals(1, affected.size());
        Map<?, ?> impacted = (Map<?, ?>) affected.get(0);
        assertEquals(childSessionId, impacted.get("sessionId"));
        assertTrue(((List<?>) impacted.get("overlappingPaths")).contains("src/child-a.txt"));
        RunCheckpoint row = checkpointRepository
                .findByWorkspaceIdAndSliceRef(workspaceId, PARENT_SLICE).orElseThrow();
        assertEquals(RunCheckpoint.REVERT_ROLLED_BACK, row.getRevertState());
    }
}
