package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUserId;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RunTraceControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired private JwtTokenProvider jwtTokenProvider;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;

    private User owner;
    private Workspace workspace;
    private Session session;
    private ChatRun run;
    private User workspaceMember;
    private Workspace otherWorkspace;

    @BeforeEach
    void createOwnerRunFixture() {
        owner = userRepository.saveAndFlush(new User(
                "run-trace-api-owner-" + UUID.randomUUID() + "@test.com",
                "test-hash", UserRole.USER, "Run Trace API owner"));
        workspace = workspaceRepository.saveAndFlush(
                new Workspace("Run Trace API owner workspace", owner.getId().toString()));
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(
                workspace.getId().toString(), owner.getId().toString(), WorkspaceRole.OWNER));

        session = new Session(workspace.getId().toString(), owner.getId().toString(),
                "Run Trace API session");
        session.setId(UUID.randomUUID());
        session = sessionRepository.saveAndFlush(session);

        run = new ChatRun(UUID.randomUUID().toString(), session.getId().toString(),
                owner.getId().toString(), workspace.getId().toString(),
                "run-trace-api-" + UUID.randomUUID(), "request-hash",
                "test-provider", "test-model", "workspace", "succeeded");
        run.setOrigin(ChatRun.ORIGIN_USER_SUBMISSION);
        run.setTerminalOutcome("success");
        run.setTerminalAt(Instant.now().minusSeconds(1));
        run = chatRunRepository.saveAndFlush(run);
    }

    @AfterEach
    void deleteOwnerRunFixture() {
        if (run != null) {
            chatRunRepository.deleteById(run.getId());
        }
        if (session != null) {
            sessionRepository.deleteById(session.getId());
        }
        if (workspaceMember != null && workspace != null) {
            workspaceUserRepository.deleteById(new WorkspaceUserId(
                    workspace.getId().toString(), workspaceMember.getId().toString()));
        }
        if (otherWorkspace != null && owner != null) {
            workspaceUserRepository.deleteById(new WorkspaceUserId(
                    otherWorkspace.getId().toString(), owner.getId().toString()));
            workspaceRepository.deleteById(otherWorkspace.getId());
        }
        if (workspace != null && owner != null) {
            workspaceUserRepository.deleteById(new WorkspaceUserId(
                    workspace.getId().toString(), owner.getId().toString()));
            workspaceRepository.deleteById(workspace.getId());
        }
        if (workspaceMember != null) {
            userRepository.deleteById(workspaceMember.getId());
        }
        if (owner != null) {
            userRepository.deleteById(owner.getId());
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void traceRouteEnforcesBearerRunOwnerWorkspaceMembershipAndCurrentSession() {
        String tracePath = "/api/v1/chat/runs/" + run.getId() + "/trace";

        ResponseEntity<Map> unauthenticated = restTemplate.exchange(
                url(tracePath), HttpMethod.GET, new HttpEntity<>(new HttpHeaders()), Map.class);
        assertProblemEnvelope(unauthenticated, HttpStatus.UNAUTHORIZED);

        String ownerToken = token(owner, workspace);
        ResponseEntity<Map> ownerResponse = getTrace(tracePath, ownerToken);
        assertEquals(HttpStatus.OK, ownerResponse.getStatusCode());
        assertEquals(run.getId().toString(), ownerResponse.getBody().get("runId"));
        List<Map<String, Object>> events = (List<Map<String, Object>>) ownerResponse.getBody().get("events");
        assertTrue(events.stream().anyMatch(event ->
                "chat_run".equals(event.get("source"))
                        && "run.lifecycle".equals(event.get("kind"))
                        && "completed".equals(event.get("status"))));

        assertProblem(getTrace("/api/v1/chat/runs/not-a-uuid/trace", ownerToken),
                HttpStatus.NOT_FOUND, "RUN_NOT_FOUND");
        assertProblem(getTrace("/api/v1/chat/runs/" + UUID.randomUUID() + "/trace", ownerToken),
                HttpStatus.NOT_FOUND, "RUN_NOT_FOUND");

        workspaceMember = userRepository.saveAndFlush(new User(
                "run-trace-api-member-" + UUID.randomUUID() + "@test.com",
                "test-hash", UserRole.USER, "Run Trace API workspace member"));
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(
                workspace.getId().toString(), workspaceMember.getId().toString(), WorkspaceRole.MEMBER));
        assertProblem(getTrace(tracePath, token(workspaceMember, workspace)),
                HttpStatus.FORBIDDEN, "FORBIDDEN");

        otherWorkspace = workspaceRepository.saveAndFlush(
                new Workspace("Run Trace API second workspace", owner.getId().toString()));
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(
                otherWorkspace.getId().toString(), owner.getId().toString(), WorkspaceRole.OWNER));
        assertProblem(getTrace(tracePath, token(owner, otherWorkspace)),
                HttpStatus.FORBIDDEN, "FORBIDDEN");

        Session archived = sessionRepository.findById(session.getId()).orElseThrow();
        archived.setArchived(true);
        sessionRepository.saveAndFlush(archived);
        assertProblem(getTrace(tracePath, ownerToken), HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND");
    }

    private String token(User user, Workspace tokenWorkspace) {
        return jwtTokenProvider.createAccessToken(user.getId().toString(), user.getEmail(),
                user.getRole().name(), tokenWorkspace.getId().toString());
    }

    private ResponseEntity<Map> getTrace(String path, String bearerToken) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(bearerToken);
        return restTemplate.exchange(url(path), HttpMethod.GET, new HttpEntity<>(headers), Map.class);
    }

    private static void assertProblem(ResponseEntity<Map> response, HttpStatus status, String code) {
        assertProblemEnvelope(response, status);
        assertEquals(code, response.getBody().get("code"));
    }

    private static void assertProblemEnvelope(ResponseEntity<Map> response, HttpStatus status) {
        assertEquals(status, response.getStatusCode());
        Map<?, ?> body = assertInstanceOf(Map.class, response.getBody());
        assertNotNull(body.get("code"));
        assertNotNull(body.get("requestId"));
    }
}
