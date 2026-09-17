package com.cc01cc.p.xihe.cp.runtime;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0338: typed mapping of the Runtime slice-checkpoint contract
 * (no Docker required).
 */
class RuntimeCheckpointClientTest {

    private HttpServer server;
    private final AtomicReference<String> lastMethod = new AtomicReference<>();
    private final AtomicReference<String> lastPath = new AtomicReference<>();
    private final AtomicReference<String> lastQuery = new AtomicReference<>();
    private final AtomicReference<String> lastBody = new AtomicReference<>();
    private final AtomicReference<String> lastAuth = new AtomicReference<>();

    private record Stub(int status, String body) {}

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    private String startServer(BiFunction<String, String, Stub> route) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            lastMethod.set(exchange.getRequestMethod());
            lastPath.set(exchange.getRequestURI().getPath());
            lastQuery.set(exchange.getRequestURI().getRawQuery());
            lastAuth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            Stub stub = route.apply(exchange.getRequestMethod(), exchange.getRequestURI().getPath());
            byte[] bytes = stub.body() == null
                    ? new byte[0] : stub.body().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(stub.status(), bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Test
    void captureParsesContractFieldsAndSendsServiceAuth() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"runId\":\"run-1\",\"noChange\":false,"
                        + "\"sliceRef\":\"refs/xihe/slices/1757980000000-ab12cd\","
                        + "\"commit\":\"ab12cd\",\"capturedAt\":\"2026-09-15T00:00:00Z\","
                        + "\"state\":\"captured\","
                        + "\"changedFiles\":[{\"status\":\"M\",\"path\":\"src/a.txt\"},"
                        + "{\"status\":\"A\",\"path\":\"src/b.txt\"}],"
                        + "\"opaqueNestedRepos\":[\"vendor/lib\"],"
                        + "\"predecessor\":\"refs/xihe/slices/1757900000000-998877\"}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.CaptureResult result =
                client.capture("ws-1", "run-1", "user-1", "call-1", false);

        assertEquals(RuntimeCheckpointClient.Outcome.OK, result.outcome());
        assertEquals("run-1", result.runId());
        assertFalse(result.noChange());
        assertEquals("refs/xihe/slices/1757980000000-ab12cd", result.sliceRef());
        assertEquals("ab12cd", result.commit());
        assertEquals("2026-09-15T00:00:00Z", result.capturedAt());
        assertEquals("captured", result.state());
        assertEquals(2, result.changedFiles().size());
        assertEquals("M", result.changedFiles().get(0).status());
        assertEquals("src/a.txt", result.changedFiles().get(0).path());
        assertEquals(List.of("vendor/lib"), result.opaqueNestedRepos());
        assertEquals("refs/xihe/slices/1757900000000-998877", result.predecessor());
        assertEquals("POST", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/capture", lastPath.get());
        assertEquals("Bearer test-token", lastAuth.get());
        assertTrue(lastBody.get().contains("\"runId\":\"run-1\""));
        assertTrue(lastBody.get().contains("\"actor\":\"user-1\""));
        assertTrue(lastBody.get().contains("\"callId\":\"call-1\""));
        assertTrue(lastBody.get().contains("\"abnormal\":false"));
    }

    @Test
    void captureSendsAbnormalFlagAndParsesNoChange() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"runId\":\"run-1\",\"noChange\":true,\"state\":\"abnormal-captured\","
                        + "\"changedFiles\":[],\"opaqueNestedRepos\":[]}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.CaptureResult result =
                client.capture("ws-1", "run-1", "user-1", "call-1", true);

        assertEquals(RuntimeCheckpointClient.Outcome.OK, result.outcome());
        assertTrue(result.noChange());
        assertEquals("abnormal-captured", result.state());
        assertNull(result.sliceRef());
        assertTrue(result.changedFiles().isEmpty());
        assertTrue(lastBody.get().contains("\"abnormal\":true"));
    }

