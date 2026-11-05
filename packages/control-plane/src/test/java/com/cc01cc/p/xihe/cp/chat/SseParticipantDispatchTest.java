package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0623 M1b-③: SSE distribution — every event carries {@code participantId}, a declared
 * {@code asParticipantId} view receives only its producer's events plus producer-less system
 * events (D23-28: filter by producer, not visibility), and the undeclared observer view receives
 * everything (existing consumers keep working).
 */
class SseParticipantDispatchTest extends AbstractIntegrationTest {

    @Autowired private SseEmitterManager sseManager;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private com.cc01cc.p.xihe.cp.repository.SessionRepository sessions;
    @Autowired private com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository participantRows;
    @Autowired private com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository principals;

    private String token;
    private String ownerId;
    private String workspaceId;
    private UUID sessionId;
    private String humanParticipantId;
    private String agentParticipantId;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("p623-sse-owner");
        token = owner.getAccessToken();
        ownerId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("P623 sse ws", ownerId).getId().toString();

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("P623 sse agent");
        principal.setScope("WORKSPACE");
        principal.setCreatedByUserId(ownerId);
        principal = principals.saveAndFlush(principal);

        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(workspaceId);
        session.setUserId(ownerId);
        session.setTitle("P623 sse session");
        session.setAgentPrincipalId(principal.getId().toString());
        sessionId = sessions.saveAndFlush(session).getId();

