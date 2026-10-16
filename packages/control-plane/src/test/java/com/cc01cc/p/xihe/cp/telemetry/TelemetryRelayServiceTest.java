package com.cc01cc.p.xihe.cp.telemetry;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class TelemetryRelayServiceTest {

    private static final String CANARY = "SECRET-CANARY-VALUE";
    private static final String DEPLOYMENT_ID = "deployment-test-0000000000000000";

    private HttpServer server;
    private final AtomicInteger requestCount = new AtomicInteger();
    private final AtomicReference<String> authHeader = new AtomicReference<>();
    private final AtomicReference<String> capturedBody = new AtomicReference<>();
    private final CountDownLatch latch = new CountDownLatch(1);

    @AfterEach
    void tearDown() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    private String startFakeTlm(int status) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/telemetry/events", exchange -> {
            requestCount.incrementAndGet();
            authHeader.set(exchange.getRequestHeaders().getFirst("Authorization"));
            capturedBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
            latch.countDown();
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private TelemetryRelayService service(String url, String token, String gate) {
        ConfigService configService = mock(ConfigService.class);
        when(configService.resolve(TelemetryRelayService.GATE_DOMAIN, TelemetryRelayService.GATE_KEY, null, null))
                .thenReturn(gate);
        DeploymentIdProvider deploymentIdProvider = new DeploymentIdProvider(DEPLOYMENT_ID, "logs");
        return new TelemetryRelayService(configService, new ObjectMapper(), deploymentIdProvider, url, token);
    }

    private static TelemetryEntry structured(String eventId, String type, long timestamp) {
        TelemetryEntry entry = new TelemetryEntry();
        entry.setEventId(eventId);
        entry.setEventType(type);
        entry.setTimestamp(timestamp);
        entry.setLevel("error");
        entry.setErrorCode("TypeError");
        entry.setServiceVersion("0.1.0");
        entry.setReleaseChannel("stable");
        entry.setOsFamily("windows");
        entry.setBrowserFamily("chrome");
        entry.setLang("en-US");
        entry.setScreenBucket("md");
        entry.setAnonSessionId("anon-session-0000000000000000");
        entry.setMessage(CANARY);
        entry.setData(Map.of("blob", CANARY));
        return entry;
    }

    @Test
    void gate_false_sends_nothing() throws Exception {
        String url = startFakeTlm(202);
        TelemetryRelayService service = service(url, "token-1", "false");
        service.forward("b1", List.of(structured("11111111-1111-4111-8111-111111111111",
                "ui.unhandled_error", System.currentTimeMillis())));
        assertFalse(latch.await(400, TimeUnit.MILLISECONDS));
        assertEquals(0, requestCount.get());
        service.shutdown();
    }

    @Test
    void missing_deployment_config_disables_relay() throws Exception {
        String url = startFakeTlm(202);
        TelemetryRelayService service = service(url, "", "true");
        service.forward("b1", List.of(structured("11111111-1111-4111-8111-111111111111",
                "ui.unhandled_error", System.currentTimeMillis())));
        assertFalse(latch.await(400, TimeUnit.MILLISECONDS));
        assertEquals(0, requestCount.get());
        service.shutdown();
    }

    @Test
    void enabled_relays_only_structured_metadata_with_bearer_token() throws Exception {
        String url = startFakeTlm(202);
        TelemetryRelayService service = service(url, "token-abc", "true");
        TelemetryEntry legacy = new TelemetryEntry();
        legacy.setTimestamp(1700000000001L);
        legacy.setLevel("info");
        legacy.setMessage(CANARY);
        service.forward("22222222-2222-4222-8222-222222222222", List.of(
                structured("11111111-1111-4111-8111-111111111111", "ui.unhandled_error", 1700000000000L),
                legacy));

        assertTrue(latch.await(3, TimeUnit.SECONDS));
        assertEquals(1, requestCount.get());
        assertEquals("Bearer token-abc", authHeader.get());
        String body = capturedBody.get();
        assertNotNull(body);
        assertFalse(body.contains(CANARY), "free text must never be relayed");
        JsonNode json = new ObjectMapper().readTree(body);
        assertEquals(1, json.get("schemaVersion").asInt());
        assertEquals("22222222-2222-4222-8222-222222222222", json.get("batchId").asText());
        JsonNode events = json.get("events");
        assertEquals(1, events.size());
        JsonNode event = events.get(0);
        assertEquals("11111111-1111-4111-8111-111111111111", event.get("eventId").asText());
        assertEquals("ui.unhandled_error", event.get("eventType").asText());
        assertEquals("2023-11-14T22:13:20Z", Instant.parse(event.get("occurredAt").asText()).toString());
        assertEquals("ERROR", event.get("fields").get("level").asText());
        assertEquals("TypeError", event.get("fields").get("errorCode").asText());
        JsonNode fields = event.get("fields");
        assertEquals(DEPLOYMENT_ID, fields.get("deploymentId").asText());
        assertEquals("0.1.0", fields.get("serviceVersion").asText());
        assertEquals("stable", fields.get("releaseChannel").asText());
        assertEquals("windows", fields.get("osFamily").asText());
        assertEquals("chrome", fields.get("browserFamily").asText());
        assertEquals("en-US", fields.get("lang").asText());
        assertEquals("md", fields.get("screenBucket").asText());
        assertEquals("anon-session-0000000000000000", fields.get("anonSessionId").asText());
        assertFalse(fields.has("appVersion"), "retired appVersion must not be relayed");
        service.shutdown();
    }

    @Test
    void relay_rejection_does_not_throw_and_drops_central_copy() throws Exception {
        String url = startFakeTlm(500);
        TelemetryRelayService service = service(url, "token", "true");
        service.forward("b", List.of(structured("11111111-1111-4111-8111-111111111111",
                "ui.unhandled_error", System.currentTimeMillis())));
        assertTrue(latch.await(3, TimeUnit.SECONDS));
        assertEquals(1, requestCount.get());
        service.shutdown();
    }
}
