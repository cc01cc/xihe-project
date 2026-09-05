package com.cc01cc.p.xihe.cp.status;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HealthMonitorTest {

    private HttpServer server;
    private HealthMonitor monitor;
    private AtomicBoolean agentAvailable;

    @BeforeEach
    void setUp() throws IOException {
        agentAvailable = new AtomicBoolean(true);
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/internal/v1/agent/health", this::serveAgentHealth);
        server.createContext("/health", this::serveRuntimeHealth);
        server.start();

        monitor = new HealthMonitor();
        String baseUrl = "http://localhost:" + server.getAddress().getPort();
        ReflectionTestUtils.setField(monitor, "agentUrl", baseUrl + "/internal/v1/agent/chat");
        ReflectionTestUtils.setField(monitor, "runtimeUrl", baseUrl + "/internal/v1/runtime/workspaces/default/mcp");
    }

    @AfterEach
    void tearDown() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void pollHealth_parsesAgentReadinessSeparatelyFromLiveness() {
        monitor.pollHealth();

        HealthMonitor.ServiceHealth health = monitor.getAgentHealth();
        assertEquals("up", health.status());
        assertEquals("up", health.liveness());
        assertEquals("ready", health.llmReady());
        assertEquals("rev-1", health.configRevision());
        assertTrue(health.responseMs() >= 0);
    }

    @Test
    void pollHealth_preservesLastReadinessWhenTransportGoesDown() {
        monitor.pollHealth();
        agentAvailable.set(false);

        monitor.pollHealth();

        HealthMonitor.ServiceHealth health = monitor.getAgentHealth();
        assertEquals("down", health.status());
        assertEquals("ready", health.llmReady());
        assertEquals("rev-1", health.configRevision());
    }

    private void serveAgentHealth(HttpExchange exchange) throws IOException {
        if (!agentAvailable.get()) {
            exchange.sendResponseHeaders(503, -1);
            exchange.close();
            return;
        }
        write(exchange, "{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"rev-1\",\"verifiedAt\":\"2026-09-05T13:00:00Z\"}");
    }

    private void serveRuntimeHealth(HttpExchange exchange) throws IOException {
        write(exchange, "{\"status\":\"ok\",\"liveness\":\"up\"}");
    }

    private void write(HttpExchange exchange, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, bytes.length);
        try (var output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }
}
