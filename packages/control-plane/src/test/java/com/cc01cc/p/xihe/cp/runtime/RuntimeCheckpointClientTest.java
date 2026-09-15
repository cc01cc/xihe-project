package com.cc01cc.p.xihe.cp.runtime;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
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
    }
}
