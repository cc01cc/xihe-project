package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Real HTTP mapper/security/service/PG tests; no production data or provider network. */
@TestPropertySource(properties = {
        "cp.provider-credentials.encryption-key=", "cp.provider-credentials.allow-dev-key=true",
        "cp.oauth.encryption-key=", "cp.oauth.allow-dev-key=true"
})
class ApiRequestTemplateHttpIntegrationTest extends AbstractIntegrationTest {
    @Autowired private ObjectMapper json;
    @Autowired private ConfigService config;
    @Autowired private SessionRepository sessions;
    @Autowired private com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository connections;
    @Autowired private ApiRequestTemplateService templates;
    @Autowired private org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Autowired private ProviderCatalogService catalog;
    private JsonNode originalSupportedPairs;

    @org.junit.jupiter.api.AfterEach
    void restoreCatalogFixture() {
        if (originalSupportedPairs != null) {
            ((com.fasterxml.jackson.databind.node.ObjectNode) catalog.require("custom-openai-compatible"))
                    .set("supportedApiTypes", originalSupportedPairs);
        }
    }
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private String token;
    private String workspaceId;
    private String userId;

    @BeforeEach
    void register() {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest("template-http-" + UUID.randomUUID() + "@test.com", TestDataFactory.PASSWORD, "Template HTTP"),
                AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        token = response.getBody().getAccessToken();
        workspaceId = response.getBody().getWorkspaceId();
        userId = response.getBody().getUser().getId();
    }

    @Test
    void builtinsAreUserVisibleAndDraftSourceRoundTripsBeforeImmutablePublish() throws Exception {
        var builtin = send("GET", "/api/v1/config/api-request-templates?layer=instance", null);
        assertEquals(200, builtin.statusCode());
        JsonNode definitions = json.readTree(json.readTree(builtin.body()).path("templates").asText());
        assertEquals(3, definitions.size());
        String source = "{\n  \"model\":\"${xh.model}\", \"messages\":[{\"role\":\"user\",\"content\":\"${xh.user_input}\"}]\n}";
        String id = UUID.randomUUID().toString();
        var draft = json.createObjectNode().put("id", id).put("version", 1).put("name", "Raw source")
                .put("description", "isolated").put("apiTypeId", "openai-chat-completions").put("apiTypeVersion", 1)
                .put("bodySource", "invalid provider JSON is permitted in a draft").put("status", "draft");
        assertEquals(200, putTemplate(draft).statusCode());
        draft.put("bodySource", source);
        assertEquals(200, putTemplate(draft).statusCode());
        var read = send("GET", "/api/v1/config/api-request-templates?layer=user", null);
        assertEquals(source, json.readTree(json.readTree(read.body()).path("templates").asText()).get(0).path("bodySource").asText());
        draft.put("status", "published");
        assertEquals(200, putTemplate(draft).statusCode());
        draft.put("name", "Changed published name");
        assertProblem(putTemplate(draft), 409, "API_REQUEST_TEMPLATE_REVISION_IMMUTABLE");
        assertProblem(send("PUT", "/api/v1/config/user/api-request-templates", json.writeValueAsString(Map.of("templates", "[]"))),
                409, "API_REQUEST_TEMPLATE_REVISION_IMMUTABLE");
    }

    @Test
    void independentValidatorRejectsDuplicateKeysConflictsAndWrongPositionsWithoutWrites() throws Exception {
        for (String body : java.util.List.of(
                "{\"model\":\"${xh.model}\",\"model\":\"literal\",\"messages\":[]}",
                "{\"model\":\"literal\",\"messages\":[]}",
                "{\"model\":\"${xh.model}\",\"messages\":[],\"tools\":[{\"name\":\"forged\"}]}",
                "{\"model\":\"${xh.model}\",\"messages\":[{\"${xh.user_input}\":\"x\"}]}",
                "{\"model\":\"${xh.model}\",\"messages\":[\"prefix ${xh.conversation_history}\"]}",
                "{\"model\":\"${xh.model}\",\"messages\":[\"${xh.user_input\"]}")) {
            var response = send("POST", "/api/v1/api-input-types/openai-chat-completions/versions/1/validate",
                    json.writeValueAsString(Map.of("bodySource", body)));
            assertEquals(200, response.statusCode());
            assertEquals(false, json.readTree(response.body()).path("valid").asBoolean());
            assertTrue(json.readTree(response.body()).path("diagnostics").size() > 0);
        }
        var response = send("POST", "/api/v1/api-input-types/openai-chat-completions/versions/1/validate",
                json.writeValueAsString(Map.of("bodySource", "{\"model\":\"${xh.model}\",\"messages\":[\"${other.literal}\",\"$${xh.unknown}\"]}")));
        assertEquals(200, response.statusCode());
        assertEquals(true, json.readTree(response.body()).path("valid").asBoolean());
    }

    @Test
    void invalidIdentifiersAre400AndGenericDeleteCannotBypassPublicationGuard() throws Exception {
        var invalid = json.createObjectNode().put("id", "invalid-uuid").put("version", 1).put("name", "Invalid")
                .put("apiTypeId", "openai-chat-completions").put("apiTypeVersion", 1).put("bodySource", "{}").put("status", "draft");
        assertProblem(putTemplate(invalid), 400, "INVALID_REQUEST");
        assertProblem(send("PUT", "/api/v1/config/user/api-request-templates",
                json.writeValueAsString(Map.of("providerModelBindings", "{\"invalid-id\":{}}"))), 400, "INVALID_REQUEST");
        CpApiException failure = assertThrows(CpApiException.class, () -> config.deleteKey("user", ApiRequestTemplateService.DOMAIN,
                "templates", "test", UUID.fromString(userId), null));
        assertEquals("API_REQUEST_TEMPLATE_REVISION_IMMUTABLE", failure.getCode());
    }