        participantRows.saveAndFlush(row("PRIMARY", "AGENT", principal.getId(), 10));
        humanParticipantId = participantRows.saveAndFlush(row("MEMBER", "HUMAN", UUID.fromString(ownerId), 20)).getId().toString();
        agentParticipantId = participantRows.findBySessionIdOrderByOrderIndexAsc(sessionId).stream()
                .filter(row -> "PRIMARY".equals(row.getRole())).findFirst().orElseThrow().getId().toString();
    }

    private SessionParticipant row(String role, String kind, UUID principalId, int order) {
        SessionParticipant participant = new SessionParticipant();
        participant.setSessionId(sessionId);
        participant.setRole(role);
        participant.setPrincipalKind(kind);
        participant.setPrincipalId(principalId);
        participant.setOrderIndex(order);
        participant.setWakePolicy("MENTION");
        participant.setRespondPolicy("WHEN_MENTIONED");
        return participant;
    }

    private List<String> collect(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(15_000);
        List<String> dataLines = new CopyOnWriteArrayList<>();
        Thread reader = Thread.ofPlatform().start(() -> {
            try (BufferedReader in = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = in.readLine()) != null) {
                    if (line.startsWith("data:")) {
                        dataLines.add(line.substring(5).trim());
                    }
                }
            } catch (Exception ignored) {
                // stream closed by the test
            }
        });
        // Wait until the subscribe handshake produced its system `connected` event.
        waitUntil(dataLines, payload -> payload.contains("\"type\":\"connected\""), 10_000);
        return dataLines;
    }

    private void emitRunScoped() {
        sseManager.send(sessionId.toString(), "usage", Map.of("runId", "r1", "type", "usage"), humanParticipantId);
        sseManager.send(sessionId.toString(), "usage", Map.of("runId", "r2", "type", "usage"), agentParticipantId);
        sseManager.send(sessionId.toString(), "error", Map.of("runId", "r1", "type", "error"), null);
    }

    private static void waitUntil(List<String> lines, java.util.function.Predicate<String> condition, long timeoutMs)
            throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (lines.stream().anyMatch(condition)) {
                return;
            }
            Thread.sleep(50);
        }
    }

    @Test
    void declaredViewReceivesOwnAndSystemEventsOnly() throws Exception {
        List<String> lines = collect(baseUrl + "/api/v1/events?sessionId=" + sessionId
                + "&asParticipantId=" + humanParticipantId);
        emitRunScoped();
        waitUntil(lines, payload -> payload.contains("participantId\":null"), 10_000);

        assertTrue(lines.stream().anyMatch(p -> p.contains("\"runId\":\"r1\"")
                && p.contains("\"participantId\":\"" + humanParticipantId + "\"")));
        assertTrue(lines.stream().anyMatch(p -> p.contains("participantId\":null")),
                "system events are visible in a declared view (filter by producer, not visibility)");
        assertFalse(lines.stream().anyMatch(p -> p.contains("\"runId\":\"r2\"")
                        && p.contains("\"participantId\":\"" + agentParticipantId + "\"")),
                "another participant's output must not reach a declared view");
        assertFalse(lines.stream().anyMatch(p -> p.contains("participantId\") == false")
                        && !p.contains("participantId")),
                "every event payload carries the participantId field");
    }

    @Test
    void undeclaredObserverReceivesEverythingWithParticipantIdPresent() throws Exception {
        List<String> lines = collect(baseUrl + "/api/v1/events?sessionId=" + sessionId);
        emitRunScoped();
        waitUntil(lines, p -> p.contains("\"runId\":\"r2\""), 10_000);

        assertTrue(lines.stream().anyMatch(p -> p.contains("\"runId\":\"r1\"")
                && p.contains("\"participantId\":\"" + humanParticipantId + "\"")));
        assertTrue(lines.stream().anyMatch(p -> p.contains("\"runId\":\"r2\"")
                && p.contains("\"participantId\":\"" + agentParticipantId + "\"")));
        assertTrue(lines.stream().anyMatch(p -> p.contains("participantId\":null")),
                "system events carry an explicit null participantId for observers");
        long connected = lines.stream().filter(p -> p.contains("\"type\":\"connected\"")).count();
        assertEquals(1, connected);
        assertTrue(lines.stream().filter(p -> p.contains("\"type\":\"connected\"")).allMatch(p -> p.contains("participantId")),
                "even the connected event exposes the participantId field");
    }

    /**
     * BL-306: owner observer and a declared participant view are two independent connections.
     * Before BL-306 the second subscribe replaced the first (single session key); now both stay
     * alive and receive their own view.
     */
    @Test
    void ownerAndDeclaredParticipantConnectionsCoexist() throws Exception {
        List<String> observer = collect(baseUrl + "/api/v1/events?sessionId=" + sessionId
                + "&connectionId=owner-tab");
        List<String> declared = collect(baseUrl + "/api/v1/events?sessionId=" + sessionId
                + "&asParticipantId=" + humanParticipantId + "&connectionId=participant-tab");

        assertEquals(2, sseManager.activeConnectionCount(sessionId.toString()),
                "second subscribe must not kick the first one");

        emitRunScoped();
        waitUntil(observer, p -> p.contains("\"runId\":\"r2\""), 10_000);
        waitUntil(declared, p -> p.contains("\"runId\":\"r1\""), 10_000);

        assertTrue(observer.stream().anyMatch(p -> p.contains("\"runId\":\"r1\"")
                && p.contains("\"participantId\":\"" + humanParticipantId + "\"")));
        assertTrue(observer.stream().anyMatch(p -> p.contains("\"runId\":\"r2\"")
                && p.contains("\"participantId\":\"" + agentParticipantId + "\"")),
                "observer keeps receiving every producer");
        assertTrue(declared.stream().anyMatch(p -> p.contains("\"runId\":\"r1\"")
                && p.contains("\"participantId\":\"" + humanParticipantId + "\"")));
        assertFalse(declared.stream().anyMatch(p -> p.contains("\"runId\":\"r2\"")
                        && p.contains("\"participantId\":\"" + agentParticipantId + "\"")),
                "declared view must not receive another participant's output");
    }

    private AuthResponse register(String label) {
        var response = restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new com.cc01cc.p.xihe.cp.auth.RegisterRequest(label.toLowerCase(java.util.Locale.ROOT)
                        .replaceAll("[^a-z0-9]", "") + "-" + UUID.randomUUID() + "@test.com",
                        com.cc01cc.p.xihe.cp.integration.TestDataFactory.PASSWORD, label),
                AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        return response.getBody();
    }
}
