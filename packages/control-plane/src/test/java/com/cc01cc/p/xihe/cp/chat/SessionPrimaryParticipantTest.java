package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.service.SessionService;
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

import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * PLAN-0623 D23-13: the PRIMARY participant is part of creating a Session.
 *
 * <p>Before this test only the V92 backfill produced a PRIMARY, so on every newly created Session the
 * invariant was vacuous: {@code DELETE .../participants/{PRIMARY}} could never be reached and the
 * conversation had no main participant at all. The PRIMARY and its cursor row are written inside the
 * session-creation transaction, and a principal-null placeholder deliberately gets neither.</p>
 */
class SessionPrimaryParticipantTest extends AbstractReusableIntegrationTest {

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper json;
    @Autowired private SessionService sessionService;
    @Autowired private com.cc01cc.p.xihe.cp.chat.ChatSubmissionService chatSubmissionService;
    @Autowired private com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService;
    @Autowired private com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository providerConnections;
    @Autowired private com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository participants;
    @Autowired private com.cc01cc.p.xihe.cp.repository.ChatRunRepository chatRuns;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private String ownerToken;
    private String ownerId;
    private String workspaceId;
    private String principalId;
    /** 2026-11-04 P0（task-24）：裸会话不再允许存在，HTTP 建会话必须带显式绑定。 */
    private com.cc01cc.p.xihe.cp.entity.ProviderConnection binding;
    private String bindingFields;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("p623-primary");
        ownerToken = owner.getAccessToken();
        ownerId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("P623 primary ws", ownerId).getId().toString();

        JsonNode created = send(ownerToken, "POST", "/api/v1/agent-principals",
                """
                {"name":"PrimaryAgent"}""").body();
        principalId = created.path("principalId").asText();
        // Bind with an empty cap: the session only needs a binding, and the cap is intersected with
        // the principal's grants, so an empty ceiling keeps the fixture free of grant seeding.
        assertEquals(200, send(ownerToken, "PUT",
                "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId,
                """
                {"permissions":[]}""").status());

