package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import org.junit.jupiter.api.AfterEach;
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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * BL-306: the SSE registry must survive multiple connections of one user (two tabs) and must not
 * leak an entry when a tab reconnects with the same connection instance.
 */
class SseMultiTabIntegrationTest extends AbstractIntegrationTest {

    @Autowired private SseEmitterManager sseManager;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private com.cc01cc.p.xihe.cp.repository.SessionRepository sessions;
    @Autowired private com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository principals;

    private String token;
    private String ownerId;
    private String workspaceId;
    private UUID sessionId;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("bl306-sse-owner");
        token = owner.getAccessToken();
        ownerId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("BL306 sse ws", ownerId).getId().toString();

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("BL306 sse agent");
        principal.setScope("WORKSPACE");
        principal.setCreatedByUserId(ownerId);
        principal = principals.saveAndFlush(principal);

        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(workspaceId);
        session.setUserId(ownerId);
        session.setTitle("BL306 sse session");
        session.setAgentPrincipalId(principal.getId().toString());
        sessionId = sessions.saveAndFlush(session).getId();
    }

    @AfterEach
    void tearDown() {
        sseManager.complete(sessionId.toString());
    }

    private SseStream open(String connectionId) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create(baseUrl + "/api/v1/events?sessionId="
                + sessionId + "&connectionId=" + connectionId).toURL().openConnection();
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setRequestProperty("X-XH-SSE-Connection-Id", connectionId);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(15_000);
        SseStream stream = new SseStream(connection);
        Thread.ofPlatform().start(() -> {
            try (BufferedReader in = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = in.readLine()) != null) {
                    if (line.startsWith("data:")) {
                        stream.lines.add(line.substring(5).trim());
                    }
                }
            } catch (Exception ignored) {
                // stream closed by the test / replaced by reconnect
            }
        });
        waitUntil(stream.lines, payload -> payload.contains("\"type\":\"connected\""), 10_000);
        return stream;
    }

    @Test
    void sameUserTwoTabsCoexistAndClosingOneLeavesTheOtherAlive() throws Exception {
        SseStream firstTab = open("tab-a");
        SseStream secondTab = open("tab-b");
        assertEquals(2, sseManager.activeConnectionCount(sessionId.toString()),
                "a second tab must not kick the first one");

        sseManager.send(sessionId.toString(), "usage",
                Map.of("runId", "r1", "type", "usage"));
        waitUntil(secondTab.lines, payload -> payload.contains("\"runId\":\"r1\""), 10_000);
        assertTrue(firstTab.lines.stream().anyMatch(payload -> payload.contains("\"runId\":\"r1\"")));

        firstTab.close();
        // The closed tab is cleaned up when the next broadcast hits the dead connection; the
        // surviving tab must still receive the event.
        sseManager.send(sessionId.toString(), "usage",
                Map.of("runId", "r2", "type", "usage"));
        waitUntil(secondTab.lines, payload -> payload.contains("\"runId\":\"r2\""), 10_000);
        waitForConnectionCount(1);
    }

    @Test
    void reconnectWithSameConnectionIdReplacesInsteadOfAccumulating() throws Exception {
        SseStream first = open("tab-fixed");
        waitForConnectionCount(1);
        first.close();

        for (int attempt = 0; attempt < 3; attempt += 1) {
            open("tab-fixed");
            waitForConnectionCount(1);
        }

        sseManager.send(sessionId.toString(), "usage",
                Map.of("runId", "after-reconnect", "type", "usage"));
        assertEquals(1, sseManager.activeConnectionCount(sessionId.toString()),
                "reconnects with the same connection instance must not leak entries");
    }

    private void waitForConnectionCount(int expected) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline) {
            if (sseManager.activeConnectionCount(sessionId.toString()) == expected) {
                return;
            }
            Thread.sleep(50);
        }
        assertEquals(expected, sseManager.activeConnectionCount(sessionId.toString()));
    }

    private static void waitUntil(List<String> lines, java.util.function.Predicate<String> condition,
                                  long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (lines.stream().anyMatch(condition)) {
                return;
            }
            Thread.sleep(50);
        }
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

    private static final class SseStream {
        private final HttpURLConnection connection;
        private final List<String> lines = new CopyOnWriteArrayList<>();

        private SseStream(HttpURLConnection connection) {
            this.connection = connection;
        }

        private void close() {
            connection.disconnect();
        }
    }
}
