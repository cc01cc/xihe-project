package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-976 / R18: connection labels are unique per owner layer
 * {@code (owner_type, owner_id, lower(btrim(label)))}. The provider is not part of the key,
 * and the same label stays legal across layers. Real HTTP against the isolated pg17 clone,
 * so the layer-wide expression index is exercised, not just the service pre-check.
 */
class ProviderConnectionLabelUniquenessTest extends AbstractIntegrationTest {

    @Autowired private ObjectMapper mapper;
    @Autowired private ProviderConnectionRepository repository;
    @Autowired private com.cc01cc.p.xihe.cp.integration.WorkspaceFixture workspaceFixture;

    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();
    private String token;
    private String userId;
    private String workspaceId;

    @BeforeEach
    void register() {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest("label-unique-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, "Label Unique"), AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        token = response.getBody().getAccessToken();
        userId = response.getBody().getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("Label unique workspace", userId)
                .getId().toString();
    }

    @Test
    void sameLayerSameLabelAcrossProvidersIs409AndDetailNamesTheLabel() throws Exception {
        long before = repository.count();
        var first = send(null, "POST", "",
                createBody("openai", "DeepSeek 连接", "layer-1"));
        assertEquals(201, first.statusCode(), first.body());

        var conflict = send(null, "POST", "",
                createBody("deepseek", "DeepSeek 连接", "layer-1"));
        assertProblem(conflict, 409, "CONNECTION_LABEL_EXISTS");
        assertTrue(mapper.readTree(conflict.body()).path("detail").asText()
                .contains("DeepSeek 连接"));
        assertEquals(before + 1, repository.count());
    }

    @Test
    void crossLayerSameLabelIsAllowed() throws Exception {
        var user = send(null, "POST", "",
                createBody("openai", "Shared label", "cross-layer-user"));
        assertEquals(201, user.statusCode(), user.body());

        var workspace = send(workspaceId, "POST", "",
                createBody("openai", "Shared label", "cross-layer-workspace").replace(
                        "\"scope\":\"USER\"", "\"scope\":\"WORKSPACE\""));
        assertEquals(201, workspace.statusCode(), workspace.body());

        assertEquals("USER", mapper.readTree(user.body()).path("scope").asText());
        assertEquals("WORKSPACE", mapper.readTree(workspace.body()).path("scope").asText());
    }

    @Test
    void trimAndCaseInsensitiveEquivalenceConflicts() throws Exception {
        long before = repository.count();
        assertEquals(201, send(null, "POST", "",
                createBody("openai", "DeepSeek 连接", "trim-1")).statusCode());

        var conflict = send(null, "POST", "",
                createBody("deepseek", "  deepseek 连接 ", "trim-2"));
        assertProblem(conflict, 409, "CONNECTION_LABEL_EXISTS");
        assertTrue(mapper.readTree(conflict.body()).path("detail").asText()
                .contains("deepseek 连接"));
        assertEquals(before + 1, repository.count());
    }

    @Test
    void renameToExistingSiblingLabelIs409AndKeepsOriginalLabel() throws Exception {
        var a = send(null, "POST", "", createBody("openai", "Primary", "rename-a"));
        var b = send(null, "POST", "", createBody("openai", "Sibling", "rename-b"));
        assertEquals(201, a.statusCode(), a.body());
        assertEquals(201, b.statusCode(), b.body());
        String bId = mapper.readTree(b.body()).path("id").asText();

        var conflict = send(null, "PATCH", "/" + bId, "{\"label\":\" primary \"}");
        assertProblem(conflict, 409, "CONNECTION_LABEL_EXISTS");
        assertTrue(mapper.readTree(conflict.body()).path("detail").asText().contains("primary"));

        assertEquals("Sibling",
                repository.findById(UUID.fromString(bId)).orElseThrow().getLabel());
    }

    @Test
    void concurrentDoubleWriteOnlyOneWins() throws Exception {
        long before = repository.count();
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> send(null, "POST", "",
                    createBody("openai", "Race label", "race-key")));
            var second = executor.submit(() -> send(null, "POST", "",
                    createBody("deepseek", "Race label", "race-key")));
            var responses = List.of(
                    first.get(30, TimeUnit.SECONDS), second.get(30, TimeUnit.SECONDS));
            assertEquals(List.of(201, 409),
                    responses.stream().map(HttpResponse::statusCode).sorted().toList(),
                    responses.stream().map(HttpResponse::body).toList().toString());
            assertProblem(responses.stream().filter(r -> r.statusCode() == 409)
                    .findFirst().orElseThrow(), 409, "CONNECTION_LABEL_EXISTS");
        }
        assertEquals(before + 1, repository.count());
    }

    private HttpResponse<String> send(String workspace, String method, String path, String body)
            throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(
                        URI.create(url("/api/v1/provider-connections" + path)))
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .method(method, HttpRequest.BodyPublishers.ofString(body));
        if (workspace != null) {
            builder.header("X-Workspace-Id", workspace);
        }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private void assertProblem(HttpResponse<String> response, int status, String code)
            throws Exception {
        assertEquals(status, response.statusCode(), response.body());
        assertTrue(response.headers().firstValue("Content-Type").orElse("")
                .contains("application/problem+json"));
        JsonNode problem = mapper.readTree(response.body());
        assertEquals(code, problem.path("code").asText());
        assertEquals("label", problem.path("field").asText());
    }

    private String createBody(String providerId, String label, String key) {
        return """
                {"providerId":"%s","label":"%s","scope":"USER","apiKey":"isolated-test-only",
                 "modelDiscovery":"manual","manualModels":["manual-model"],"connectionKey":"%s"}
                """.formatted(providerId, label, key);
    }
}
