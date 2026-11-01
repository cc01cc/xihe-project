package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
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
 * PLAN-0623 M1a HTTP contract: the participant routes and the {@code asParticipantId} gate.
 *
 * <p>Service-level tests already cover the invariants; these assert the wire behaviour the UI and
 * CLI consume: a non-member is refused with a problem document (not an empty list), a DELETE is a
 * visible soft disable, and speaking as somebody else is refused with the stable
 * {@code PARTICIPANT_CAP_DENIED} code before any run exists.</p>
 */
class SessionParticipantHttpTest extends AbstractIntegrationTest {

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper json;
    @Autowired private com.cc01cc.p.xihe.cp.repository.SessionRepository sessions;
    @Autowired private com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository principals;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private String ownerToken;
    private String strangerToken;
    private String ownerId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("p623-owner");
        AuthResponse stranger = register("p623-stranger");
        ownerToken = owner.getAccessToken();
        strangerToken = stranger.getAccessToken();
        ownerId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("P623 ws", ownerId).getId().toString();

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("P623 agent");
        principal.setScope("WORKSPACE");
        principal.setCreatedByUserId(ownerId);
        principal = principals.saveAndFlush(principal);

        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(workspaceId);
        session.setUserId(ownerId);
        session.setTitle("P623 session");
        session.setAgentPrincipalId(principal.getId().toString());
        sessionId = sessions.saveAndFlush(session).getId().toString();
    }

    @Test
    void aNonMemberGetsAProblemDocumentRatherThanAnEmptyList() throws Exception {
        Reply reply = send(strangerToken, "GET", participantsPath(), null);

        assertEquals(403, reply.status(), reply.body().toString());
        assertFalse(reply.body().path("code").isMissingNode(),
                "the UI distinguishes 'no permission' from 'no members' by the code, not by an empty list");
    }

    @Test
    void deleteSoftDisablesAndTheRowStaysVisible() throws Exception {
        Reply added = send(ownerToken, "POST", participantsPath(),
                """
                {"principalKind":"HUMAN","principalId":"%s","role":"MEMBER"}""".formatted(ownerId));
        assertEquals(201, added.status(), added.body().toString());
        String participantId = added.body().path("participantId").asText();

        assertEquals(204, send(ownerToken, "DELETE", participantsPath() + "/" + participantId, null).status());
        // D23-26: the row survives as a tombstone with disabledAt set — the UI renders it greyed.
        assertEquals(204, send(ownerToken, "DELETE", participantsPath() + "/" + participantId, null).status(),
                "a second DELETE stays an idempotent 204");

        JsonNode list = send(ownerToken, "GET", participantsPath(), null).body();
        JsonNode row = find(list.path("participants"), participantId);
        assertNotNull(row, "the soft-disabled row must still be listed");
        assertFalse(row.path("disabledAt").isNull(), "soft disable sets disabledAt");
        assertTrue(list.path("capabilities").path("manage").asBoolean(), "capabilities ride every list read");
    }

    @Test
    void speakingAsAnotherHumanIsRefusedWithTheStableCode() throws Exception {
        AuthResponse other = register("p623-human");
        assertEquals(201, send(ownerToken, "POST", participantsPath(),
                """
                {"principalKind":"HUMAN","principalId":"%s","role":"MEMBER"}"""
                        .formatted(other.getUser().getId())).status());
        String foreignParticipant = find(send(ownerToken, "GET", participantsPath(), null).body()
                .path("participants"), other.getUser().getId()).path("participantId").asText();

        Reply reply = send(ownerToken, "POST", "/api/v1/chat",
                """
                {"sessionId":"%s","branchId":"%s","content":"hi","asParticipantId":"%s"}"""
                        .formatted(sessionId, UUID.randomUUID(), foreignParticipant));

        assertEquals(403, reply.status(), reply.body().toString());
        assertEquals("PARTICIPANT_CAP_DENIED", reply.body().path("code").asText());
    }

    @Test
    void speakingAsYourselfPassesTheGate() throws Exception {
        Reply added = send(ownerToken, "POST", participantsPath(),
                """
                {"principalKind":"HUMAN","principalId":"%s","role":"MEMBER"}""".formatted(ownerId));
        assertEquals(201, added.status(), added.body().toString());
        String self = added.body().path("participantId").asText();

        Reply reply = send(ownerToken, "POST", "/api/v1/chat",
                """
                {"sessionId":"%s","branchId":"%s","content":"hi","asParticipantId":"%s"}"""
                        .formatted(sessionId, UUID.randomUUID(), self));

        // No SSE subscription in this fixture, so the gate passing is observable as "not 403":
        // the request reaches the SSE precondition (409 SSE_SUBSCRIPTION_REQUIRED).
        assertFalse(reply.status() == 403, reply.body().toString());
        assertFalse("PARTICIPANT_CAP_DENIED".equals(reply.body().path("code").asText()), reply.body().toString());
    }

    private String participantsPath() {
        return "/api/v1/sessions/" + sessionId + "/participants";
    }

    private JsonNode find(JsonNode rows, String key) {
        for (JsonNode row : rows) {
            if (key.equals(row.path("participantId").asText()) || key.equals(row.path("principalId").asText())) {
                return row;
            }
        }
        return null;
    }

    private AuthResponse register(String label) {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(label + "-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, label), AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        return response.getBody();
    }

    private Reply send(String token, String method, String path, String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url(path)))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .header("X-Workspace-Id", workspaceId)
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        return new Reply(response.statusCode(), json.readTree(
                response.body() == null || response.body().isBlank() ? "{}" : response.body()));
    }

    private record Reply(int status, JsonNode body) {
    }

    /** Kept for symmetry with the workspace-scoped token helpers used by neighbouring tests. */
    @SuppressWarnings("unused")
    private String workspaceToken(String userId, String email) {
        return TestDataFactory.createWorkspaceToken(userId, email, WorkspaceRole.OWNER.name(), workspaceId, 0);
    }
}
