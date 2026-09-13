package com.cc01cc.p.xihe.cp.runtime;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0317 T2.4：Runtime 取消客户端的响应映射（无需 Docker）。
 */
class RuntimeExecutionClientTest {

    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    private String startServer(int status, String body) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> path = new AtomicReference<>();
        AtomicReference<String> auth = new AtomicReference<>();
        server.createContext("/", exchange -> {
            path.set(exchange.getRequestURI().getPath());
            auth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Test
    void mapsConfirmedCancellation() throws IOException {
        String baseUrl = startServer(200, "{\"status\":\"cancelled\",\"confirmed\":true}");
        RuntimeExecutionClient client = new RuntimeExecutionClient(baseUrl, "test-token");

        RuntimeExecutionClient.CancelOutcome outcome = client.cancel("ws-1", "item-1");

        assertTrue(outcome.found());
        assertEquals("cancelled", outcome.status());
        assertTrue(outcome.confirmed());
        assertFalse(outcome.unreachable());
    }

    @Test
    void mapsUnconfirmedCancellation() throws IOException {
        String baseUrl = startServer(200, "{\"status\":\"unconfirmed\",\"confirmed\":false}");
        RuntimeExecutionClient client = new RuntimeExecutionClient(baseUrl, "test-token");

        RuntimeExecutionClient.CancelOutcome outcome = client.cancel("ws-1", "item-1");

        assertTrue(outcome.found());
        assertEquals("unconfirmed", outcome.status());
        assertFalse(outcome.confirmed());
    }

    @Test
    void mapsNotFoundAsMiss() throws IOException {
        String baseUrl = startServer(404, "{\"code\":\"EXECUTION_NOT_FOUND\"}");
        RuntimeExecutionClient client = new RuntimeExecutionClient(baseUrl, "test-token");

        RuntimeExecutionClient.CancelOutcome outcome = client.cancel("ws-1", "item-1");

        assertFalse(outcome.found());
        assertFalse(outcome.unreachable(), "a 404 is a real answer, not a transport failure");
    }

    @Test
    void mapsTransportFailureAsUnreachable() throws IOException {
        int port;
        try (ServerSocket socket = new ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        RuntimeExecutionClient client =
                new RuntimeExecutionClient("http://127.0.0.1:" + port, "test-token");

        RuntimeExecutionClient.CancelOutcome outcome = client.cancel("ws-1", "item-1");

        assertTrue(outcome.unreachable());
        assertFalse(outcome.found());
    }
}