    @Test
    void captureMapsInvalidRequestAndUnavailable() throws IOException {
        String invalidUrl = startServer((method, path) -> new Stub(400,
                "{\"code\":\"CHECKPOINT_INVALID_REQUEST\"}"));
        RuntimeCheckpointClient.CaptureResult invalid =
                new RuntimeCheckpointClient(invalidUrl, "test-token")
                        .capture("ws-1", "run-1", "user-1", "call-1", false);
        assertEquals(RuntimeCheckpointClient.Outcome.INVALID_REQUEST, invalid.outcome());

        server.stop(0);
        String unavailableUrl = startServer((method, path) -> new Stub(503,
                "{\"code\":\"CHECKPOINT_UNAVAILABLE\",\"reason\":\"git_unavailable\"}"));
        RuntimeCheckpointClient.CaptureResult unavailable =
                new RuntimeCheckpointClient(unavailableUrl, "test-token")
                        .capture("ws-1", "run-1", "user-1", "call-1", false);
        assertEquals(RuntimeCheckpointClient.Outcome.UNAVAILABLE, unavailable.outcome());
        assertEquals("git_unavailable", unavailable.reason());

        server.stop(0);
        String notFoundUrl = startServer((method, path) -> new Stub(404, "{\"code\":\"RUN_NOT_FOUND\"}"));
        RuntimeCheckpointClient.CaptureResult missing =
                new RuntimeCheckpointClient(notFoundUrl, "test-token")
                        .capture("ws-1", "run-1", "user-1", "call-1", false);
        assertEquals(RuntimeCheckpointClient.Outcome.NOT_FOUND, missing.outcome());
    }

    @Test
    void captureMapsOtherStatusesAndTransportToTransport() throws IOException {
        String url = startServer((method, path) -> new Stub(500, "boom"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT,
                client.capture("ws-1", "run-1", "user-1", "call-1", false).outcome());

        int closedPort;
        try (ServerSocket socket = new ServerSocket(0)) {
            closedPort = socket.getLocalPort();
        }
        RuntimeCheckpointClient unreachable =
                new RuntimeCheckpointClient("http://127.0.0.1:" + closedPort, "test-token");
        RuntimeCheckpointClient.CaptureResult result =
                unreachable.capture("ws-1", "run-1", "user-1", "call-1", false);
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT, result.outcome());
        assertEquals("unreachable", result.reason());
    }

    @Test
    void gcReturnsCounts() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"counts\":{\"deleted\":2,\"kept\":50}}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.GcResult result = client.gc("ws-1");

