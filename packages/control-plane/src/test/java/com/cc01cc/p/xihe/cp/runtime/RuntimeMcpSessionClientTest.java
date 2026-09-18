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

import static org.junit.jupiter.api.Assertions.*;

/**
 * PLAN-0366 T1.1：Runtime `mcp/servers` 读通道的传输契约（无需 Docker）。
 */
class RuntimeMcpSessionClientTest {

    private HttpServer server;
    private final AtomicReference<String> lastMethod = new AtomicReference<>();
    private final AtomicReference<String> lastPath = new AtomicReference<>();
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
    void fetchServersUsesInternalGetWithServiceAuth() throws IOException {
        String url = startServer((method, path) -> new Stub(200,
                "{\"servers\":[{\"server_id\":\"fs\",\"state\":\"ready\"}],\"count\":1}"));
        RuntimeMcpSessionClient client = new RuntimeMcpSessionClient(url, "test-token");

        RuntimeMcpSessionClient.Result result = client.fetchServers("ws-1");

        assertFalse(result.unreachable());
        assertEquals(200, result.status());
        assertTrue(result.body().contains("\"server_id\":\"fs\""));
        assertEquals("GET", lastMethod.get());
        assertEquals("/internal/v1/runtime/workspaces/ws-1/mcp/servers", lastPath.get());
        assertEquals("Bearer test-token", lastAuth.get());
    }

    @Test
    void fetchServersKeepsNon2xxForTheCallerToTranslate() throws IOException {
        String url = startServer((method, path) -> new Stub(409,
                "{\"code\":\"WORKSPACE_DESTROYING\",\"status\":409}"));
        RuntimeMcpSessionClient client = new RuntimeMcpSessionClient(url, "test-token");

        RuntimeMcpSessionClient.Result result = client.fetchServers("ws-1");

        assertFalse(result.unreachable(), "an HTTP error response still reached Runtime");
        assertEquals(409, result.status());
        assertTrue(result.body().contains("WORKSPACE_DESTROYING"));
    }

    @Test
    void fetchServersReportsTransportFailureAsUnreachable() {
        RuntimeMcpSessionClient client =
                new RuntimeMcpSessionClient("http://127.0.0.1:1", "test-token");

        RuntimeMcpSessionClient.Result result = client.fetchServers("ws-1");

        assertTrue(result.unreachable());
    }
}
