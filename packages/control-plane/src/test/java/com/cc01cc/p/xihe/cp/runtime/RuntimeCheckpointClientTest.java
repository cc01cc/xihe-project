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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0328 M2 W3: typed mapping of the Runtime Run-checkpoint contract
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
    void createParsesContractFieldsAndSendsServiceAuth() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"checkpointId\":\"33333333-3333-3333-3333-333333333333\","
                        + "\"runId\":\"run-1\",\"state\":\"base\","
                        + "\"baseRef\":\"refs/xihe/run-1/base\",\"createdAt\":\"2026-09-15T00:00:00Z\"}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.CreateResult result = client.create("ws-1", "run-1", "user-1", "call-1");

        assertEquals(RuntimeCheckpointClient.Outcome.OK, result.outcome());
        assertEquals("33333333-3333-3333-3333-333333333333", result.checkpointId());
        assertEquals("run-1", result.runId());
        assertEquals("base", result.state());
        assertEquals("refs/xihe/run-1/base", result.baseRef());
        assertEquals("2026-09-15T00:00:00Z", result.createdAt());
        assertEquals("POST", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints", lastPath.get());
        assertEquals("Bearer test-token", lastAuth.get());
        assertTrue(lastBody.get().contains("\"runId\":\"run-1\""));
        assertTrue(lastBody.get().contains("\"actor\":\"user-1\""));
        assertTrue(lastBody.get().contains("\"callId\":\"call-1\""));
    }

    @Test
    void createMapsConflictToLeaseHeld() throws IOException {
        String url = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_LEASE_HELD\"}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.CreateResult result = client.create("ws-1", "run-1", "user-1", "call-1");

        assertEquals(RuntimeCheckpointClient.Outcome.LEASE_HELD, result.outcome());
        assertEquals("CHECKPOINT_LEASE_HELD", result.reason());
    }

    @Test
    void createMapsServiceUnavailableWithReason() throws IOException {
        String url = startServer((method, path) -> new Stub(503,
                "{\"code\":\"CHECKPOINT_UNAVAILABLE\",\"reason\":\"git_unavailable\"}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.CreateResult result = client.create("ws-1", "run-1", "user-1", "call-1");

        assertEquals(RuntimeCheckpointClient.Outcome.UNAVAILABLE, result.outcome());
        assertEquals("git_unavailable", result.reason());
    }

    @Test
    void createMapsOtherStatusesAndTransportToTransport() throws IOException {
        String url = startServer((method, path) -> new Stub(500, "boom"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT,
                client.create("ws-1", "run-1", "user-1", "call-1").outcome());

        int closedPort;
        try (ServerSocket socket = new ServerSocket(0)) {
            closedPort = socket.getLocalPort();
        }
        RuntimeCheckpointClient unreachable =
                new RuntimeCheckpointClient("http://127.0.0.1:" + closedPort, "test-token");
        RuntimeCheckpointClient.CreateResult result =
                unreachable.create("ws-1", "run-1", "user-1", "call-1");
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT, result.outcome());
        assertEquals("unreachable", result.reason());
    }

    @Test
    void sealParsesChangedFilesAndFlags() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"runId\":\"run-1\",\"state\":\"sealed\","
                        + "\"changedFiles\":[{\"status\":\"M\",\"path\":\"src/a.txt\"},"
                        + "{\"status\":\"A\",\"path\":\"src/b.txt\"}],"
                        + "\"sealedWithLiveJobs\":true,\"sealedAfterAbnormal\":false}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.SealResult result = client.seal("ws-1", "run-1");

        assertEquals(RuntimeCheckpointClient.Outcome.OK, result.outcome());
        assertEquals("sealed", result.state());
        assertEquals(2, result.changedFiles().size());
        assertEquals("M", result.changedFiles().get(0).status());
        assertEquals("src/a.txt", result.changedFiles().get(0).path());
        assertTrue(result.sealedWithLiveJobs());
        assertFalse(result.sealedAfterAbnormal());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/run-1/seal", lastPath.get());
    }

    @Test
    void sealMapsNotFoundAndUnavailable() throws IOException {
        String notFoundUrl = startServer((method, path) -> new Stub(404, "{\"code\":\"RUN_NOT_FOUND\"}"));
        RuntimeCheckpointClient notFoundClient = new RuntimeCheckpointClient(notFoundUrl, "test-token");
        RuntimeCheckpointClient.SealResult missing = notFoundClient.seal("ws-1", "run-1");
        assertEquals(RuntimeCheckpointClient.Outcome.NOT_FOUND, missing.outcome());
        assertTrue(missing.changedFiles().isEmpty());

        server.stop(0);
        String unavailableUrl = startServer((method, path) -> new Stub(503,
                "{\"reason\":\"checkpoint_not_sealed\"}"));
        RuntimeCheckpointClient unavailableClient = new RuntimeCheckpointClient(unavailableUrl, "test-token");
        RuntimeCheckpointClient.SealResult unavailable = unavailableClient.seal("ws-1", "run-1");
        assertEquals(RuntimeCheckpointClient.Outcome.UNAVAILABLE, unavailable.outcome());
        assertEquals("checkpoint_not_sealed", unavailable.reason());
    }

    @Test
    void statusMapsFoundAndNotFound() throws IOException {
        String url = startServer((method, path) -> path.endsWith("/run-1")
                ? new Stub(200, "{\"runId\":\"run-1\",\"state\":\"sealed\"}")
                : new Stub(404, "{\"code\":\"RUN_NOT_FOUND\"}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.StatusResult found = client.status("ws-1", "run-1");
        assertEquals(RuntimeCheckpointClient.Outcome.OK, found.outcome());
        assertEquals("sealed", found.state());
        assertEquals("GET", lastMethod.get());

        RuntimeCheckpointClient.StatusResult missing = client.status("ws-1", "run-2");
        assertEquals(RuntimeCheckpointClient.Outcome.NOT_FOUND, missing.outcome());
    }

    @Test
    void gcReturnsCounts() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"counts\":{\"deletedRuns\":2,\"keptSealed\":50,\"keptUnsealed\":1}}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.GcResult result = client.gc("ws-1");

        assertEquals(RuntimeCheckpointClient.Outcome.OK, result.outcome());
        Map<String, Object> counts = result.counts();
        assertEquals(2, ((Number) counts.get("deletedRuns")).intValue());
        assertEquals(50, ((Number) counts.get("keptSealed")).intValue());
        assertNotNull(counts.get("keptUnsealed"));
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/gc", lastPath.get());
    }

    @Test
    void blankIdentifiersAreRejectedWithoutCallingRuntime() {
        RuntimeCheckpointClient client = new RuntimeCheckpointClient("http://127.0.0.1:1", "test-token");

        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT,
                client.create(" ", "run-1", "user-1", "call-1").outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT, client.seal("ws-1", "").outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT, client.status("", "run-1").outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT, client.gc(null).outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT, client.previewRevert("ws-1", " ").outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT,
                client.revert(" ", "run-1", List.of(), false).outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.INVALID_REQUEST,
                client.checkpointBlob("ws-1", "run-1", "base", " ").outcome());
        assertEquals(RuntimeCheckpointClient.Outcome.INVALID_REQUEST,
                client.workspaceGitStatus("").outcome());
    }

    // ── PLAN-0328 M3 W2: revert preview / execute / blob / git-status ───────

    @Test
    void previewRevertParsesContractFields() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"runId\":\"run-1\",\"state\":\"sealed\",\"counts\":{\"restore\":2,\"delete\":1,"
                        + "\"skipConflicts\":1,\"noop\":3},\"entries\":["
                        + "{\"path\":\"a.txt\",\"action\":\"restore\"},"
                        + "{\"path\":\"b.txt\",\"action\":\"delete\"},"
                        + "{\"path\":\"c.txt\",\"action\":\"restore\",\"conflictReason\":\"CONTENT_CHANGED\"}],"
                        + "\"headFingerprint\":{\"recorded\":null,\"current\":null,\"status\":\"not_repo\"},"
                        + "\"sealedWithLiveJobs\":true,\"truncated\":false}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.RevertPreview preview = client.previewRevert("ws-1", "run-1");

        assertEquals(RuntimeCheckpointClient.Outcome.OK, preview.outcome());
        assertEquals("run-1", preview.runId());
        assertEquals("sealed", preview.state());
        assertEquals(2, preview.counts().restore());
        assertEquals(1, preview.counts().delete());
        assertEquals(1, preview.counts().skipConflicts());
        assertEquals(3, preview.entries().size());
        assertEquals("CONTENT_CHANGED", preview.entries().get(2).conflictReason());
        assertTrue(preview.sealedWithLiveJobs());
        assertFalse(preview.truncated());
        assertEquals("not_repo", preview.headFingerprint().get("status"));
        assertEquals("POST", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/run-1/revert/preview",
                lastPath.get());
        assertEquals("Bearer test-token", lastAuth.get());
        assertEquals("{}", lastBody.get().trim());
    }

    @Test
    void previewRevertMapsConflictCodesAndKeepsProblemFields() throws IOException {
        String conflictsUrl = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_CONFLICTS_UNACKNOWLEDGED\",\"paths\":[\"a.txt\"]}"));
        RuntimeCheckpointClient.RevertPreview conflicts =
                new RuntimeCheckpointClient(conflictsUrl, "test-token").previewRevert("ws-1", "run-1");
        assertEquals(RuntimeCheckpointClient.Outcome.CONFLICTS_UNACKNOWLEDGED, conflicts.outcome());
        assertEquals(List.of("a.txt"), conflicts.problem().get("paths"));

        server.stop(0);
        String headUrl = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_HEAD_CHANGED\",\"recorded\":{\"commit\":\"a\"},"
                        + "\"observed\":{\"commit\":\"b\"}}"));
        RuntimeCheckpointClient.RevertPreview head =
                new RuntimeCheckpointClient(headUrl, "test-token").previewRevert("ws-1", "run-1");
        assertEquals(RuntimeCheckpointClient.Outcome.HEAD_CHANGED, head.outcome());
        assertNotNull(head.problem().get("recorded"));

        server.stop(0);
        String leaseUrl = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_LEASE_HELD\",\"heldByRunId\":\"run-other\"}"));
        RuntimeCheckpointClient.RevertPreview lease =
                new RuntimeCheckpointClient(leaseUrl, "test-token").previewRevert("ws-1", "run-1");
        assertEquals(RuntimeCheckpointClient.Outcome.LEASE_HELD, lease.outcome());
        assertEquals("run-other", lease.problem().get("heldByRunId"));

        server.stop(0);
        String notSealedUrl = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_NOT_SEALED\"}"));
        assertEquals(RuntimeCheckpointClient.Outcome.NOT_SEALED,
                new RuntimeCheckpointClient(notSealedUrl, "test-token").previewRevert("ws-1", "run-1")
                        .outcome());
    }

    @Test
    void previewRevertMapsNotFoundUnavailableAndTransport() throws IOException {
        String notFoundUrl = startServer((method, path) -> new Stub(404,
                "{\"code\":\"CHECKPOINT_NOT_FOUND\"}"));
        assertEquals(RuntimeCheckpointClient.Outcome.NOT_FOUND,
                new RuntimeCheckpointClient(notFoundUrl, "test-token").previewRevert("ws-1", "run-1")
                        .outcome());

        server.stop(0);
        String unavailableUrl = startServer((method, path) -> new Stub(503,
                "{\"code\":\"CHECKPOINT_UNAVAILABLE\",\"reason\":\"git_unavailable\"}"));
        RuntimeCheckpointClient.RevertPreview unavailable =
                new RuntimeCheckpointClient(unavailableUrl, "test-token").previewRevert("ws-1", "run-1");
        assertEquals(RuntimeCheckpointClient.Outcome.UNAVAILABLE, unavailable.outcome());
        assertEquals("git_unavailable", unavailable.reason());

        int closedPort;
        try (ServerSocket socket = new ServerSocket(0)) {
            closedPort = socket.getLocalPort();
        }
        RuntimeCheckpointClient.RevertPreview transport =
                new RuntimeCheckpointClient("http://127.0.0.1:" + closedPort, "test-token")
                        .previewRevert("ws-1", "run-1");
        assertEquals(RuntimeCheckpointClient.Outcome.TRANSPORT, transport.outcome());
        assertEquals("unreachable", transport.reason());
    }

    @Test
    void revertSendsAcksAndParsesResult() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"runId\":\"run-1\",\"revertRef\":\"refs/xihe/run-1/rollback/9\","
                        + "\"counts\":{\"restored\":2,\"deleted\":1,\"skippedConflict\":1,"
                        + "\"failed\":0,\"noop\":3},\"entries\":["
                        + "{\"path\":\"a.txt\",\"result\":\"restored\"},"
                        + "{\"path\":\"b.txt\",\"result\":\"skippedConflict\",\"reason\":\"CONTENT_CHANGED\"}],"
                        + "\"durationMs\":42}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.RevertResult result =
                client.revert("ws-1", "run-1", List.of("b.txt"), true);

        assertEquals(RuntimeCheckpointClient.Outcome.OK, result.outcome());
        assertEquals("refs/xihe/run-1/rollback/9", result.revertRef());
        assertEquals(2, result.counts().restored());
        assertEquals(1, result.counts().skippedConflict());
        assertEquals(42L, result.durationMs());
        assertEquals("skippedConflict", result.entries().get(1).result());
        assertEquals("CONTENT_CHANGED", result.entries().get(1).reason());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/run-1/revert", lastPath.get());
        assertTrue(lastBody.get().contains("\"acknowledgeConflicts\":[\"b.txt\"]"));
        assertTrue(lastBody.get().contains("\"acknowledgeHeadChange\":true"));
    }

    @Test
    void revertMapsLeaseHeldConflict() throws IOException {
        String url = startServer((method, path) -> new Stub(409,
                "{\"code\":\"CHECKPOINT_LEASE_HELD\",\"heldByRunId\":\"run-live\",\"expiresAtMs\":7}"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.RevertResult result = client.revert("ws-1", "run-1", List.of(), false);

        assertEquals(RuntimeCheckpointClient.Outcome.LEASE_HELD, result.outcome());
        assertEquals("run-live", result.problem().get("heldByRunId"));
        assertTrue(lastBody.get().contains("\"acknowledgeConflicts\":[]"));
        assertTrue(lastBody.get().contains("\"acknowledgeHeadChange\":false"));
    }

    @Test
    void checkpointBlobEncodesPathAndMapsLimitFailures() throws IOException {
        String url = startServer((method, path) -> new Stub(200, "hello blob"));
        RuntimeCheckpointClient client = new RuntimeCheckpointClient(url, "test-token");

        RuntimeCheckpointClient.BlobResult ok = client.checkpointBlob("ws-1", "run-1", "base", "src/a b.txt");

        assertEquals(RuntimeCheckpointClient.Outcome.OK, ok.outcome());
        assertEquals("hello blob", ok.content());
        assertEquals("GET", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/checkpoints/run-1/blob", lastPath.get());
        assertEquals("path=src%2Fa%20b.txt&ref=base", lastQuery.get());

        server.stop(0);
        String tooLargeUrl = startServer((method, path) -> new Stub(413,
                "{\"code\":\"CHECKPOINT_BLOB_TOO_LARGE\",\"path\":\"big.bin\",\"size\":9,\"max\":5}"));
        RuntimeCheckpointClient.BlobResult tooLarge =
                new RuntimeCheckpointClient(tooLargeUrl, "test-token")
                        .checkpointBlob("ws-1", "run-1", "end", "big.bin");
        assertEquals(RuntimeCheckpointClient.Outcome.TOO_LARGE, tooLarge.outcome());
        assertEquals(9, ((Number) tooLarge.problem().get("size")).intValue());

        server.stop(0);
        String invalidUrl = startServer((method, path) -> new Stub(400,
                "{\"code\":\"CHECKPOINT_INVALID_REQUEST\"}"));
        assertEquals(RuntimeCheckpointClient.Outcome.INVALID_REQUEST,
                new RuntimeCheckpointClient(invalidUrl, "test-token")
                        .checkpointBlob("ws-1", "run-1", "base", "../x").outcome());

        server.stop(0);
        String notFoundUrl = startServer((method, path) -> new Stub(404,
                "{\"code\":\"CHECKPOINT_NOT_FOUND\"}"));
        assertEquals(RuntimeCheckpointClient.Outcome.NOT_FOUND,
                new RuntimeCheckpointClient(notFoundUrl, "test-token")
                        .checkpointBlob("ws-1", "run-1", "base", "gone.txt").outcome());
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
    }
}
