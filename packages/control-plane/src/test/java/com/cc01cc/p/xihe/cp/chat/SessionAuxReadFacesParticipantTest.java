package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * BL-299: the three auxiliary session read faces opened to an invited enabled HUMAN participant,
 * and the write face that deliberately stayed owner-only.
 *
 * <p>Per face the four mandatory states are exercised over real HTTP + real {@code SessionReadAccess}:
 * participant 200 / owner 200 / non-participant 404 / cross-workspace 404. The fourth test asserts
 * POST {@code /policy/mode} still refuses the participant (read widening must never widen a write).
 *
 * <p>{@code follow-ups}, {@code monitor} and {@code /events} are deliberately NOT opened; the
 * reasons are recorded in {@code DEV-014} (BL-299).
 */
class SessionAuxReadFacesParticipantTest extends AbstractH2Test {

    private static final String SESSION_NOT_FOUND = "SESSION_NOT_FOUND";

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private SessionRepository sessions;
    @Autowired private ObjectMapper json;

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();

    private String workspaceId;
    private String otherWorkspaceId;
    private String ownerToken;
    private String participantToken;
    private String memberToken;
    private String viewerToken;
    private String otherOwnerToken;
    private String sessionId;

    @BeforeEach
    void fixture() throws Exception {
        AuthResponse owner = register("bl299-owner");
        AuthResponse participant = register("bl299-participant");
        AuthResponse member = register("bl299-member");
        AuthResponse viewer = register("bl299-viewer");
        AuthResponse otherOwner = register("bl299-other");

        ownerToken = owner.getAccessToken();
        participantToken = participant.getAccessToken();
        memberToken = member.getAccessToken();
        viewerToken = viewer.getAccessToken();
        otherOwnerToken = otherOwner.getAccessToken();

        workspaceId = workspaceFixture.createOwnedWorkspace("BL299 ws", owner.getUser().getId())
                .getId().toString();
        otherWorkspaceId = workspaceFixture.createOwnedWorkspace(
                "BL299 other ws", otherOwner.getUser().getId()).getId().toString();

        // The participant must be a workspace member first (requireReadable checks workspace
        // accessibility before the participant lookup); the member is a workspace member who is
        // NOT invited to the session and therefore must stay 404.
        addWorkspaceMember(ownerToken, participant.getUser().getUsername(), "EDITOR");
        addWorkspaceMember(ownerToken, member.getUser().getUsername(), "EDITOR");
        // BL-309: a VIEWER workspace member exercises the workspace write gate, which rejects a
        // write verb with 403 WORKSPACE_READ_ONLY before the session owner-only guard can answer
        // 404. The two denial codes are intentionally different (see the write test below).
        addWorkspaceMember(ownerToken, viewer.getUser().getUsername(), "VIEWER");

        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(workspaceId);
        session.setUserId(owner.getUser().getId());
        session.setTitle("BL299 session");
        sessionId = sessions.saveAndFlush(session).getId().toString();

        Reply invite = send(ownerToken, "POST", participantsPath(),
                """
                {"principalKind":"HUMAN","principalId":"%s","role":"MEMBER"}"""
                        .formatted(participant.getUser().getId()), workspaceId);
        assertEquals(201, invite.status(), invite.body().toString());
    }

    @Test
    void commandsIsReadableByOwnerAndInvitedParticipantOnly() throws Exception {
        Reply participant = send(participantToken, "GET", commandsPath(), null, workspaceId);
        assertEquals(200, participant.status(), participant.body().toString());
        assertTrue(participant.body().path("commands").isArray());
        assertFalse(participant.body().path("commands").isEmpty(),
                "the command registry must reach the participant: " + participant.body());

        assertEquals(200, send(ownerToken, "GET", commandsPath(), null, workspaceId).status());
        assertNotFound(send(memberToken, "GET", commandsPath(), null, workspaceId));
        assertNotFound(send(otherOwnerToken, "GET", commandsPath(), null, otherWorkspaceId));
    }

    @Test
    void runsIsReadableByOwnerAndInvitedParticipantOnly() throws Exception {
        Reply participant = send(participantToken, "GET", runsPath(), null, workspaceId);
        assertEquals(200, participant.status(), participant.body().toString());
        assertTrue(participant.body().path("runs").isArray(),
                "the read-only run list must reach the participant: " + participant.body());

        assertEquals(200, send(ownerToken, "GET", runsPath(), null, workspaceId).status());
        assertNotFound(send(memberToken, "GET", runsPath(), null, workspaceId));
        assertNotFound(send(otherOwnerToken, "GET", runsPath(), null, otherWorkspaceId));
    }

