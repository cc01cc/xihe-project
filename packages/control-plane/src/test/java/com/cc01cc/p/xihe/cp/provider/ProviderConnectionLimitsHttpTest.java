package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0622 M1.5 (A6 blocker): the resource-limit configuration must round-trip over HTTP.
 *
 * <p>Before this test the entity carried the four columns and the governor read them, but nothing
 * parsed the PATCH body and nothing projected them on read — so a caller could never configure a
 * limit and the governor always saw {@code UNLIMITED}. These assertions are the write-side producer
 * the governor depends on.</p>
 */
class ProviderConnectionLimitsHttpTest extends AbstractIntegrationTest {

    @Autowired private com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository connections;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper json;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private String token;
    private String connectionId;

    @BeforeEach
    void seedConnection() {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest("limits-" + UUID.randomUUID() + "@test.com", TestDataFactory.PASSWORD, "Limits"),
                AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        token = response.getBody().getAccessToken();
        String userId = response.getBody().getUser().getId();
        workspaceFixture.createOwnedWorkspace("Limits ws", userId);

        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType(ProviderConnection.OWNER_USER);
        connection.setOwnerId(userId);
        connection.setProviderId("openai");
        connection.setConnectionKey("limits-" + UUID.randomUUID().toString().substring(0, 8));
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel("Limits connection");
        connection.setStatus(ProviderConnection.STATUS_READY);
        connectionId = connections.saveAndFlush(connection).getId().toString();
    }

    @Test
    void patchedLimitsArePersistedAndProjectedBack() throws Exception {
        Reply patched = send("PATCH", connectionPath(),
                """
                {"maxInflight":1,"maxQueue":2,"windowTokenBudget":100000,"windowSeconds":60}""");
        assertEquals(200, patched.status(), patched.body().toString());

        JsonNode view = read();
        assertEquals(1, view.path("maxInflight").asInt());
        assertEquals(2, view.path("maxQueue").asInt());
        assertEquals(100000L, view.path("windowTokenBudget").asLong());
        assertEquals(60, view.path("windowSeconds").asInt());
        assertTrue(view.path("modelLimits").isArray(), view.toString());
    }

    @Test
    void modelLimitsReplaceWholesaleAndCanBeCleared() throws Exception {
        assertEquals(200, send("PATCH", connectionPath(),
                """
                {"modelLimits":[{"provider":"openai","model":"gpt-4o","maxInflight":3},
                                 {"provider":"openai","model":"gpt-4o-mini","windowTokenBudget":5}]}""")
                .status());
        JsonNode withRows = read().path("modelLimits");
        assertEquals(2, withRows.size(), withRows.toString());
        assertEquals(3, withRows.get(0).path("maxInflight").asInt());

        // full replacement: a new list must not merge with the previous rows
        assertEquals(200, send("PATCH", connectionPath(),
                """
                {"modelLimits":[{"provider":"openai","model":"gpt-4o"}]}""").status());
        assertEquals(1, read().path("modelLimits").size());

        // `[]` clears every row
        assertEquals(200, send("PATCH", connectionPath(), """
                {"modelLimits":[]}""").status());
        assertEquals(0, read().path("modelLimits").size());
    }

    @Test
    void omittingModelLimitsLeavesTheRowsUntouched() throws Exception {
        assertEquals(200, send("PATCH", connectionPath(),
                """
                {"modelLimits":[{"provider":"openai","model":"gpt-4o","maxQueue":1}]}""").status());
        assertEquals(200, send("PATCH", connectionPath(),
                """
                {"label":"Limits connection renamed"}""").status());

        JsonNode view = read();
        assertEquals("Limits connection renamed", view.path("label").asText());
        assertEquals(1, view.path("modelLimits").size(), "an unrelated PATCH must not clear the rows");
    }

    @Test
    void anIllegalLimitIsRejectedWith400() throws Exception {
        Reply rejected = send("PATCH", connectionPath(), """
                {"maxInflight":0}""");
        assertEquals(400, rejected.status(), rejected.body().toString());
        assertFalse(rejected.body().path("code").isMissingNode(), "a stable problem code is required");
    }

    @Test
    void aMalformedModelLimitEntryIsRejectedWith400() throws Exception {
        assertEquals(400, send("PATCH", connectionPath(), """
                {"modelLimits":[{"provider":"openai"}]}""").status());
    }

    private String connectionPath() {
        return "/api/v1/provider-connections/" + connectionId;
    }

    private JsonNode read() throws Exception {
        // The single-connection GET does not exist; the list is the read surface (and the one the
        // UI/CLI actually consume), so the projection is asserted through it.
        Reply reply = send("GET", "/api/v1/provider-connections", null);
        assertEquals(200, reply.status(), reply.body().toString());
        for (JsonNode item : reply.body().path("connections")) {
            if (connectionId.equals(item.path("id").asText())) {
                return item;
            }
        }
        throw new AssertionError("connection not listed: " + connectionId + " in " + reply.body());
    }

    private Reply send(String method, String path, String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url(path)))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        return new Reply(response.statusCode(), json.readTree(response.body()));
    }

    private record Reply(int status, JsonNode body) {
    }
}
