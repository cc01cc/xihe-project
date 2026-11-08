package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0647 MVP (D-678/D-687): POST /api/v1/sessions with no workspace surface creates a
 * workspace-less session; an explicit body/header workspace keeps today's behaviour byte-identical.
 */
class WorkspaceLessSessionCreationIntegrationTest extends AbstractIntegrationTest {

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper json;
    @Autowired private SessionRepository sessions;
    @Autowired private ProviderConnectionRepository providerConnections;

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();

    private String token;
    private String userId;
    private String workspaceId;
    private String otherWorkspaceId;
    private String principalId;
    private String connectionId;
    private String providerId;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("wsless-owner");
        token = owner.getAccessToken();
        userId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("wsless ws", userId).getId().toString();
        otherWorkspaceId = workspaceFixture.createOwnedWorkspace("wsless other", userId).getId().toString();
        JsonNode principal = send(workspaceId, "POST", "/api/v1/agent-principals",
                """
                {"name":"WslessAgent"}""").body();
        principalId = principal.path("principalId").asText();
        // A workspace-scoped Session resolves the principal's cap through its active workspace
        // binding (D-49); bind the fixture principal in both workspaces it may be created under.
        assertEquals(200, send(workspaceId, "PUT",
                "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId,
                "{\"permissions\":[]}").status(), "fixture must bind the principal to the workspace");
        assertEquals(200, send(workspaceId, "PUT",
                "/api/v1/workspaces/" + otherWorkspaceId + "/agents/" + principalId,
                "{\"permissions\":[]}").status(), "fixture must bind the principal to the second workspace");
        var binding = ChatBindingTestSupport.ensureChatConnection(
                providerConnections, "USER", userId, "wsless-" + UUID.randomUUID().toString().substring(0, 8));
        connectionId = binding.getId().toString();
        providerId = binding.getProviderId();
    }

    @Test
    void noWorkspaceSurfaceCreatesAWorkspaceLessSession() {
        Reply created = send(null, "POST", "/api/v1/sessions", body(null));
        assertEquals(201, created.status(), created.body().toString());
        String sessionId = created.body().path("id").asText();
        assertTrue(created.body().path("workspaceId").isNull() || created.body().path("workspaceId").isMissingNode(),
                "workspaceless Session must expose workspaceId=null: " + created.body());

        Session row = sessions.findById(UUID.fromString(sessionId)).orElseThrow();
        assertNull(row.getWorkspaceId(), "D-678: no interceptor fallback may assign a workspace");
        assertNull(row.getAgentPermissionsSnapshot(),
                "D-686: the snapshot is null (no cap is derived for a workspace-less Session)");
        assertEquals(userId, row.getUserId());
    }

    @Test
    void explicitHeaderStillCreatesAWorkspaceSession() {
        Reply created = send(workspaceId, "POST", "/api/v1/sessions", body(null));
        assertEquals(201, created.status(), created.body().toString());
        String sessionId = created.body().path("id").asText();
        assertEquals(workspaceId, sessions.findById(UUID.fromString(sessionId)).orElseThrow().getWorkspaceId(),
                "the existing header surface must be byte-identical");
    }

    @Test
    void explicitBodyWorkspaceIdIsAnExplicitWorkspaceSurface() {
        Reply created = send(null, "POST", "/api/v1/sessions", body(otherWorkspaceId));
        assertEquals(201, created.status(), created.body().toString());
        String sessionId = created.body().path("id").asText();
        assertEquals(otherWorkspaceId, sessions.findById(UUID.fromString(sessionId)).orElseThrow().getWorkspaceId(),
                "body workspaceId is explicit: it wins and is membership/write-role checked");
    }

    @Test
    void explicitNullBodyWithHeaderKeepsTheHeaderWorkspace() {
        String payload = """
                {"agentPrincipalId":"%s","title":"t","workspaceId":null,"modelProvider":"%s",
                "modelName":"gpt-test","providerConnectionId":"%s"}"""
                .formatted(principalId, providerId, connectionId);
        Reply created = send(workspaceId, "POST", "/api/v1/sessions", payload);
        assertEquals(201, created.status(), created.body().toString());
        String sessionId = created.body().path("id").asText();
        assertEquals(workspaceId, sessions.findById(UUID.fromString(sessionId)).orElseThrow().getWorkspaceId());
    }

    private String body(String workspaceIdValue) {
        String workspaceField = workspaceIdValue == null ? "" : ",\"workspaceId\":\"" + workspaceIdValue + "\"";
        return """
                {"agentPrincipalId":"%s","title":"wsless","modelProvider":"%s",
                "modelName":"gpt-test","providerConnectionId":"%s"%s}"""
                .formatted(principalId, providerId, connectionId, workspaceField);
    }

    private AuthResponse register(String label) {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(label + "-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, label), AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        return response.getBody();
    }

    private Reply send(String workspaceHeader, String method, String path, String body) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url(path)))
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json");
            if (workspaceHeader != null) {
                builder.header("X-Workspace-Id", workspaceHeader);
            }
            HttpRequest request = builder.method(method, body == null
                            ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            return new Reply(response.statusCode(), json.readTree(
                    response.body() == null || response.body().isBlank() ? "{}" : response.body()));
        } catch (java.io.IOException | InterruptedException e) {
            throw new IllegalStateException("HTTP " + method + " " + path + " failed", e);
        }
    }

    private record Reply(int status, JsonNode body) {}
}