    @Test
    void policyModeReadIsReadableByOwnerAndInvitedParticipantOnly() throws Exception {
        Reply participant = send(participantToken, "GET", policyModePath(), null, workspaceId);
        assertEquals(200, participant.status(), participant.body().toString());
        assertNotNull(participant.body().path("mode").asText(),
                "the participant needs the approval mode for the UI: " + participant.body());

        assertEquals(200, send(ownerToken, "GET", policyModePath(), null, workspaceId).status());
        assertNotFound(send(memberToken, "GET", policyModePath(), null, workspaceId));
        assertNotFound(send(otherOwnerToken, "GET", policyModePath(), null, otherWorkspaceId));
    }

    /**
     * BL-309: the write face keeps two <b>intentionally different</b> denial codes because they
     * answer different questions:
     * <ul>
     *   <li><b>EDITOR non-owner</b> (write-capable workspace member, not the session owner): the
     *       session owner-only guard answers the single {@code 404 SESSION_NOT_FOUND}, so the face
     *       is not an existence oracle;</li>
     *   <li><b>VIEWER</b> (read-only workspace): the workspace write gate answers
     *       {@code 403 WORKSPACE_READ_ONLY} before the controller runs, which is the actionable
     *       answer for that caller.</li>
     * </ul>
     * Unifying the two would either leak existence (403 for everyone) or hide the actionable
     * reason (404 for viewers).
     */
    @Test
    void policyModeWriteStaysOwnerOnly() throws Exception {
        Reply refused = send(participantToken, "POST", "/api/v1/policy/mode",
                """
                {"sessionId":"%s","mode":"auto"}""".formatted(sessionId), workspaceId);
        assertNotFound(refused);

        Reply viewerRefused = send(viewerToken, "POST", "/api/v1/policy/mode",
                """
                {"sessionId":"%s","mode":"auto"}""".formatted(sessionId), workspaceId);
        assertEquals(403, viewerRefused.status(), viewerRefused.body().toString());
        assertEquals("WORKSPACE_READ_ONLY", viewerRefused.body().path("code").asText(),
                "a read-only workspace member gets the actionable write-gate answer: "
                        + viewerRefused.body());

        Reply ownerWrite = send(ownerToken, "POST", "/api/v1/policy/mode",
                """
                {"sessionId":"%s","mode":"auto"}""".formatted(sessionId), workspaceId);
        assertEquals(200, ownerWrite.status(), ownerWrite.body().toString());
        assertEquals("auto", send(ownerToken, "GET", policyModePath(), null, workspaceId)
                .body().path("mode").asText());
    }

    private void addWorkspaceMember(String token, String username, String role) throws Exception {
        Reply added = send(token, "POST", "/api/v1/workspaces/" + workspaceId + "/members",
                """
                {"username":"%s","role":"%s"}""".formatted(username, role), workspaceId);
        assertEquals(201, added.status(), added.body().toString());
    }

    private AuthResponse register(String label) {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(label + "-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, label), AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        return response.getBody();
    }

    private String participantsPath() {
        return "/api/v1/sessions/" + sessionId + "/participants";
    }

    private String commandsPath() {
        return "/api/v1/sessions/" + sessionId + "/commands";
    }

    private String runsPath() {
        return "/api/v1/chat/sessions/" + sessionId + "/runs";
    }

    private String policyModePath() {
        return "/api/v1/policy/mode?sessionId=" + sessionId;
    }

    private static void assertNotFound(Reply reply) {
        assertEquals(404, reply.status(), reply.body().toString());
        assertEquals(SESSION_NOT_FOUND, reply.body().path("code").asText(),
                "the not-区分 404 must not become an existence oracle: " + reply.body());
    }

    private Reply send(String token, String method, String path, String body, String workspace)
            throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url(path)))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .header("X-Workspace-Id", workspace)
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        return new Reply(response.statusCode(), json.readTree(
                response.body() == null || response.body().isBlank() ? "{}" : response.body()));
    }

    private record Reply(int status, JsonNode body) {
    }
}
