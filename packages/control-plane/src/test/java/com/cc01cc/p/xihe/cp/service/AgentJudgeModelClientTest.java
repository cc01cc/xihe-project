package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0690 T1.2b CP-1 / spec §1 §3 §5: the real judge transport. A local HTTP server stands in
 * for the Agent endpoint, so the test covers the wire contract — lease reuse, camelCase payload,
 * 200-envelope validation, timeout vs failed mapping — without a real stack.
 */
class AgentJudgeModelClientTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID RUN_ID = UUID.randomUUID();
    private static final String PROMPT = "judge prompt";

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final AtomicReference<String> responseBody = new AtomicReference<>("");
    private final AtomicLong responseStatus = new AtomicLong(200);
    private final AtomicLong responseDelayMs = new AtomicLong();
    private final AtomicReference<String> lastPath = new AtomicReference<>();
    private final AtomicReference<String> lastMethod = new AtomicReference<>();
    private final AtomicReference<String> lastAuth = new AtomicReference<>();
    private final AtomicReference<String> lastRequestId = new AtomicReference<>();
    private final AtomicReference<String> lastBody = new AtomicReference<>();

    private HttpServer server;
    private String baseUrl;
    private SessionRepository sessions;
    private ProviderCredentialLeaseService leases;
    private Session session;

    @BeforeEach
    void setUp() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            lastPath.set(exchange.getRequestURI().getPath());
            lastMethod.set(exchange.getRequestMethod());
            lastAuth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            lastRequestId.set(exchange.getRequestHeaders().getFirst("X-Request-Id"));
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            long delay = responseDelayMs.get();
            if (delay > 0) {
                try {
                    Thread.sleep(delay);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            byte[] bytes = responseBody.get().getBytes(StandardCharsets.UTF_8);
            try {
                exchange.sendResponseHeaders((int) responseStatus.get(), bytes.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(bytes);
                }
            } catch (IOException clientGone) {
                // the timeout test closes the socket before the stub answers
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();

        sessions = mock(SessionRepository.class);
        leases = mock(ProviderCredentialLeaseService.class);
        session = mock(Session.class);
        when(session.getUserId()).thenReturn("user-1");
        when(session.getWorkspaceId()).thenReturn("ws-1");
        when(session.getProviderConnectionId()).thenReturn("conn-1");
        when(session.getModelProvider()).thenReturn("bailian");
        when(session.getConnectionRevision()).thenReturn(7L);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));
        when(leases.issue(anyString(), anyString(), anyString(), any(), anyString(), anyString(),
                anyString(), any(), any()))
                .thenReturn(new ProviderCredentialLeaseService.IssuedLease("lease-token",
                        Instant.now().plusSeconds(30)));
    }

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void successfulEnvelopeReturnsVerdictAndMeteredFacts() throws Exception {
        responseBody.set("{\"status\":\"ok\",\"verdictText\":\"{\\\"speak\\\":true}\","
                + "\"promptTokens\":12,\"completionTokens\":3,\"latencyMs\":25,\"requestId\":\"r-1\"}");

        JudgeModelClient.JudgeVerdict verdict = client(8_000).decide(request());

        assertEquals("{\"speak\":true}", verdict.verdictText());
        assertEquals(12L, verdict.promptTokens());
        assertEquals(3L, verdict.completionTokens());
        assertEquals(25L, verdict.latencyMs());
    }

    @Test
    void requestCarriesTheLeaseAndTheOwnerBindingFromTheSession() throws Exception {
        responseBody.set("{\"status\":\"ok\",\"verdictText\":\"{\\\"speak\\\":false}\"}");

        client(8_000).decide(request());

        assertEquals("/internal/v1/agent/judge/decide", lastPath.get());
        assertEquals("POST", lastMethod.get());
        assertEquals("Bearer test-token", lastAuth.get());
        assertNotNull(lastRequestId.get(), "spec §3: logs need a requestId, so one is sent per call");
        JsonNode payload = objectMapper.readTree(lastBody.get());
        assertEquals("bailian", payload.path("modelProvider").asText());
        assertEquals("decision-model-preview", payload.path("modelName").asText());
        assertEquals(PROMPT, payload.path("prompt").asText());
        assertEquals("lease-token", payload.path("judgeCredentialLease").asText(),
                "the credential travels as a lease, never as the raw secret");
        verify(leases).issue(eq("user-1"), eq("ws-1"), eq(SESSION_ID.toString()),
                eq(RUN_ID.toString()), eq("conn-1"), eq("bailian"), eq("decision-model-preview"),
                eq(7L), eq(AgentJudgeModelClient.LEASE_TTL));
    }

    @Test
    void missingVerdictTextFailsClosed() {
        responseBody.set("{\"status\":\"ok\",\"promptTokens\":1}");

        JudgeModelClient.JudgeException failure = assertThrows(JudgeModelClient.JudgeException.class,
                () -> client(8_000).decide(request()));

        assertEquals(JudgeModelClient.JudgeException.Kind.FAILED, failure.kind());
        assertTrue(failure.getMessage().contains("verdictText"), failure.getMessage());
    }

    @Test
    void nonJsonEnvelopeFailsClosed() {
        responseBody.set("<html>not json</html>");

        JudgeModelClient.JudgeException failure = assertThrows(JudgeModelClient.JudgeException.class,
                () -> client(8_000).decide(request()));

        assertEquals(JudgeModelClient.JudgeException.Kind.FAILED, failure.kind());
        assertTrue(failure.getMessage().contains("not JSON"), failure.getMessage());
    }

    @Test
    void nonOkEnvelopeStatusFailsClosed() {
        responseBody.set("{\"status\":\"error\",\"verdictText\":\"{\\\"speak\\\":true}\"}");

        JudgeModelClient.JudgeException failure = assertThrows(JudgeModelClient.JudgeException.class,
                () -> client(8_000).decide(request()));

        assertEquals(JudgeModelClient.JudgeException.Kind.FAILED, failure.kind());
        assertTrue(failure.getMessage().contains("status=error"), failure.getMessage());
    }

    @Test
    void httpErrorKeepsStatusAndProblemCode() {
        responseStatus.set(409);
        responseBody.set("{\"status\":409,\"code\":\"PROVIDER_CREDENTIAL_LEASE_INVALID\"}");

        JudgeModelClient.JudgeException failure = assertThrows(JudgeModelClient.JudgeException.class,
                () -> client(8_000).decide(request()));

        assertEquals(JudgeModelClient.JudgeException.Kind.FAILED, failure.kind());
        assertTrue(failure.getMessage().contains("409"), failure.getMessage());
        assertTrue(failure.getMessage().contains("PROVIDER_CREDENTIAL_LEASE_INVALID"),
                failure.getMessage());
    }

    @Test
    void requestTimeoutMapsToTimeout() {
        responseDelayMs.set(600);

        JudgeModelClient.JudgeException failure = assertThrows(JudgeModelClient.JudgeException.class,
                () -> client(120).decide(request()));

        assertEquals(JudgeModelClient.JudgeException.Kind.TIMEOUT, failure.kind());
        assertTrue(failure.getMessage().contains("120ms"), failure.getMessage());
    }

    @Test
    void missingMeteredFactsAreRecordedAsZero() throws Exception {
        responseBody.set("{\"status\":\"ok\",\"verdictText\":\"{\\\"speak\\\":true}\"}");

        JudgeModelClient.JudgeVerdict verdict = client(8_000).decide(request());

        assertEquals(0L, verdict.promptTokens());
        assertEquals(0L, verdict.completionTokens());
        assertTrue(verdict.latencyMs() >= 0L, "a missing latency falls back to the measured elapsed time");
    }

    @Test
    void nullSessionContextFailsClosedWithoutCallingTheAgent() {
        JudgeModelClient.JudgeRequest contextless = new JudgeModelClient.JudgeRequest(
                "bailian", "decision-model-preview", PROMPT);

        JudgeModelClient.JudgeException failure = assertThrows(JudgeModelClient.JudgeException.class,
                () -> client(8_000).decide(contextless));

        assertEquals(JudgeModelClient.JudgeException.Kind.FAILED, failure.kind());
        assertTrue(failure.getMessage().contains("owner context"), failure.getMessage());
        assertNull(lastBody.get());
        verifyNoInteractions(leases);
    }

    @Test
    void unboundProviderSessionFailsClosedWithoutCallingTheAgent() {
        when(session.getProviderConnectionId()).thenReturn(null);

        JudgeModelClient.JudgeException failure = assertThrows(JudgeModelClient.JudgeException.class,
                () -> client(8_000).decide(request()));

        assertEquals(JudgeModelClient.JudgeException.Kind.FAILED, failure.kind());
        assertTrue(failure.getMessage().contains("provider binding"), failure.getMessage());
        assertNull(lastBody.get());
        verifyNoInteractions(leases);
    }

    @Test
    void leaseRejectionFailsClosedWithoutCallingTheAgent() {
        when(leases.issue(anyString(), anyString(), anyString(), any(), anyString(), anyString(),
                anyString(), any(), any())).thenThrow(new IllegalStateException("stale revision"));

        JudgeModelClient.JudgeException failure = assertThrows(JudgeModelClient.JudgeException.class,
                () -> client(8_000).decide(request()));

        assertEquals(JudgeModelClient.JudgeException.Kind.FAILED, failure.kind());
        assertTrue(failure.getMessage().contains("lease rejected"), failure.getMessage());
        assertNull(lastBody.get());
    }

    private AgentJudgeModelClient client(long timeoutMs) {
        return new AgentJudgeModelClient(sessions, leases, objectMapper, baseUrl, "test-token",
                timeoutMs);
    }

    private static JudgeModelClient.JudgeRequest request() {
        return new JudgeModelClient.JudgeRequest("bailian", "decision-model-preview", PROMPT,
                SESSION_ID, RUN_ID);
    }
}
