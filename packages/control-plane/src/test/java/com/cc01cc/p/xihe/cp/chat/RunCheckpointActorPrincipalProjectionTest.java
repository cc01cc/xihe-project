package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.RunCheckpointRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0640 T2: the public checkpoint slice projection exposes the run's
 * actor principal (chat_runs.agent_principal_id, PLAN-0623 V92) as a
 * nullable field — legacy rows keep null, no migration.
 */
class RunCheckpointActorPrincipalProjectionTest extends AbstractH2Test {

    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceFixture workspaceFixture;
    @Autowired
    private SessionRepository sessionRepository;
    @Autowired
    private ChatRunRepository chatRunRepository;
    @Autowired
    private RunCheckpointRepository checkpointRepository;
    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://127.0.0.1:9");
    }

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUpFixtures() {
        String email = "cp-actor-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "ActorPrincipal"),
                AuthResponse.class);
        assertTrue(reg.getStatusCode().is2xxSuccessful());
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("cp-actor-workspace", userId);
        workspaceId = workspace.getId().toString();
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId, 0);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Actor Session");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);
    }

    private String seedRun(UUID agentPrincipalId) {
        String runId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, sessionId, userId, workspaceId,
                "idem-" + runId, "hash", "openai", "gpt-test", "none", "succeeded");
        run.setTerminalOutcome("success");
        run.setAgentPrincipalId(agentPrincipalId);
        chatRunRepository.save(run);
        return runId;
    }

    private void seedCheckpoint(String sliceRef, String sourceRunId) {
        RunCheckpoint row = new RunCheckpoint();
        row.setId(UUID.randomUUID());
        row.setSourceRunId(sourceRunId);
        row.setSourceSessionId(sessionId);
        row.setWorkspaceId(workspaceId);
        row.setRootId(workspaceId);
        row.setSliceRef(sliceRef);
        row.setCapturedAt(Instant.parse("2026-09-15T00:00:00Z"));
        row.setState(RunCheckpoint.STATE_CAPTURED);
        row.setChangedFiles("[{\"status\":\"M\",\"path\":\"src/a.txt\"}]");
        row.setCreatedAt(Instant.now());
        row.setUpdatedAt(Instant.now());
        checkpointRepository.save(row);
    }

    private ResponseEntity<List> listCheckpoints() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        return restTemplate.exchange(url("/api/v1/workspaces/" + workspaceId + "/checkpoints"),
                HttpMethod.GET, new HttpEntity<>(headers), List.class);
    }

    @Test
    void listProjectsActorPrincipalIdFromChatRun() {
        UUID principalId = UUID.randomUUID();
        String runId = seedRun(principalId);
        seedCheckpoint("refs/xihe/slices/1757980000000-actor", runId);

        ResponseEntity<List> response = listCheckpoints();

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<?, ?> view = (Map<?, ?>) response.getBody().get(0);
        assertEquals(principalId.toString(), view.get("actorPrincipalId"));
        assertEquals(runId, view.get("sourceRunId"));
    }

    @Test
    void listLeavesActorPrincipalIdNullForLegacyRuns() {
        String runId = seedRun(null);
        seedCheckpoint("refs/xihe/slices/1757980000001-legacy", runId);

        ResponseEntity<List> response = listCheckpoints();

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<?, ?> view = (Map<?, ?>) response.getBody().get(0);
        assertTrue(view.containsKey("actorPrincipalId"));
        assertNull(view.get("actorPrincipalId"));
    }
}