        assertEquals(RuntimeCheckpointClient.Outcome.OK, result.outcome());
        Map<String, Object> counts = result.counts();
        assertEquals(2, ((Number) counts.get("deleted")).intValue());
        assertEquals(50, ((Number) counts.get("kept")).intValue());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/gc", lastPath.get());
    }

    @Test
    void cleanupPostsToWorkspaceRuntimeAndMapsResult() throws IOException {
        String url = startServer((method, path) -> new Stub(200, "{\"removed\":true}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.CleanupResult result = client.cleanup("ws-1");

        assertEquals(RuntimeCheckpointClient.Outcome.OK, result.outcome());
        assertTrue(result.removed());
        assertEquals("POST", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/cleanup", lastPath.get());
        assertEquals("Bearer test-token", lastAuth.get());
        assertEquals("{}", lastBody.get());
    }

    @Test
    void cleanupMapsBusyAndKeepsProblemDetails() throws IOException {
        String url = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_BUSY\",\"reason\":\"capture_in_progress\"}"));
        RuntimeCheckpointClient.CleanupResult result =
                new RuntimeCheckpointClient(url, "test-token").cleanup("ws-1");

        assertEquals(RuntimeCheckpointClient.Outcome.CLEANUP_BUSY, result.outcome());
        assertEquals("CHECKPOINT_BUSY", result.problem().get("code"));
        assertEquals("capture_in_progress", result.reason());
    }

    @Test
    void blankIdentifiersAreRejectedWithoutCallingRuntime() {
        RuntimeCheckpointClient client = new RuntimeCheckpointClient("http://127.0.0.1:1", "test-token");

        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT,
                client.capture(" ", "run-1", "user-1", "call-1", false).outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT, client.gc(null).outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.INVALID_REQUEST, client.cleanup(" ").outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT, client.previewRevert("ws-1", " ").outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT,
                client.revert(" ", "refs/xihe/slices/1-a", List.of()).outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.INVALID_REQUEST,
                client.checkpointBlob("ws-1", "refs/xihe/slices/1-a", " ").outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.INVALID_REQUEST,
                client.workspaceGitStatus("").outcome());
    }

    // ── PLAN-0338: slice preview / restore / blob / git-status ──────────────

    @Test
    void previewRevertSendsSliceRefAndParsesContractFields() throws IOException {
        String sliceRef = "refs/xihe/slices/1757980000000-ab12cd";
        String url = startServer((method, path) -> new Stub(200,
                "{\"sliceRef\":\"" + sliceRef + "\","
                        + "\"counts\":{\"restore\":2,\"delete\":1,\"typeConflict\":1},"
                        + "\"entries\":["
                        + "{\"path\":\"a.txt\",\"action\":\"restore\",\"state\":\"planned\"},"
                        + "{\"path\":\"b.txt\",\"action\":\"delete\",\"state\":\"planned\"},"
                        + "{\"path\":\"c.txt\",\"action\":\"restore\",\"state\":\"typeConflict\","
                        + "\"reason\":\"TYPE_CHANGED\"}],"
                        + "\"truncated\":false}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.RevertPreview preview = client.previewRevert("ws-1", sliceRef);

        assertEquals(RuntimeCheckpointClient.Outcome.OK, preview.outcome());
        assertEquals(sliceRef, preview.sliceRef());
        assertEquals(2, preview.counts().restore());
        assertEquals(1, preview.counts().delete());
        assertEquals(1, preview.counts().typeConflict());
        assertEquals(3, preview.entries().size());
        assertEquals("typeConflict", preview.entries().get(2).state());
        assertEquals("TYPE_CHANGED", preview.entries().get(2).reason());
        assertFalse(preview.truncated());
        assertEquals("POST", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/revert/preview", lastPath.get());
        assertEquals("Bearer test-token", lastAuth.get());
        assertTrue(lastBody.get().contains("\"sliceRef\":\"" + sliceRef + "\""));
    }

    @Test
    void previewRevertMapsRestoreFailureCodes() throws IOException {
        String sliceRef = "refs/xihe/slices/1-a";

        String conflictsUrl = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED\",\"paths\":[\"a.txt\"]}"));
        RuntimeCheckpointClient.RevertPreview conflicts =
                new RuntimeCheckpointClient(conflictsUrl, "test-token").previewRevert("ws-1", sliceRef);
        assertEquals(RuntimeCheckpointClient.Outcome.TYPE_CHANGES_UNACKNOWLEDGED, conflicts.outcome());
        assertEquals(List.of("a.txt"), conflicts.problem().get("paths"));

        server.stop(0);
        String lockedUrl = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_RESTORE_LOCKED\"}"));
        RuntimeCheckpointClient.RevertPreview locked =
                new RuntimeCheckpointClient(lockedUrl, "test-token").previewRevert("ws-1", sliceRef);
        assertEquals(RuntimeCheckpointClient.Outcome.RESTORE_LOCKED, locked.outcome());

        server.stop(0);
        String notSealedUrl = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_NOT_SEALED\"}"));
        assertEquals(RuntimeCheckpointClient.Outcome.NOT_SEALED,
                new RuntimeCheckpointClient(notSealedUrl, "test-token").previewRevert("ws-1", sliceRef)
                        .outcome());
    }

    @Test
    void previewRevertMapsNotFoundUnavailableAndTransport() throws IOException {
        String notFoundUrl = startServer((method, path) -> new Stub(404,
                "{\"code\":\"CHECKPOINT_NOT_FOUND\"}"));
        assertEquals(RuntimeCheckpointClient.Outcome.NOT_FOUND,
                new RuntimeCheckpointClient(notFoundUrl, "test-token")
                        .previewRevert("ws-1", "refs/xihe/slices/1-a").outcome());

        server.stop(0);
        String unavailableUrl = startServer((method, path) -> new Stub(503,
                "{\"code\":\"CHECKPOINT_UNAVAILABLE\",\"reason\":\"git_unavailable\"}"));
        RuntimeCheckpointClient.RevertPreview unavailable =
                new RuntimeCheckpointClient(unavailableUrl, "test-token")
                        .previewRevert("ws-1", "refs/xihe/slices/1-a");
        assertEquals(RuntimeCheckpointClient.Outcome.UNAVAILABLE, unavailable.outcome());
        assertEquals("git_unavailable", unavailable.reason());

        int closedPort;
        try (ServerSocket socket = new ServerSocket(0)) {
            closedPort = socket.getLocalPort();
        }
        RuntimeCheckpointClient.RevertPreview transport =
                new RuntimeCheckpointClient("http://127.0.0.1:" + closedPort, "test-token")
                        .previewRevert("ws-1", "refs/xihe/slices/1-a");
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT, transport.outcome());
        assertEquals("unreachable", transport.reason());
    }

    @Test
    void revertSendsSliceRefAndAcksAndParsesResult() throws IOException {
        String sliceRef = "refs/xihe/slices/1757980000000-ab12cd";
        String url = startServer((method, path) -> new Stub(200,
                "{\"sliceRef\":\"" + sliceRef + "\","
                        + "\"counts\":{\"restored\":2,\"deleted\":1,\"failed\":0},\"entries\":["
                        + "{\"path\":\"a.txt\",\"outcome\":\"restored\"},"
                        + "{\"path\":\"b.txt\",\"outcome\":\"failed\",\"reason\":\"IO_ERROR\"}],"
                        + "\"durationMs\":42,\"suspects\":[\"c.txt\"]}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.RevertResult result =
                client.revert("ws-1", sliceRef, List.of("b.txt"));

        assertEquals(RuntimeCheckpointClient.Outcome.OK, result.outcome());
        assertEquals(sliceRef, result.sliceRef());
        assertEquals(2, result.counts().restored());
        assertEquals(1, result.counts().deleted());
        assertEquals(0, result.counts().failed());
        assertEquals(42L, result.durationMs());
        assertEquals("failed", result.entries().get(1).outcome());
        assertEquals("IO_ERROR", result.entries().get(1).reason());
        assertEquals(List.of("c.txt"), result.suspects());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/revert", lastPath.get());
        assertTrue(lastBody.get().contains("\"sliceRef\":\"" + sliceRef + "\""));
        assertTrue(lastBody.get().contains("\"acknowledgeTypeChanges\":[\"b.txt\"]"));
    }

    @Test
    void revertMapsRestoreFailureCodes() throws IOException {
        String lockedUrl = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_RESTORE_LOCKED\"}"));
        RuntimeCheckpointClient.RevertResult locked =
                new RuntimeCheckpointClient(lockedUrl, "test-token")
                        .revert("ws-1", "refs/xihe/slices/1-a", List.of());
        assertEquals(RuntimeCheckpointClient.Outcome.RESTORE_LOCKED, locked.outcome());

        server.stop(0);
        String conflictsUrl = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED\",\"paths\":[\"a.txt\"]}"));
        RuntimeCheckpointClient.RevertResult conflicts =
                new RuntimeCheckpointClient(conflictsUrl, "test-token")
                        .revert("ws-1", "refs/xihe/slices/1-a", List.of());
        assertEquals(RuntimeCheckpointClient.Outcome.TYPE_CHANGES_UNACKNOWLEDGED, conflicts.outcome());
        assertTrue(lastBody.get().contains("\"acknowledgeTypeChanges\":[]"));

        server.stop(0);
        String notFoundUrl = startServer((method, path) -> new Stub(404,
                "{\"code\":\"CHECKPOINT_NOT_FOUND\"}"));
        assertEquals(RuntimeCheckpointClient.Outcome.NOT_FOUND,
                new RuntimeCheckpointClient(notFoundUrl, "test-token")
                        .revert("ws-1", "refs/xihe/slices/1-a", List.of()).outcome());
    }

    @Test
    void checkpointBlobEncodesSliceRefAndMapsLimitFailures() throws IOException {
        String url = startServer((method, path) -> new Stub(200, "hello blob"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.BlobResult ok =
                client.checkpointBlob("ws-1", "refs/xihe/slices/1-a", "src/a b.txt");

        assertEquals(RuntimeCheckpointClient.Outcome.OK, ok.outcome());
        assertEquals("hello blob", ok.content());
        assertEquals("GET", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/blob", lastPath.get());
        assertEquals("sliceRef=refs%2Fxihe%2Fslices%2F1-a&path=src%2Fa%20b.txt", lastQuery.get());

        server.stop(0);
        String tooLargeUrl = startServer((method, path) -> new Stub(413,
                "{\"code\":\"CHECKPOINT_BLOB_TOO_LARGE\",\"path\":\"big.bin\",\"size\":9,\"max\":5}"));
        RuntimeCheckpointClient.BlobResult tooLarge =
                new RuntimeCheckpointClient(tooLargeUrl, "test-token")
                        .checkpointBlob("ws-1", "refs/xihe/slices/1-a", "big.bin");
        assertEquals(RuntimeCheckpointClient.Outcome.TOO_LARGE, tooLarge.outcome());
        assertEquals(9, ((Number) tooLarge.problem().get("size")).intValue());

        server.stop(0);
        String invalidUrl = startServer((method, path) -> new Stub(400,
                "{\"code\":\"CHECKPOINT_INVALID_REQUEST\"}"));
        assertEquals(RuntimeCheckpointClient.Outcome.INVALID_REQUEST,
                new RuntimeCheckpointClient(invalidUrl, "test-token")
                        .checkpointBlob("ws-1", "refs/xihe/slices/1-a", "../x").outcome());

        server.stop(0);
        String notFoundUrl = startServer((method, path) -> new Stub(404,
                "{\"code\":\"CHECKPOINT_NOT_FOUND\"}"));
        assertEquals(RuntimeCheckpointClient.Outcome.NOT_FOUND,
                new RuntimeCheckpointClient(notFoundUrl, "test-token")
                        .checkpointBlob("ws-1", "refs/xihe/slices/1-a", "gone.txt").outcome());
    }

    @Test
    void gitStatusParsesEntriesAndUnavailableReason() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"isRepository\":true,\"entries\":[{\"status\":\"M\",\"path\":\"a.txt\"},"
                        + "{\"status\":\"??\",\"path\":\"new.txt\"}]}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.GitStatusResult status = client.workspaceGitStatus("ws-1");

        assertEquals(RuntimeCheckpointClient.Outcome.OK, status.outcome());
        assertTrue(status.isRepository());
        assertEquals(2, status.entries().size());
        assertEquals("M", status.entries().get(0).status());
        assertEquals("new.txt", status.entries().get(1).path());
        assertEquals("GET", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/git-status", lastPath.get());

        server.stop(0);
        String unavailableUrl = startServer((method, path) -> new Stub(503,
                "{\"code\":\"CHECKPOINT_UNAVAILABLE\",\"reason\":\"git_below_minimum\"}"));
        RuntimeCheckpointClient.GitStatusResult unavailable =
                new RuntimeCheckpointClient(unavailableUrl, "test-token").workspaceGitStatus("ws-1");
        assertEquals(RuntimeCheckpointClient.Outcome.UNAVAILABLE, unavailable.outcome());
        assertEquals("git_below_minimum", unavailable.reason());
        assertFalse(unavailable.isRepository());
        assertNotNull(unavailable.entries());
    }
}