    @Test
    void schemaAndEntityKeepUnboundSessionUnboundOnOrdinaryUpdate() {
        Session session = new Session(workspaceId, userId, "Unbound");
        session.setId(UUID.randomUUID());
        session = sessions.saveAndFlush(session);
        assertNull(session.getContextTemplateId());
        session.setTitle("Metadata only");
        session = sessions.saveAndFlush(session);
        assertNull(sessions.findById(session.getId()).orElseThrow().getContextTemplateVersion());
        Session unbound = session;
        CpApiException failure = assertThrows(CpApiException.class, () -> templates.admissionSnapshot(unbound));
        assertEquals("API_TYPE_REBIND_REQUIRED", failure.getCode());
        assertThrows(org.springframework.dao.DataIntegrityViolationException.class, () -> jdbc.update(
                "UPDATE sessions SET context_template_layer = ? WHERE id = ?", "instance", unbound.getId()));
        assertNull(sessions.findById(unbound.getId()).orElseThrow().getContextTemplateLayer());
    }

    @Test
    void connectionTypeCasSerializesWritersAndAtomicallyClearsIncompatibleModelOverrides() throws Exception {
        // Test-only catalog fixture: production supported pairs remain frozen.
        var catalogDefinition = (com.fasterxml.jackson.databind.node.ObjectNode) catalog.require("custom-openai-compatible");
        originalSupportedPairs = catalogDefinition.path("supportedApiTypes").deepCopy();
        var supported = (com.fasterxml.jackson.databind.node.ArrayNode) catalogDefinition.path("supportedApiTypes");
        supported.add(json.createObjectNode().put("apiTypeId", "anthropic-messages").put("version", 1));
        var created = send("POST", "/api/v1/provider-connections", """
                {"providerId":"custom-openai-compatible","label":"Type CAS","scope":"USER",
                 "apiKey":"isolated-test-only","baseUrl":"https://provider.invalid/v1",
                 "modelDiscovery":"manual","manualModels":["manual-model"],"connectionKey":"type-cas"}
                """);
        assertEquals(201, created.statusCode(), created.body());
        JsonNode connection = json.readTree(created.body());
        String id = connection.path("id").asText();
        JsonNode definitions = json.readTree(json.readTree(send("GET",
                "/api/v1/config/api-request-templates?layer=instance", null).body()).path("templates").asText());
        JsonNode openai = null;
        JsonNode anthropic = null;
        for (JsonNode definition : definitions) {
            if (definition.path("apiTypeId").asText().equals("openai-chat-completions")) {
                openai = ref(definition);
            }
            if (definition.path("apiTypeId").asText().equals("anthropic-messages")) {
                anthropic = ref(definition);
            }
        }
        assertNotNull(openai);
        assertNotNull(anthropic);
        var models = json.createObjectNode().set(id, json.createObjectNode().set("manual-model", openai));
        assertEquals(200, send("PUT", "/api/v1/config/user/api-request-templates",
                json.writeValueAsString(Map.of("providerModelBindings", models.toString()))).statusCode());
        var patch = json.createObjectNode().put("apiTypeId", "anthropic-messages").put("apiTypeVersion", 1)
                .put("expectedRevision", connection.path("revision").asLong()).put("confirmedTypeChange", true);
        patch.set("connectionDefaultTemplateRef", anthropic);
        String body = patch.toString();
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> send("PATCH", "/api/v1/provider-connections/" + id, body));
            var second = executor.submit(() -> send("PATCH", "/api/v1/provider-connections/" + id, body));
            var results = java.util.List.of(first.get(30, java.util.concurrent.TimeUnit.SECONDS),
                    second.get(30, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals(java.util.List.of(200, 409), results.stream().map(HttpResponse::statusCode).sorted().toList(),
                    results.stream().map(HttpResponse::body).toList().toString());
            assertProblem(results.stream().filter(r -> r.statusCode() == 409).findFirst().orElseThrow(),
                    409, "CONNECTION_REVISION_CHANGED");
        }
        JsonNode layer = json.readTree(send("GET", "/api/v1/config/api-request-templates?layer=user", null).body());
        JsonNode storedModels = json.readTree(layer.path("providerModelBindings").asText());
        assertTrue(!storedModels.has(id) || storedModels.path(id).isEmpty());
        assertEquals(anthropic, json.readTree(layer.path("connectionDefaultTemplates").asText()).path(id));
        var updated = connections.findById(UUID.fromString(id)).orElseThrow();
        assertEquals("anthropic-messages", updated.getApiTypeId());
        assertEquals(connection.path("revision").asLong() + 1, updated.getRevision());
    }

    private JsonNode ref(JsonNode definition) {
        return json.createObjectNode().put("layer", "instance").put("templateId", definition.path("id").asText())
                .put("version", definition.path("version").asInt());
    }

    private HttpResponse<String> putTemplate(JsonNode template) throws Exception {
        return send("PUT", "/api/v1/config/user/api-request-templates",
                json.writeValueAsString(Map.of("templates", json.createArrayNode().add(template).toString())));
    }

    private HttpResponse<String> send(String method, String path, String body) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create(url(path))).timeout(Duration.ofSeconds(20))
                .header("Authorization", "Bearer " + token).header("X-Workspace-Id", workspaceId)
                .header("Content-Type", "application/json").header("X-Request-Id", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private void assertProblem(HttpResponse<String> response, int status, String code) throws Exception {
        assertEquals(status, response.statusCode(), response.body());
        assertEquals(code, json.readTree(response.body()).path("code").asText());
        assertEquals("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                json.readTree(response.body()).path("requestId").asText());
        assertEquals("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                response.headers().firstValue("X-Request-Id").orElseThrow());
    }
}