        binding = ChatBindingTestSupport.ensureChatConnection(providerConnections, "USER", ownerId,
                "p623-primary-" + UUID.randomUUID().toString().substring(0, 8));
        bindingFields = ",\"modelProvider\":\"%s\",\"modelName\":\"gpt-test\",\"providerConnectionId\":\"%s\""
                .formatted(binding.getProviderId(), binding.getId());
    }

    @Test
    void creatingAnAgentSessionSeedsThePrimaryAndItsCursor() {
        JsonNode session = send(ownerToken, "POST", "/api/v1/sessions",
                """
                {"agentPrincipalId":"%s"%s}""".formatted(principalId, bindingFields)).body();
        String sessionId = session.path("id").asText();

        JsonNode list = send(ownerToken, "GET", "/api/v1/sessions/" + sessionId + "/participants", null).body();
        JsonNode participants = list.path("participants");
        assertEquals(1, participants.size(), "exactly one PRIMARY, not one per bind: " + list);

        JsonNode primary = participants.get(0);
        assertEquals("PRIMARY", primary.path("role").asText());
        assertEquals("AGENT", primary.path("principalKind").asText());
        assertEquals(principalId, primary.path("principalId").asText());
        assertEquals(10, primary.path("orderIndex").asInt(), "R4: the PRIMARY sits at 10");
        assertEquals("ALL_MESSAGES", primary.path("wakePolicy").asText(), "R3 default");
        assertEquals("ALWAYS", primary.path("respondPolicy").asText(), "R3 default");

        // The cursor row is part of the seed: without it `readCursor` stays null forever and the
        // unread/mention badges can never be verified on a real stack.
        JsonNode cursor = primary.path("readCursor");
        assertFalse(cursor.isNull(), "the PRIMARY must come with a cursor row: " + primary);
        assertEquals(0, cursor.path("lastReadEventSeq").asLong());
        assertEquals(0, cursor.path("mentionCount").asInt());
    }

    @Test
    void thePrimaryIsNotRemovableAndNotTransferable() {
        String sessionId = send(ownerToken, "POST", "/api/v1/sessions",
                """
                {"agentPrincipalId":"%s"%s}""".formatted(principalId, bindingFields)).body().path("id").asText();
        String primaryRow = send(ownerToken, "GET",
                "/api/v1/sessions/" + sessionId + "/participants", null).body()
                .path("participants").get(0).path("participantId").asText();

        Reply removed = send(ownerToken, "DELETE",
                "/api/v1/sessions/" + sessionId + "/participants/" + primaryRow, null);
        assertEquals(403, removed.status(), removed.body().toString());
        assertEquals("PARTICIPANT_PRIMARY_IMMUTABLE", removed.body().path("code").asText());

        JsonNode added = send(ownerToken, "POST", "/api/v1/sessions/" + sessionId + "/participants",
                """
                {"principalKind":"HUMAN","principalId":"%s","role":"MEMBER"}""".formatted(ownerId)).body();
        Reply promoted = send(ownerToken, "PATCH",
                "/api/v1/sessions/" + sessionId + "/participants/" + added.path("participantId").asText(),
                """
                {"role":"PRIMARY"}""");
        assertEquals(409, promoted.status(), promoted.body().toString());
        assertEquals("PARTICIPANT_PRIMARY_EXISTS", promoted.body().path("code").asText());
    }

    @Test
    void aPrincipalNullPlaceholderGetsNoPrimary() {
        String sessionId = UUID.randomUUID().toString();
        sessionService.createWithId(sessionId, ownerId, workspaceId, "Placeholder", null, null);

        JsonNode participants = send(ownerToken, "GET",
                "/api/v1/sessions/" + sessionId + "/participants", null).body().path("participants");
        assertEquals(0, participants.size(), "no principal yet means no PRIMARY — never a fake one");
    }

    @Test
    void seedingsAreIdempotent() {
        String sessionId = send(ownerToken, "POST", "/api/v1/sessions",
                """
                {"agentPrincipalId":"%s"%s}""".formatted(principalId, bindingFields)).body().path("id").asText();

        // The bind path calls the same seeder; a second call must not add a row.
        sessionService.createAgentSession(ownerId, workspaceId, "second", binding.getProviderId(), "gpt-test",
                binding.getId().toString(), principalId);

        JsonNode participants = send(ownerToken, "GET",
                "/api/v1/sessions/" + sessionId + "/participants", null).body().path("participants");
        assertEquals(1, participants.size(), "re-seeding is a no-op: " + participants);
    }

    // -----------------------------------------------------------------------------------------
    // R1: a run records the responder it spoke as (the attribution M1b builds on).
    // -----------------------------------------------------------------------------------------

    @Test
    void aRunRecordsItsResponderAndTwoRespondersDiffer() {
        com.cc01cc.p.xihe.cp.entity.ProviderConnection connection =
                com.cc01cc.p.xihe.cp.chat.ChatBindingTestSupport.ensureChatConnection(providerConnections,
                        "USER", ownerId, "r1-" + UUID.randomUUID().toString().substring(0, 8));
        var session = sessionService.createAgentSession(ownerId, workspaceId, "R1 session",
                connection.getProviderId(), "gpt-test", connection.getId().toString(), principalId);
        var human = participants.saveAndFlush(new com.cc01cc.p.xihe.cp.entity.SessionParticipant(session.getId(),
                com.cc01cc.p.xihe.cp.entity.SessionParticipant.KIND_HUMAN, UUID.fromString(ownerId),
                com.cc01cc.p.xihe.cp.entity.SessionParticipant.ROLE_MEMBER, 20,
                com.cc01cc.p.xihe.cp.entity.SessionParticipant.WAKE_MENTION,
                com.cc01cc.p.xihe.cp.entity.SessionParticipant.RESPOND_WHEN_MENTIONED));
        String branchId = branchPathService.ensureRootBranchId(session.getId().toString());

        var primaryAnswered = chatSubmissionService.create(UUID.randomUUID().toString(), session.getId().toString(), ownerId,
                workspaceId, branchId, "idem-r1-a", "a".repeat(64), connection.getProviderId(), "gpt-test",
                "none", connection.getId().toString(), connection.getRevision(), "lease-r1", "req-r1-a",
                "hi", null, java.util.List.of(), null);
        primaryAnswered.run().setStatus("succeeded");
        chatRuns.saveAndFlush(primaryAnswered.run());
        var humanAnswered = chatSubmissionService.create(UUID.randomUUID().toString(), session.getId().toString(), ownerId,
                workspaceId, branchId, "idem-r1-b", "b".repeat(64), connection.getProviderId(), "gpt-test",
                "none", connection.getId().toString(), connection.getRevision(), "lease-r1", "req-r1-b",
                "hi", null, java.util.List.of(), human.getId().toString());

        assertEquals(principalId, primaryAnswered.run().getAgentPrincipalId().toString(),
                "without asParticipantId the PRIMARY answers");
        // PLAN-0669 M1: `chat_runs.agent_principal_id` has a FK to agent_principals (V92), so a HUMAN
        // responder cannot be recorded there — it would violate fk_chat_runs_agent_principal at commit
        // (the pre-0669 code never flushed the detached entity, which is why this gap stayed hidden).
        // Human identity is carried by the Message's participant attribution (PLAN-0669) instead;
        // durable human authorship of *user* messages is BL-277.
        assertNull(humanAnswered.run().getAgentPrincipalId(),
                "a HUMAN responder keeps the agent-only run column NULL");
    }

    /**
     * BL-270 (P1, 2026-11-04): the UI's provider-binding guard reads the session **list** row
     * (`hasBinding` = providerConnectionId). The list projection used to omit the chat binding
     * fields that the single-session GET carried, so a bound session looked unbound on a real stack
     * and every send re-ran `POST bind-defaults` and toasted. The three fields must be projected by
     * the list with the same values as the single GET.
     */
    @Test
    void theSessionListProjectsTheChatBindingFields() {
        String sessionId = send(ownerToken, "POST", "/api/v1/sessions",
                """
                {"agentPrincipalId":"%s"%s}""".formatted(principalId, bindingFields)).body().path("id").asText();

        JsonNode single = send(ownerToken, "GET", "/api/v1/sessions/" + sessionId, null).body();
        JsonNode rows = send(ownerToken, "GET", "/api/v1/sessions", null).body().path("sessions");
        JsonNode row = null;
        for (JsonNode candidate : rows) {
            if (sessionId.equals(candidate.path("id").asText())) {
                row = candidate;
                break;
            }
        }
        assertNotNull(row, "list must contain the created session: " + rows);
        for (String field : java.util.List.of("providerConnectionId", "modelProvider", "modelName")) {
            assertFalse(row.path(field).isMissingNode() || row.path(field).isNull(),
                    "BL-270: list projection must carry " + field + ": " + row);
            assertEquals(single.path(field), row.path(field),
                    "BL-270: list projection must match the single GET for " + field);
        }
    }

    private AuthResponse register(String label) {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(label + "-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, label), AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        return response.getBody();
    }

    private Reply send(String token, String method, String path, String body) {
        try {
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
        } catch (java.io.IOException | InterruptedException e) {
            throw new IllegalStateException("HTTP " + method + " " + path + " failed", e);
        }
    }

    private record Reply(int status, JsonNode body) {
    }
}
