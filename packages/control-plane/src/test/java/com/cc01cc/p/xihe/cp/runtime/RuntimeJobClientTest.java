package com.cc01cc.p.xihe.cp.runtime;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0366 T1.3：Runtime `jobs/cancel` 的 CP 侧调用契约（无需 Docker）。
 * 冻结口径：POST `{jobId}` → 200 `{jobId,status:cancelled|failed}`；404 → notFound；
 * 非 2xx / 未知状态 / 不可解析 → unreachable（由 CP 折叠 502，不臆造取消成功）。
 */
class RuntimeJobClientTest {

    private HttpServer server;
    private final AtomicReference<String> lastMethod = new AtomicReference<>();
    private final AtomicReference<String> lastPath = new AtomicReference<>();
    private final AtomicReference<String> lastBody = new AtomicReference<>();
    private final AtomicReference<String> lastAuth = new AtomicReference<>();

    private record Stub(int status, String body) { }

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
    void cancelJobSendsJobIdAndParsesCancelled() throws IOException {
        String url = startServer((method, path) ->
                new Stub(200, "{\"jobId\":\"job-1\",\"status\":\"cancelled\"}"));
        RuntimeJobClient client = new RuntimeJobClient(url, "test-token");

        RuntimeJobClient.JobCancelResult result = client.cancelJob("ws-1", "job-1");

        assertTrue(result.reachable());
        assertTrue(result.found());
        assertEquals("cancelled", result.status());
        assertEquals("POST", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/jobs/cancel", lastPath.get());
        assertEquals("Bearer test-token", lastAuth.get());
        assertTrue(lastBody.get().contains("\"jobId\":\"job-1\""));
    }

    @Test
    void cancelJobSurfacesUnconfirmedTerminationAsFailedStatus() throws IOException {
        String url = startServer((method, path) ->
                new Stub(200, "{\"jobId\":\"job-2\",\"status\":\"failed\"}"));
        RuntimeJobClient client = new RuntimeJobClient(url, "test-token");

        RuntimeJobClient.JobCancelResult result = client.cancelJob("ws-1", "job-2");

        assertTrue(result.reachable());
        assertTrue(result.found());
        assertEquals("failed", result.status());
    }

    @Test
    void cancelJobMaps404ToNotFound() throws IOException {
        String url = startServer((method, path) -> new Stub(404,
                "{\"code\":\"JOB_NOT_FOUND\",\"status\":404}"));
        RuntimeJobClient client = new RuntimeJobClient(url, "test-token");

        RuntimeJobClient.JobCancelResult result = client.cancelJob("ws-1", "missing");

        assertTrue(result.reachable());
        assertFalse(result.found());
    }

    @Test
    void cancelJobTreats5xxAndUnknownStatusAsUnreachable() throws IOException {
        String url = startServer((method, path) -> new Stub(500, "{\"code\":\"RUNTIME_ERROR\"}"));
        RuntimeJobClient client = new RuntimeJobClient(url, "test-token");
        assertFalse(client.cancelJob("ws-1", "job-3").reachable());

        String weird = startServer((method, path) -> new Stub(200, "{\"status\":\"weird\"}"));
        RuntimeJobClient second = new RuntimeJobClient(weird, "test-token");
        assertFalse(second.cancelJob("ws-1", "job-4").reachable(),
                "unknown status must not be reported as a successful cancel");
    }
}
