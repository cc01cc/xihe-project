package com.cc01cc.p.xihe.cp.session;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/** PLAN-0408 T2.2/T2.3 real HTTP projection and user-boundary coverage. */
class SessionDerivedStateIntegrationTest extends AbstractIntegrationTest {

    @Autowired private UserRepository users;
    @Autowired private WorkspaceRepository workspaces;
    @Autowired private WorkspaceUserRepository workspaceUsers;
    @Autowired private SessionRepository sessions;
    @Autowired private ChatRunRepository chatRuns;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private JwtTokenProvider jwtTokenProvider;
    @Autowired private ObjectMapper objectMapper;

    private User owner;
    private Workspace workspace;
    private String ownerToken;

    @BeforeEach
    void createOwnerAndWorkspace() {
        String email = "derived-state-" + UUID.randomUUID() + "@test.com";
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Derived state test"),
                AuthResponse.class);
        ownerToken = response.getBody().getAccessToken();
        owner = users.findByEmail(email).orElseThrow();
        workspace = workspaces.findActiveByMemberUserId(owner.getId()).stream().findFirst().orElseThrow();
        if (workspaceUsers.findByIdWorkspaceIdAndIdUserId(workspace.getId(), owner.getId()).isEmpty()) {
            workspaceUsers.saveAndFlush(new WorkspaceUser(workspace.getId().toString(), owner.getId().toString(),
                    WorkspaceRole.OWNER));
        }
    }

    @Test
    void derivedStateProjectsOnlySpawnChildrenAndTheFrozenWireFields() throws Exception {
        Session parent = newSession(owner, workspace, "Parent");
        ChatRun parentRun = newRun(parent, "running", ChatRun.ORIGIN_USER_SUBMISSION);

        Session visibleChild = spawnSession(owner, workspace, "Visible child", parent, parentRun);
        ChatRun activeRun = newRun(visibleChild, "awaiting_approval", ChatRun.ORIGIN_SPAWN);

        User other = users.save(new User("other-derived-" + UUID.randomUUID() + "@test.com", "hash",
                UserRole.USER, "Other user"));
        workspaceUsers.saveAndFlush(new WorkspaceUser(workspace.getId().toString(), other.getId().toString(),
                WorkspaceRole.MEMBER));
        Session hiddenChild = spawnSession(other, workspace, "Must not leak", parent, parentRun);
        ChatRun hiddenRun = newRun(hiddenChild, "running", ChatRun.ORIGIN_SPAWN);

        Session fork = newSession(owner, workspace, "Independent fork");
        fork.setKind(Session.KIND_FORK);
        fork.setSpawnedFromSessionId(parent.getId());
        fork.setSpawnedFromRunId(parentRun.getId());
        fork.setSpawnedAt(Instant.now());
        sessions.saveAndFlush(fork);
        newRun(fork, "running", ChatRun.ORIGIN_SPAWN);

        Session terminalChild = spawnSession(owner, workspace, "Finished child", parent, parentRun);
        Instant terminalAt = Instant.parse("2026-09-27T04:00:00Z");
        ChatRun terminalRun = newRun(terminalChild, "succeeded", ChatRun.ORIGIN_SPAWN);
        terminalRun.setTerminalOutcome("success");
        terminalRun.setTerminalAt(terminalAt);
        chatRuns.saveAndFlush(terminalRun);
        insertInbox(parent, terminalChild, terminalRun, "success");

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + parent.getId() + "/derived-state",
                HttpMethod.GET, bearer(ownerToken), Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<?, ?> body = response.getBody();
        assertEquals(Set.of("sessionId", "activeChildren", "terminalNotices"), body.keySet());
        assertEquals(parent.getId().toString(), body.get("sessionId"));

        List<?> activeChildren = (List<?>) body.get("activeChildren");
        assertEquals(2, activeChildren.size(), "only spawn sessions are projected; fork is excluded");
        Map<?, ?> visibleActive = findByRunId(activeChildren, activeRun.getId().toString());
        assertEquals(Set.of("childSessionId", "runId", "name", "status"), visibleActive.keySet());
        assertEquals(visibleChild.getId().toString(), visibleActive.get("childSessionId"));
        assertEquals("Visible child", visibleActive.get("name"));
        assertEquals("awaiting_approval", visibleActive.get("status"));

        Map<?, ?> hiddenActive = findByRunId(activeChildren, hiddenRun.getId().toString());
        assertNull(hiddenActive.get("name"), "child names are null when owner visibility does not match");

        List<?> notices = (List<?>) body.get("terminalNotices");
        assertEquals(1, notices.size());
        Map<?, ?> notice = (Map<?, ?>) notices.getFirst();
        assertEquals(Set.of("childSessionId", "runId", "name", "state", "terminalAt"), notice.keySet());
        assertEquals(terminalChild.getId().toString(), notice.get("childSessionId"));
        assertEquals(terminalRun.getId().toString(), notice.get("runId"));
        assertEquals("Finished child", notice.get("name"));
        assertEquals("success", notice.get("state"));
        assertEquals(terminalAt.toString(), Instant.parse((String) notice.get("terminalAt")).toString());
        assertFalse(objectMapper.writeValueAsString(body).contains("injected_run_id"));
        assertFalse(objectMapper.writeValueAsString(body).contains("payload_pointer"));
        assertFalse(objectMapper.writeValueAsString(body).contains("Must not leak"));
        assertFalse(objectMapper.writeValueAsString(body).contains("content"));
    }

    @Test
    void emptyDerivedStateIsAnExplicitEmptyProjection() {
        Session parent = newSession(owner, workspace, "Empty parent");
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + parent.getId() + "/derived-state",
                HttpMethod.GET, bearer(ownerToken), Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(List.of(), response.getBody().get("activeChildren"));
        assertEquals(List.of(), response.getBody().get("terminalNotices"));
    }

    @Test
    void derivedStateDoesNotRevealAnotherUsersSession() {
        Session parent = newSession(owner, workspace, "Private parent");
        User other = users.save(new User("invisible-" + UUID.randomUUID() + "@test.com", "hash",
                UserRole.USER, "Invisible user"));
        String otherToken = jwtTokenProvider.createAccessToken(other.getId().toString(), other.getEmail(),
                "USER", workspace.getId().toString());

        ResponseEntity<Map> notWorkspaceMember = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + parent.getId() + "/derived-state",
                HttpMethod.GET, bearer(otherToken), Map.class);
        workspaceUsers.saveAndFlush(new WorkspaceUser(workspace.getId().toString(), other.getId().toString(),
                WorkspaceRole.MEMBER));

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + parent.getId() + "/derived-state",
                HttpMethod.GET, bearer(otherToken), Map.class);
        ResponseEntity<Map> invalidId = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/not-a-uuid/derived-state",
                HttpMethod.GET, bearer(ownerToken), Map.class);
        ResponseEntity<Map> unauthenticated = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + parent.getId() + "/derived-state",
                HttpMethod.GET, new HttpEntity<>(new HttpHeaders()), Map.class);
        String serviceToken = jwtTokenProvider.createAccessToken(owner.getId().toString(), owner.getEmail(),
                "SERVICE", workspace.getId().toString());
        ResponseEntity<Map> forbiddenRole = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + parent.getId() + "/derived-state",
                HttpMethod.GET, bearer(serviceToken), Map.class);

        assertEquals(HttpStatus.NOT_FOUND, notWorkspaceMember.getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, invalidId.getStatusCode());
        assertEquals(HttpStatus.UNAUTHORIZED, unauthenticated.getStatusCode());
        assertEquals(HttpStatus.FORBIDDEN, forbiddenRole.getStatusCode());
    }

    private Session newSession(User user, Workspace ws, String title) {
        Session session = new Session(ws.getId().toString(), user.getId().toString(), title);
        session.setId(UUID.randomUUID());
        return sessions.saveAndFlush(session);
    }

    private Session spawnSession(User user, Workspace ws, String title, Session parent, ChatRun parentRun) {
        Session child = new Session(ws.getId().toString(), user.getId().toString(), title);
        child.setId(UUID.randomUUID());
        child.setKind(Session.KIND_SPAWN);
        child.setSpawnedFromSessionId(parent.getId());
        child.setSpawnedFromRunId(parentRun.getId());
        child.setSpawnedAt(Instant.now());
        return sessions.saveAndFlush(child);
    }

    private ChatRun newRun(Session session, String status, String origin) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), session.getId().toString(),
                session.getUserId(), session.getWorkspaceId(), "derived-" + UUID.randomUUID(),
                "a".repeat(64), "provider", "model", "workspace", status);
        run.setOrigin(origin);
        return chatRuns.saveAndFlush(run);
    }

    private void insertInbox(Session parent, Session child, ChatRun run, String state) {
        String payload = "{\"sessionId\":\"" + child.getId() + "\",\"runId\":\"" + run.getId()
                + "\",\"state\":\"" + state + "\"}";
        jdbcTemplate.update("INSERT INTO inbox (id, to_session_id, type, ref, payload_pointer, created_at) "
                        + "VALUES (?, ?, 'child_terminal', ?, CAST(? AS jsonb), CURRENT_TIMESTAMP)",
                UUID.randomUUID(), parent.getId(), run.getId(), payload);
    }

    private Map<?, ?> findByRunId(List<?> entries, String runId) {
        return entries.stream().map(Map.class::cast)
                .filter(entry -> runId.equals(entry.get("runId")))
                .findFirst().orElseThrow();
    }

    private HttpEntity<Void> bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return new HttpEntity<>(headers);
    }
}
