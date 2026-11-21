package com.cc01cc.p.xihe.cp.config;

import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The direct-attach capability probe the first-run seed talks to, without a real runtime (task-148).
 *
 * <p>A local {@link HttpServer} on an ephemeral port is the cheapest honest stub: the seed only asks
 * one question of the runtime ({@code POST /internal/v1/runtime/capabilities/direct-attach/probe}),
 * and the answer's {@code available} flag is the one switch these tests need to flip. Same shape as
 * {@code controller/ExecutionModeAuthorityTest}, but with the flag mutable so a single test can watch
 * the seed refuse a workspace first and create it after the runtime starts answering {@code true}.</p>
 *
 * <p>This class deliberately extends nothing: the context-reuse scanner only buckets classes that
 * extend an integration base, and this is a helper, not a context.</p>
 */
final class FirstRunSeedProbeStub {

    private static final String PROBE_PATH = "/internal/v1/runtime/capabilities/direct-attach/probe";

    private final HttpServer server;
    private final AtomicBoolean available;
    private final String executionMode;

    private FirstRunSeedProbeStub(boolean available, String executionMode) {
        this.available = new AtomicBoolean(available);
        this.executionMode = executionMode;
        try {
            this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException failure) {
            throw new UncheckedIOException("cannot start the direct-attach probe stub", failure);
        }
        this.server.createContext(PROBE_PATH, exchange -> {
            byte[] body = body().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
            exchange.close();
        });
        this.server.start();
    }

    static FirstRunSeedProbeStub reportingAvailability(boolean available, String executionMode) {
        return new FirstRunSeedProbeStub(available, executionMode);
    }

    String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** Flip the answer the probe gives, without restarting anything. */
    void answerAvailable(boolean now) {
        available.set(now);
    }

    void stop() {
        server.stop(0);
    }

    private String body() {
        return "{\"contractVersion\":\"v1\",\"backendKind\":\"windows-mxc\",\"backendRevision\":\"builtin\","
                + "\"maturity\":\"experimental\",\"executionMode\":\"" + executionMode + "\","
                + "\"available\":" + available.get() + "}";
    }
}
