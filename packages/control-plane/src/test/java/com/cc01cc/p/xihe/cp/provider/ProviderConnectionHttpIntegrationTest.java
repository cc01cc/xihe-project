package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.context.TestPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/** Real HTTP, Boot request mapper, advice and isolated pg17 from AbstractIntegrationTest. */
@TestPropertySource(properties = {
        "cp.oauth.encryption-key=",
        "cp.oauth.allow-dev-key=true"
})
class ProviderConnectionHttpIntegrationTest extends AbstractIntegrationTest {

    @Autowired private ObjectMapper mapper;
    @Autowired private ProviderConnectionRepository repository;
    @MockitoSpyBean private ProviderCatalogService catalog;
    @MockitoSpyBean private ProblemDetailsHandler advice;

    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();
    private String token;

    @BeforeEach
    void register() {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest("provider-http-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, "Provider HTTP"), AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        token = response.getBody().getAccessToken();
    }

    @Test
    void createAndPatchRejectUnsupportedPairsAndOperationWithoutMutation() throws Exception {
        var created = send("POST", "", createBody("primary", ""));
        assertEquals(201, created.statusCode());
        JsonNode original = mapper.readTree(created.body());
        String path = "/" + original.path("id").asText();
        long count = repository.count();
        for (String fields : List.of(
                "\"apiTypeId\":\"unknown-type\",\"apiTypeVersion\":1",
                "\"apiTypeId\":\"openai-chat-completions\",\"apiTypeVersion\":999",
                "\"apiTypeId\":\"anthropic-messages\",\"apiTypeVersion\":1")) {
            assertProblem(send("POST", "", createBody("rejected", "," + fields)),
                    400, "PROVIDER_API_TYPE_UNSUPPORTED");
            assertProblem(send("PATCH", path, "{\"label\":\"Rejected\"," + fields + "}"),
                    400, "PROVIDER_API_TYPE_UNSUPPORTED");
        }
        for (String fields : List.of(
                "\"apiTypeId\":null,\"apiTypeVersion\":1",
                "\"apiTypeId\":[],\"apiTypeVersion\":1",
                "\"apiTypeId\":\"openai-chat-completions\"",
                "\"apiTypeVersion\":1",
                "\"apiTypeId\":\"openai-chat-completions\",\"apiTypeVersion\":null",
                "\"apiTypeId\":\"openai-chat-completions\",\"apiTypeVersion\":\"1\"",
                "\"apiTypeId\":\"openai-chat-completions\",\"apiTypeVersion\":1.5",
                "\"apiTypeId\":\"openai-chat-completions\",\"apiTypeVersion\":2147483648")) {
            // PLAN-0439 freezes the pair as a complete non-null Type id/version;
            // malformed shapes are a plain invalid request, not a catalog miss.
            assertProblem(send("POST", "", createBody("rejected", "," + fields)),
                    400, "INVALID_REQUEST");
            assertProblem(send("PATCH", path, "{\"label\":\"Rejected\"," + fields + "}"),
                    400, "INVALID_REQUEST");
        }
        for (String value : List.of("\"chat\"", "\"embedding\"", "null", "{}")) {
            assertProblem(send("POST", "", createBody("rejected", ",\"operation\":" + value)),
                    400, "PROVIDER_CONNECTION_INVALID");
            assertProblem(send("PATCH", path, "{\"operation\":" + value + "}"),
                    400, "PROVIDER_CONNECTION_INVALID");
        }
        for (String value : List.of("\"unsupported-mode\"", "\"" + "x".repeat(33) + "\"")) {
            assertProblem(send("POST", "", createBody("rejected", ",\"modelDiscovery\":" + value)),
                    400, "PROVIDER_CONNECTION_INVALID");
            assertProblem(send("PATCH", path, "{\"modelDiscovery\":" + value + "}"),
                    400, "PROVIDER_CONNECTION_INVALID");
        }
        verify(advice, times(0)).integrityViolation(any(), any());
        assertProblem(send("PATCH", path,
                """
                {"providerId":"anthropic","apiTypeId":"anthropic-messages","apiTypeVersion":1}
                """), 400, "PROVIDER_API_TYPE_UNSUPPORTED");
        assertEquals(count, repository.count());
        var persisted = repository.findById(UUID.fromString(original.path("id").asText())).orElseThrow();
        assertEquals("HTTP connection", persisted.getLabel());
        assertEquals(original.path("revision").asLong(), persisted.getRevision());
        assertEquals("openai-chat-completions", persisted.getApiTypeId());
        assertEquals(1, persisted.getApiTypeVersion());
    }

    @Test
    void createRejectsOmittedNullAndNonStringKeysThroughHttpMapper() throws Exception {
        long before = repository.count();
        String body = createBody("primary", "");
        assertProblem(send("POST", "", body.replace(",\"connectionKey\":\"primary\"", "")),
                400, "PROVIDER_CONNECTION_KEY_INVALID");
        for (String value : List.of("null", "1", "true", "{}", "[]", "\"UPPER\"", "\"\"")) {
            assertProblem(send("POST", "", body.replace("\"connectionKey\":\"primary\"",
                    "\"connectionKey\":" + value)), 400, "PROVIDER_CONNECTION_KEY_INVALID");
        }
        assertEquals(before, repository.count());
    }

    @Test
    void catalogSupportedPairUnknownToTheTypeRegistryIsRejectedWithoutMutation() throws Exception {
        // PLAN-0439 derives the operation from the immutable Type registry: a
        // pair the catalog lists but the registry does not know is a plain
        // invalid request and must never mutate the connection.
        var pair = new com.fasterxml.jackson.databind.ObjectMapper().readTree(
                "{\"apiTypeId\":\"openai-responses\",\"version\":1}");
        doReturn(pair).when(catalog).supportedPair("custom-openai-compatible", "openai-responses", 1);
        var created = send("POST", "", createBody("primary", ""));
        assertEquals(201, created.statusCode());
        String id = mapper.readTree(created.body()).path("id").asText();
        long count = repository.count();
        String fields = "\"apiTypeId\":\"openai-responses\",\"apiTypeVersion\":1";
        assertProblem(send("POST", "", createBody("inactive", "," + fields)),
                400, "PROVIDER_CONNECTION_INVALID");
        assertProblem(send("PATCH", "/" + id, "{" + fields + "}"),
                400, "INVALID_REQUEST");
        var persisted = repository.findById(UUID.fromString(id)).orElseThrow();
        assertEquals("openai-chat-completions", persisted.getApiTypeId());
        assertEquals(1, persisted.getRevision());
        assertEquals(count, repository.count());
    }

    @Test
    void defaultPairAndOmittedTypeUseActualMapperAndPreserveManualModels() throws Exception {
        String fields = ",\"apiTypeId\":\"openai-chat-completions\",\"apiTypeVersion\":1";
        var created = send("POST", "", createBody("primary", fields));
        assertEquals(201, created.statusCode());
        JsonNode body = mapper.readTree(created.body());
        String path = "/" + body.path("id").asText();
        assertEquals("chat", body.path("operation").asText());
        assertEquals("openai-chat-completions", body.path("apiTypeId").asText());
        assertEquals(1, body.path("apiTypeVersion").asInt());
        assertEquals(200, send("PATCH", path, "{\"label\":\"Renamed\"}").statusCode());
        assertEquals(200, send("PATCH", path, "{\"connectionKey\":\"primary\"" + fields + "}")
                .statusCode());
        assertProblem(send("PATCH", path, "{\"connectionKey\":null}"),
                400, "PROVIDER_CONNECTION_KEY_INVALID");
        assertProblem(send("PATCH", path, "{\"connectionKey\":\"renamed\"}"),
                409, "PROVIDER_CONNECTION_KEY_IMMUTABLE");
        var verified = send("POST", path + "/verify", "{}");
        assertEquals(200, verified.statusCode());
        assertEquals("READY", mapper.readTree(verified.body()).path("connection").path("status").asText());
        var persisted = repository.findById(UUID.fromString(body.path("id").asText())).orElseThrow();
        assertEquals("manual", persisted.getModelDiscovery());
        assertEquals(List.of("manual-model"), mapper.readValue(persisted.getManualModels(), List.class));
    }

    @Test
    void concurrentDuplicateReachesPgConstraintAndGlobalAdvice() throws Exception {
        long before = repository.count();
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> send("POST", "", createBody("racing", "", "Racing A")));
            var second = executor.submit(() -> send("POST", "", createBody("racing", "", "Racing B")));
            var responses = List.of(first.get(30, TimeUnit.SECONDS), second.get(30, TimeUnit.SECONDS));
            assertEquals(List.of(201, 409), responses.stream().map(HttpResponse::statusCode).sorted().toList());
            assertProblem(responses.stream().filter(r -> r.statusCode() == 409).findFirst().orElseThrow(),
                    409, "PROVIDER_CONNECTION_KEY_CONFLICT");
        }
        assertEquals(before + 1, repository.count());
        var failure = ArgumentCaptor.forClass(DataIntegrityViolationException.class);
        verify(advice).integrityViolation(failure.capture(), any());
        assertTrue(hasConstraint(failure.getValue(), "uq_provider_connections_owner_provider_key"));
    }

    @Test
    void realPgIntegrityFailureIsNotReportedAsDuplicate() throws Exception {
        long before = repository.count();
        // Service now validates the discovery enum, so exercise a real DB-only failure at the
        // repository boundary (varchar(32) enforced by PG) and map it through the real advice.
        var invalid = new com.cc01cc.p.xihe.cp.entity.ProviderConnection();
        invalid.setId(UUID.randomUUID());
        invalid.setOwnerType("USER");
        invalid.setOwnerId("integrity-owner");
        invalid.setProviderId("custom-openai-compatible");
        invalid.setConnectionKey("integrity");
        invalid.setApiTypeId("openai-chat-completions");
        invalid.setApiTypeVersion(1);
        invalid.setLabel("Integrity");
        invalid.setBaseUrl("https://provider.invalid/v1");
        invalid.setModelDiscovery("x".repeat(33));
        invalid.setEnabled(true);
        invalid.setStatus(com.cc01cc.p.xihe.cp.entity.ProviderConnection.STATUS_UNVERIFIED);

        DataIntegrityViolationException failure = assertThrows(DataIntegrityViolationException.class,
                () -> repository.saveAndFlush(invalid));
        assertEquals(before, repository.count());
        var request = org.mockito.Mockito.mock(jakarta.servlet.http.HttpServletRequest.class);
        var response = advice.integrityViolation(failure, request);
        assertEquals(500, response.getStatusCode().value());
        assertEquals("INTERNAL_ERROR", response.getBody().get("code"));
        assertFalse(hasConstraint(failure, "uq_provider_connections_owner_provider_key"));
        assertTrue(failure.getMostSpecificCause() instanceof java.sql.SQLException);
        assertEquals("22001", ((java.sql.SQLException) failure.getMostSpecificCause()).getSQLState());
    }

    @Test
    void duplicateLabelReturns409WithFieldAndNoMutation() throws Exception {
        long before = repository.count();
        assertEquals(201, send("POST", "", createBody("first", "", "Shared name")).statusCode());

        var conflict = send("POST", "", createBody("second", "", " shared NAME "));

        assertProblem(conflict, 409, "PROVIDER_CONNECTION_LABEL_CONFLICT");
        assertEquals("label", mapper.readTree(conflict.body()).path("field").asText());
        assertEquals(before + 1, repository.count());
    }

    @Test
    void blankAndOverlongLabelsAreRejected() throws Exception {
        var created = send("POST", "", createBody("primary", ""));
        assertEquals(201, created.statusCode());
        String path = "/" + mapper.readTree(created.body()).path("id").asText();

        assertProblem(send("PATCH", path, "{\"label\":\"   \"}"),
                400, "PROVIDER_CONNECTION_INVALID");
        assertProblem(send("PATCH", path, "{\"label\":\"" + "x".repeat(41) + "\"}"),
                400, "PROVIDER_CONNECTION_INVALID");
        assertProblem(send("PATCH", path, "{\"label\":\"bad\\tlabel\"}"),
                400, "PROVIDER_CONNECTION_INVALID");
        assertProblem(send("PATCH", path, "{\"label\":\"bad\u2028label\"}"),
                400, "PROVIDER_CONNECTION_INVALID");
        assertEquals("HTTP connection",
                repository.findById(UUID.fromString(mapper.readTree(created.body()).path("id").asText()))
                        .orElseThrow().getLabel());
    }

    @Test
    void labelUniqueIndexIsMappedToConflictNotServerError() throws Exception {
        String ownerId = "label-index-owner-" + UUID.randomUUID();
        com.cc01cc.p.xihe.cp.entity.ProviderConnection first = scopedConnection(ownerId, "idx-a", "Indexed");
        repository.saveAndFlush(first);
        com.cc01cc.p.xihe.cp.entity.ProviderConnection duplicate =
                scopedConnection(ownerId, "idx-b", " indexed ");

        DataIntegrityViolationException failure = assertThrows(DataIntegrityViolationException.class,
                () -> repository.saveAndFlush(duplicate));
        assertTrue(hasConstraint(failure, "uq_provider_connections_owner_provider_label"));

        var request = org.mockito.Mockito.mock(jakarta.servlet.http.HttpServletRequest.class);
        var response = advice.integrityViolation(failure, request);
        assertEquals(409, response.getStatusCode().value());
        assertEquals("PROVIDER_CONNECTION_LABEL_CONFLICT", response.getBody().get("code"));
        assertEquals("label", response.getBody().get("field"));
    }

    private com.cc01cc.p.xihe.cp.entity.ProviderConnection scopedConnection(
            String ownerId, String key, String label) {
        var connection = new com.cc01cc.p.xihe.cp.entity.ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType("USER");
        connection.setOwnerId(ownerId);
        connection.setProviderId("custom-openai-compatible");
        connection.setConnectionKey(key);
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel(label);
        connection.setBaseUrl("https://provider.invalid/v1");
        connection.setModelDiscovery("manual");
        connection.setEnabled(true);
        connection.setStatus(com.cc01cc.p.xihe.cp.entity.ProviderConnection.STATUS_UNVERIFIED);
        return connection;
    }

    private boolean hasConstraint(Throwable failure, String name) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof org.hibernate.exception.ConstraintViolationException constraint
                    && name.equals(constraint.getConstraintName())) {
                return true;
            }
        }
        return false;
    }

    private HttpResponse<String> send(String method, String path, String body) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create(url("/api/v1/provider-connections" + path)))
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .method(method, HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private void assertProblem(HttpResponse<String> response, int status, String code) throws Exception {
        assertEquals(status, response.statusCode());
        assertTrue(response.headers().firstValue("Content-Type").orElse("").contains("application/problem+json"));
        assertEquals(code, mapper.readTree(response.body()).path("code").asText());
    }

    private String createBody(String key, String extra) {
        return createBody(key, extra, "HTTP connection");
    }

    private String createBody(String key, String extra, String label) {
        return """
                {"providerId":"custom-openai-compatible","label":"%s",
                 "scope":"USER","apiKey":"isolated-test-only","baseUrl":"https://provider.invalid/v1",
                 "modelDiscovery":"manual","manualModels":["manual-model"],"connectionKey":"%s"%s}
                """.formatted(label, key, extra);
    }
}
