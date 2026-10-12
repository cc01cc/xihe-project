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
    @Autowired private ProviderCredentialLeaseService leases;
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

    @Test
    void effectiveConnectionSetOverlaysSameKeyFallsBackToUserAndUnionsDistinctKeys() throws Exception {
        JsonNode userShared = createConnection("custom-openai-compatible", "USER", "shared", "manual",
                java.util.List.of("m1"), null, null, "https://provider.invalid/v1", "isolated-test-only");
        JsonNode workspaceShared = createConnection("custom-openai-compatible", "WORKSPACE", "shared", "manual",
                java.util.List.of("m1"), null, null, "https://provider.invalid/v1", "isolated-test-only");

        var effective = templates.effectiveConnections(userId, workspaceId, "custom-openai-compatible");
        assertEquals(1, effective.size());
        assertEquals("WORKSPACE", effective.get(0).getOwnerType());
        assertEquals(workspaceShared.path("id").asText(), effective.get(0).getId().toString());

        var disable = json.createObjectNode().put("enabled", false)
                .put("expectedRevision", workspaceShared.path("revision").asLong());
        assertEquals(200, send("PATCH", "/api/v1/provider-connections/" + workspaceShared.path("id").asText(),
                disable.toString()).statusCode());
        effective = templates.effectiveConnections(userId, workspaceId, "custom-openai-compatible");
        assertEquals(1, effective.size());
        assertEquals("USER", effective.get(0).getOwnerType());
        assertEquals(userShared.path("id").asText(), effective.get(0).getId().toString());

        createConnection("custom-openai-compatible", "USER", "solo", "manual", java.util.List.of("m1"),
                null, null, "https://provider.invalid/v1", "isolated-test-only");
        createConnection("dashscope-qwen", "USER", "emb", "manual",
                java.util.List.of("tongyi-embedding-vision-flash-2026-03-06"),
                "dashscope-multimodal-embedding", 1, null, "isolated-test-only");
        effective = templates.effectiveConnections(userId, workspaceId, "custom-openai-compatible");
        assertEquals(java.util.List.of("shared", "solo"),
                effective.stream().map(com.cc01cc.p.xihe.cp.entity.ProviderConnection::getConnectionKey).toList(),
                "the embedding connection must stay out of the Chat slot set");
        assertTrue(templates.effectiveConnections(userId, workspaceId, "openai").isEmpty());
    }

    @Test
    void credentialKeysAreRejectedAndImpactPreviewMatchesCrossScopeRemovals() throws Exception {
        for (String body : java.util.List.of(
                "{\"model\":\"${xh.model}\",\"messages\":[\"${xh.user_input}\"],\"apiKey\":\"leak\"}",
                "{\"model\":\"${xh.model}\",\"messages\":[\"${xh.user_input}\"],\"authorization\":\"Bearer leak\"}",
                "{\"model\":\"${xh.model}\",\"messages\":[\"${xh.user_input}\"],\"baseurl\":\"https://evil.invalid\"}")) {
            var response = send("POST", "/api/v1/api-input-types/openai-chat-completions/versions/1/validate",
                    json.writeValueAsString(Map.of("bodySource", body)));
            assertEquals(200, response.statusCode());
            assertEquals(false, json.readTree(response.body()).path("valid").asBoolean(), body);
        }

        var catalogDefinition = (com.fasterxml.jackson.databind.node.ObjectNode) catalog.require("custom-openai-compatible");
        originalSupportedPairs = catalogDefinition.path("supportedApiTypes").deepCopy();
        ((com.fasterxml.jackson.databind.node.ArrayNode) catalogDefinition.path("supportedApiTypes"))
                .add(json.createObjectNode().put("apiTypeId", "anthropic-messages").put("version", 1));

        String material = "credential-material-" + UUID.randomUUID();
        JsonNode connection = createConnection("custom-openai-compatible", "WORKSPACE", "impact", "manual",
                java.util.List.of("m1", "m2"), null, null, "https://provider.invalid/v1", material);
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

        var innerA = json.createObjectNode();
        innerA.set("m1", openai);
        innerA.set("m2", openai);
        var modelsA = json.createObjectNode();
        modelsA.set(id, innerA);
        assertEquals(200, send("PUT", "/api/v1/config/user/api-request-templates",
                json.writeValueAsString(Map.of("providerModelBindings", modelsA.toString()))).statusCode());

        var second = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest("template-http-b-" + UUID.randomUUID() + "@test.com", TestDataFactory.PASSWORD, "Template HTTP B"),
                AuthResponse.class);
        assertEquals(201, second.getStatusCode().value());
        assertNotNull(second.getBody());
        String userB = second.getBody().getUser().getId();
        // A second user-scope row for the same connection (the user-scope write
        // path itself is exercised by the request above; the token workspace
        // claim is JWT-bound, so a second scope is seeded directly).
        var innerB = json.createObjectNode();
        innerB.set("m1", openai);
        var modelsB = json.createObjectNode();
        modelsB.set(id, innerB);
        jdbc.update("INSERT INTO config (id, layer, domain, config_key, config_value, user_id, updated_at, created_at) "
                        + "VALUES (?, 'user', 'api-request-templates', 'providerModelBindings', ?, ?, now(), now())",
                UUID.randomUUID(), modelsB.toString(), UUID.fromString(userB));

        Session pinned = new Session(workspaceId, userId, "Rebind count");
        pinned.setId(UUID.randomUUID());
        pinned.setProviderConnectionId(id);
        sessions.saveAndFlush(pinned);

        var preview = send("GET", "/api/v1/provider-connections/" + id
                + "/api-type-change-impact?apiTypeId=anthropic-messages&version=1", null);
        assertEquals(200, preview.statusCode(), preview.body());
        JsonNode impact = json.readTree(preview.body());
        assertEquals(3, impact.path("incompatibleOverrides").get(0).path("count").asInt(), preview.body());
        assertEquals(1, impact.path("sessionRebindCount").asInt(), preview.body());

        var patch = json.createObjectNode().put("apiTypeId", "anthropic-messages").put("apiTypeVersion", 1)
                .put("expectedRevision", connection.path("revision").asLong()).put("confirmedTypeChange", true);
        patch.set("connectionDefaultTemplateRef", anthropic);
        assertEquals(200, send("PATCH", "/api/v1/provider-connections/" + id, patch.toString()).statusCode());
        assertEquals(0, bindingCount(token, id));
        Integer remainingB = jdbc.queryForObject(
                "SELECT count(*) FROM config WHERE layer='user' AND domain='api-request-templates' "
                        + "AND user_id = ? AND config_value LIKE ?",
                Integer.class, UUID.fromString(userB), "%" + id + "%");
        assertEquals(0, remainingB, "the second user scope must lose its overrides too");

        Integer leaked = jdbc.queryForObject(
                "SELECT count(*) FROM config WHERE domain='api-request-templates' AND config_value LIKE ?",
                Integer.class, "%" + material + "%");
        assertEquals(0, leaked, "credential material must never reach the template config domain");
    }

    @Test
    void catalogWildcardLeaseEnumeratesManualConnectionsWithoutModelRegistration() throws Exception {
        JsonNode connection = createConnection("custom-openai-compatible", "USER", "catalog", "manual",
                java.util.List.of("m1"), null, null, "https://provider.invalid/v1", "isolated-test-only");
        String connectionId = connection.path("id").asText();
        long revision = connection.path("revision").asLong();

        var lease = leases.issue(userId, workspaceId, null, null, connectionId, "custom-openai-compatible", "*");
        assertNotNull(lease.token());
        var grant = leases.redeem(new ProviderCredentialLeaseService.RedeemRequest(
                lease.token(), null, connectionId, "custom-openai-compatible", "*", revision));
        assertEquals("manual", grant.modelDiscovery());
        assertEquals(java.util.List.of("m1"), grant.manualModels());
        assertNotNull(grant.apiKey());

        CpApiException failure = assertThrows(CpApiException.class, () -> leases.issue(
                userId, workspaceId, null, null, connectionId, "custom-openai-compatible", "not-registered"));
        assertEquals("INVALID_REQUEST", failure.getCode());
    }

    private JsonNode createConnection(String provider, String scope, String key, String discovery,
                                      java.util.List<String> models, String apiTypeId, Integer apiTypeVersion,
                                      String baseUrl, String apiKey) throws Exception {
        var node = json.createObjectNode().put("providerId", provider).put("label", "T3.2 " + key).put("scope", scope)
                .put("apiKey", apiKey).put("modelDiscovery", discovery).put("connectionKey", key);
        node.set("manualModels", json.valueToTree(models));
        if (baseUrl != null) {
            node.put("baseUrl", baseUrl);
        }
        if (apiTypeId != null) {
            node.put("apiTypeId", apiTypeId).put("apiTypeVersion", apiTypeVersion);
        }
        var created = send("POST", "/api/v1/provider-connections", node.toString());
        assertEquals(201, created.statusCode(), created.body());
        JsonNode connection = json.readTree(created.body());
        var verified = send("POST", "/api/v1/provider-connections/" + connection.path("id").asText() + "/verify", null);
        assertEquals(200, verified.statusCode(), verified.body());
        return json.readTree(verified.body()).path("connection");
    }

    private int bindingCount(String bearer, String connectionId) throws Exception {
        var layer = json.readTree(sendAs(bearer, workspaceId, "GET",
                "/api/v1/config/api-request-templates?layer=user", null).body());
        JsonNode node = json.readTree(layer.path("providerModelBindings").asText()).path(connectionId);
        return node.isObject() ? node.size() : 0;
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
        return sendAs(token, workspaceId, method, path, body);
    }

    private HttpResponse<String> sendAs(String bearer, String workspace, String method, String path, String body) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create(url(path))).timeout(Duration.ofSeconds(20))
                .header("Authorization", "Bearer " + bearer).header("X-Workspace-Id", workspace)
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
