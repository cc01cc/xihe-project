package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ConversationThread;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ConversationThreadRepository;
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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0646 MVP (D-671): thread shape + user/agent visibility + attach semantics on the real HTTP face.
 *
 * <p>Deliberate MVP cuts asserted here: workspace scope fails closed ({@code THREAD_SCOPE_UNRESOLVED}),
 * attach is owner-only and idempotent for the same thread, re-attach overwrites without cascading,
 * and existing Sessions keep {@code conversation_thread_id = NULL} (V1/V6).</p>
 */
class ConversationThreadMvpIntegrationTest extends AbstractIntegrationTest {

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper json;
    @Autowired private SessionRepository sessions;
    @Autowired private ConversationThreadRepository threads;
    @Autowired private AgentPrincipalRepository principals;

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();

    private String ownerToken;
    private String ownerId;
    private String workspaceId;
    private String otherToken;
    private String otherId;
    private String otherWorkspaceId;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("thread-owner");
        ownerToken = owner.getAccessToken();
        ownerId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("Thread ws", ownerId).getId().toString();
        AuthResponse other = register("thread-other");
        otherToken = other.getAccessToken();
        otherId = other.getUser().getId();
        otherWorkspaceId = workspaceFixture.createOwnedWorkspace("Thread other ws", otherId).getId().toString();
    }

    @Test
    void userScopeThreadIsReadableByItsCreatorAndNobodyElse() {
        Reply created = send(ownerToken, "POST", "/api/v1/conversation-threads",
                """
                {"scopeType":"user","scopeId":"%s","title":"My line"}""".formatted(ownerId));
        assertEquals(201, created.status(), created.body().toString());
        String threadId = created.body().path("id").asText();
        assertEquals("user", created.body().path("scopeType").asText());
        assertEquals(ownerId, created.body().path("scopeId").asText());

        Reply ownerRead = send(ownerToken, "GET", "/api/v1/conversation-threads/" + threadId, null);
        assertEquals(200, ownerRead.status(), ownerRead.body().toString());
        assertEquals(threadId, ownerRead.body().path("id").asText());
        assertEquals(0, ownerRead.body().path("sessions").size());

        Reply otherRead = send(otherToken, otherWorkspaceId, "GET", "/api/v1/conversation-threads/" + threadId, null);
        assertEquals(404, otherRead.status(), "a user-scope thread must not leak to another user: "
                + otherRead.body());
        assertTrue(otherRead.body().path("code").asText().contains("THREAD_NOT_FOUND"), otherRead.body().toString());
    }

    @Test
    void agentScopeThreadIsReadableByThePrincipalOwnerOnly() {
        AgentPrincipal principal = createAgentPrincipal(ownerId, "ThreadAgent");
        Reply created = send(ownerToken, "POST", "/api/v1/conversation-threads",
                """
                {"scopeType":"agent","scopeId":"%s"}""".formatted(principal.getId()));
        assertEquals(201, created.status(), created.body().toString());
        String threadId = created.body().path("id").asText();

        assertEquals(200, send(ownerToken, "GET", "/api/v1/conversation-threads/" + threadId, null).status());
        Reply otherRead = send(otherToken, otherWorkspaceId, "GET", "/api/v1/conversation-threads/" + threadId, null);
        assertEquals(404, otherRead.status(), otherRead.body().toString());
    }

    @Test
    void workspaceScopeFailsClosedForCreateAndRead() {
        Reply created = send(ownerToken, "POST", "/api/v1/conversation-threads",
                """
                {"scopeType":"workspace","scopeId":"%s"}""".formatted(workspaceId));
        assertEquals(403, created.status(), created.body().toString());
        assertEquals("THREAD_SCOPE_UNRESOLVED", created.body().path("code").asText());

        ConversationThread seeded = new ConversationThread();
        seeded.setScopeType(ConversationThread.SCOPE_WORKSPACE);
        seeded.setScopeId(UUID.fromString(workspaceId));
        seeded.setCreatedByUserId(UUID.fromString(ownerId));
        seeded.setTitle("seeded workspace line");
        threads.save(seeded);
        Reply read = send(ownerToken, "GET", "/api/v1/conversation-threads/" + seeded.getId(), null);
        assertEquals(403, read.status(), "workspace scope stays fail-closed (V4 deferred): " + read.body());
        assertEquals("THREAD_SCOPE_UNRESOLVED", read.body().path("code").asText());
    }

    @Test
    void attachIsOwnerOnlyIdempotentAndOverwritesWithoutCascade() {
        Session first = createSession(ownerId, "first");
        Session second = createSession(ownerId, "second");
        Session foreign = createSession(otherId, "foreign");
        assertNull(sessions.findById(first.getId()).orElseThrow().getConversationThreadId(),
                "a Session created on the untouched creation path has no thread (V6)");

        String t1 = createThread(ownerToken, "user", ownerId);
        String t2 = createThread(ownerToken, "user", ownerId);

        Reply attached = send(ownerToken, "POST", "/api/v1/conversation-threads/" + t1 + "/sessions",
                """
                {"sessionId":"%s"}""".formatted(first.getId()));
        assertEquals(200, attached.status(), attached.body().toString());
        assertTrue(attached.body().path("changed").asBoolean(), "first attach must change the row");

        Reply repeated = send(ownerToken, "POST", "/api/v1/conversation-threads/" + t1 + "/sessions",
                """
                {"sessionId":"%s"}""".formatted(first.getId()));
        assertEquals(200, repeated.status(), "same thread twice is idempotent 200, not 409");
        assertFalse(repeated.body().path("changed").asBoolean(), "the repeated attach is a no-op");

        send(ownerToken, "POST", "/api/v1/conversation-threads/" + t1 + "/sessions",
                """
                {"sessionId":"%s"}""".formatted(second.getId()));
        assertEquals(2, send(ownerToken, "GET", "/api/v1/conversation-threads/" + t1, null)
                .body().path("sessions").size(), "one thread carries multiple Sessions (1:N)");

        Reply move = send(ownerToken, "POST", "/api/v1/conversation-threads/" + t2 + "/sessions",
                """
                {"sessionId":"%s"}""".formatted(first.getId()));
        assertEquals(200, move.status(), "re-attach to another thread overwrites without cascade");
        assertEquals(t2, sessions.findById(first.getId()).orElseThrow()
                .getConversationThreadId().toString(), "the session now points at the new thread");

        Reply foreignAttach = send(ownerToken, "POST", "/api/v1/conversation-threads/" + t1 + "/sessions",
                """
                {"sessionId":"%s"}""".formatted(foreign.getId()));
        assertEquals(403, foreignAttach.status(), foreignAttach.body().toString());
        assertEquals("THREAD_WRITE_FORBIDDEN", foreignAttach.body().path("code").asText());
    }

    private String createThread(String token, String scopeType, String scopeId) {
        Reply reply = send(token, "POST", "/api/v1/conversation-threads",
                """
                {"scopeType":"%s","scopeId":"%s"}""".formatted(scopeType, scopeId));
        assertEquals(201, reply.status(), reply.body().toString());
        return reply.body().path("id").asText();
    }

    private Session createSession(String userId, String title) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.randomUUID());
        return sessions.save(session);
    }

    private AgentPrincipal createAgentPrincipal(String createdBy, String name) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(name);
        principal.setCreatedByUserId(createdBy);
        principal.setOwnerUserId(UUID.fromString(createdBy));
        return principals.save(principal);
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
        return send(token, workspaceId, method, path, body);
    }

    private Reply send(String token, String workspace, String method, String path, String body) {
        try {
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
        } catch (java.io.IOException | InterruptedException e) {
            throw new IllegalStateException("HTTP " + method + " " + path + " failed", e);
        }
    }

    private record Reply(int status, JsonNode body) {}
}
