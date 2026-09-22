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
    void jobCapabilitiesParsesThe0390Shape() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"backendKind\":\"windows-host\",\"maturity\":\"stable\","
                        + "\"canStart\":true,\"canIsolateFilesystem\":false,"
                        + "\"available\":true,\"unavailableReason\":null}"));
        RuntimeJobClient client = new RuntimeJobClient(url, "test-token");

        RuntimeJobClient.JobCapabilityResult result = client.jobCapabilities("ws-1");

        assertTrue(result.reachable());
        assertFalse(result.containerJobs());
        assertEquals("windows-host", result.capability().path("backendKind").asText());
        assertFalse(result.capability().path("canIsolateFilesystem").asBoolean(true));
        assertEquals("POST", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/jobs/capabilities", lastPath.get());
        assertEquals("Bearer test-token", lastAuth.get());
    }

    @Test
    void jobCapabilitiesMaps501ToTheDockerPath() throws IOException {
        String url = startServer((method, path) -> new Stub(501,
                "{\"code\":\"JOB_BACKEND_LAUNCH_PENDING\"}"));
        RuntimeJobClient client = new RuntimeJobClient(url, "test-token");

        RuntimeJobClient.JobCapabilityResult result = client.jobCapabilities("ws-1");

        assertTrue(result.reachable());
        assertTrue(result.containerJobs());
    }

    @Test
    void jobCapabilitiesSurfacesARuntimeProblemCodeInsteadOfUnreachable() throws IOException {
        String url = startServer((method, path) -> new Stub(422,
                "{\"code\":\"DIRECTORY_NOT_FOUND\",\"status\":422}"));
        RuntimeJobClient client = new RuntimeJobClient(url, "test-token");

        RuntimeJobClient.JobCapabilityResult result = client.jobCapabilities("ws-1");

        assertTrue(result.reachable());
        assertFalse(result.containerJobs());
        assertEquals("DIRECTORY_NOT_FOUND", result.problemCode());
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
    void cancelJobPreservesRuntimeProblemInsteadOfCallingItUnreachable() throws IOException {
        String url = startServer((method, path) -> new Stub(500, "{\"code\":\"RUNTIME_ERROR\"}"));
        RuntimeJobClient client = new RuntimeJobClient(url, "test-token");
        RuntimeJobClient.JobCancelResult problem = client.cancelJob("ws-1", "job-3");
        assertTrue(problem.reachable());
        assertEquals("RUNTIME_ERROR", problem.errorCode());
        assertEquals(500, problem.statusCode());

        String weird = startServer((method, path) -> new Stub(200, "{\"status\":\"weird\"}"));
        RuntimeJobClient second = new RuntimeJobClient(weird, "test-token");
        RuntimeJobClient.JobCancelResult unknownStatus = second.cancelJob("ws-1", "job-4");
        assertFalse(unknownStatus.reachable());
        assertFalse(unknownStatus.found(), "unknown status must not be reported as a successful cancel");
    }

    @Test
    void unknownRuntimeCodeIsMappedToUnmappedErrorWithReasonAndRequestId() throws IOException {
        String url = startServer((method, path) -> new Stub(422,
                "{\"code\":\"NEW_RUNTIME_CODE\",\"detail\":\"why\","
                        + "\"requestId\":\"runtime-rid\",\"status\":422}"));
        RuntimeJobClient client = new RuntimeJobClient(url, "test-token");

        RuntimeJobClient.JobCancelResult result = client.cancelJob("ws-1", "job-5");

        assertTrue(result.reachable());
        assertEquals("UNMAPPED_ERROR", result.errorCode());
        assertEquals("why", result.reason());
        assertEquals("runtime-rid", result.requestId());
        assertEquals(422, result.statusCode());
    }

    @Test
    void startStatusAndOutputPreserveReachableRuntimeProblemCodes() throws IOException {
        String url = startServer((method, path) -> new Stub(422,
                "{\"code\":\"INVALID_PATH\",\"detail\":\"cwd rejected\","
                        + "\"requestId\":\"runtime-rid-2\",\"status\":422}"));
        RuntimeJobClient client = new RuntimeJobClient(url, "test-token");

        RuntimeJobClient.JobStartResult start = client.startJob("ws-1", "item-1", "echo",
                java.util.List.of(), "../outside", 0L, java.util.Map.of());
        RuntimeJobClient.JobStatusResult status = client.jobStatus("ws-1", "job-1");
        RuntimeJobClient.JobOutputResult output = client.jobOutput("ws-1", "job-1", "stdout", 0L, 100L);

        assertEquals("INVALID_PATH", start.errorCode());
        assertEquals("INVALID_PATH", status.errorCode());
        assertEquals("INVALID_PATH", output.errorCode());
        assertEquals("runtime-rid-2", start.requestId());
        assertEquals(422, output.statusCode());
    }
}
