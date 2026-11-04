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
    @Autowired private com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository participantRepository;
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

    /**
     * PLAN-0651 regression (0660's only failing shape): the participant view capability is computed
     * for <b>every</b> reader, so a workspace member who is not the session owner used to enter the
     * instance-scope authorization probe with a {@code null} workspace and die with an NPE ⇒ 500.
     *
     * <p>Both directions are asserted on purpose: the member must get 200 with
     * {@code capabilities.manage=false}, and the owner must still get 200 with
     * {@code capabilities.manage=true}. Asserting only the false side would stay green if the
     * capability were ever computed as a constant false.</p>
     */
    @Test
    void aWorkspaceMemberWhoIsNotTheOwnerReadsTheRosterWithoutAnError() throws Exception {
        AuthResponse member = register("p623member");
        String memberToken = member.getAccessToken();
        String memberId = member.getUser().getId();

        // Real API (not a fixture shortcut): the owner adds the account as an EDITOR.
        Reply addedMember = send(ownerToken, "POST", "/api/v1/workspaces/" + workspaceId + "/members",
                """
                {"username":"%s","role":"EDITOR"}""".formatted(member.getUser().getUsername()));
        assertEquals(201, addedMember.status(), addedMember.body().toString());

        // …and invites it to the session, exactly like the 0660 fixture did.
        assertEquals(201, send(ownerToken, "POST", participantsPath(),
                """
                {"principalKind":"HUMAN","principalId":"%s","role":"MEMBER"}"""
                        .formatted(memberId)).status());

        Reply memberRead = send(memberToken, "GET", participantsPath(), null);

        assertEquals(200, memberRead.status(), memberRead.body().toString());
        assertFalse(memberRead.body().path("capabilities").path("manage").asBoolean(),
                "a member who is not the session owner must not manage the roster: " + memberRead.body());

        // Reverse guard: "always false" must fail this test.
        Reply ownerRead = send(ownerToken, "GET", participantsPath(), null);
        assertEquals(200, ownerRead.status(), ownerRead.body().toString());
        assertTrue(ownerRead.body().path("capabilities").path("manage").asBoolean(),
                "the owner keeps the manage capability: " + ownerRead.body());
    }

    /**
     * The third input face of {@code canManage}: not the owner, not a member, not a participant.
     * It must be refused with a problem document — never a 5xx.
     */
    @Test
    void aStrangerWhoIsNeitherMemberNorParticipantIsRefusedWithoutAnError() throws Exception {
        Reply reply = send(strangerToken, "GET", participantsPath(), null);

        assertEquals(403, reply.status(), reply.body().toString());
        assertTrue(reply.status() < 500, "a refused read is a 4xx, never a 5xx: " + reply.body());
        assertFalse(reply.body().path("code").isMissingNode(), reply.body().toString());
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

    // -----------------------------------------------------------------------------------------
    // D23-27 / displayName: a group chat shows "who", never a UUID.
    // -----------------------------------------------------------------------------------------

    @Test
    void aHumanRowIsShownByNameNotByUuid() throws Exception {
        AuthResponse named = register("P623 Named Human");
        assertEquals(201, send(ownerToken, "POST", participantsPath(),
                """
                {"principalKind":"HUMAN","principalId":"%s","role":"MEMBER"}"""
                        .formatted(named.getUser().getId())).status());

        JsonNode list = send(ownerToken, "GET", participantsPath(), null).body();
        JsonNode row = find(list.path("participants"), named.getUser().getId());

        assertFalse(row.path("selfOwned").asBoolean(), "another account is not a legal speak-as target: " + row);
        assertEquals("P623 Named Human", row.path("displayName").asText(),
                "HUMAN rows carry the user display name; a UUID is not a person: " + row);
    }

    @Test
    void anUnresolvableHumanIsNullInsteadOfAFakedName() throws Exception {
        // The polymorphic participant has no FK (by design, R2): a row can outlive its user. Seed
        // such a row directly; the projection must answer null so the UI shows "unknown user".
        java.util.UUID ghost = java.util.UUID.randomUUID();
        var row = new com.cc01cc.p.xihe.cp.entity.SessionParticipant(java.util.UUID.fromString(sessionId),
                com.cc01cc.p.xihe.cp.entity.SessionParticipant.KIND_HUMAN, ghost,
                com.cc01cc.p.xihe.cp.entity.SessionParticipant.ROLE_MEMBER, 30,
                com.cc01cc.p.xihe.cp.entity.SessionParticipant.WAKE_MENTION,
                com.cc01cc.p.xihe.cp.entity.SessionParticipant.RESPOND_WHEN_MENTIONED);
        participantRepository.saveAndFlush(row);

        JsonNode listed = find(send(ownerToken, "GET", participantsPath(), null).body().path("participants"),
                ghost.toString());

        assertNotNull(listed, "the orphan row is still listed");
        assertTrue(listed.path("displayName").isNull(), "an unresolvable user is null, never invented: " + listed);
    }

    @Test
    void speakAsIsTrueForTheOwnerAndFalseForEveryoneElse() throws Exception {
        assertEquals(201, send(ownerToken, "POST", participantsPath(),
                """
                {"principalKind":"HUMAN","principalId":"%s","role":"MEMBER"}""".formatted(ownerId)).status());

        JsonNode ownerView = send(ownerToken, "GET", participantsPath(), null).body();
        assertTrue(ownerView.path("capabilities").path("speakAs").asBoolean(),
                "the owner can speak as themselves");
        assertTrue(find(ownerView.path("participants"), ownerId).path("selfOwned").asBoolean(),
                "the owner's own HUMAN row is a legal speak-as target: " + ownerView);

        // A workspace OWNER who does not own this conversation: manage may be true, speakAs is not.
        AuthResponse other = register("P623 Other Owner");
        workspaceFixture.bindWorkspaceRole(workspaceId, other.getUser().getId(), WorkspaceRole.OWNER);
        JsonNode foreign = send(other.getAccessToken(), "GET", participantsPath(), null).body();
        assertFalse(foreign.path("capabilities").path("speakAs").asBoolean(),
                "speaking is the conversation owner's right, not a workspace role: " + foreign);
    }

    private AuthResponse register(String label) {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(label.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]", "")
                        + "-" + UUID.randomUUID() + "@test.com",
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
