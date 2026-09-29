package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.SessionBranch;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
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
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PLAN-0409 browser-journey regression (2026-09-30): Session DELETE failed with
 * 500 INTERNAL_ERROR as soon as the session owned a non-root branch, because
 * messages were deleted while child branches still referenced them through the
 * ON DELETE RESTRICT anchor FK (V43 {@code fk_session_branches_anchor_message}).
 * Root-only sessions never hit it (root anchor columns are NULL), which is why
 * the existing suites stayed green.
 */
class SessionDeleteWithBranchIntegrationTest extends AbstractIntegrationTest {

    private String authToken;
    private String userId;
    private String workspaceId;

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private MessageRepository messageRepository;
    @Autowired private SessionBranchRepository sessionBranchRepository;
    @Autowired private SessionService sessionService;
    @Autowired private BranchPathService branchPathService;
    @Autowired private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void registerUserAndWorkspace() {
        String email = "session-del-branch-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registered = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                new RegisterRequest(email, com.cc01cc.p.xihe.cp.integration.TestDataFactory.PASSWORD,
                        "SessionDeleteBranchTest"),
                AuthResponse.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode());
        authToken = registered.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(user.getId()).stream()
                .findFirst().orElseThrow().getId().toString();
        if (workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(
                UUID.fromString(workspaceId), UUID.fromString(userId)).isEmpty()) {
            workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        }
    }

    @Test
    void deleteSessionWithChildBranchRemovesBranchAnchoredRowsWithoutFkViolation() {
        String sessionId = UUID.randomUUID().toString();
        sessionService.createWithId(sessionId, userId, workspaceId,
                "Delete with child branch", "openai", "gpt-test", null);
        String rootBranchId = branchPathService.ensureRootBranchId(sessionId);

        String runId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, sessionId, userId, workspaceId,
                "del-branch-" + runId, "a".repeat(64), "openai", "gpt-test", "none", "succeeded");
        run.setBranchId(rootBranchId);
        run.setTerminalAt(Instant.now());
        run.setTerminalOutcome("success");
        run = chatRunRepository.saveAndFlush(run);

        Message anchor = new Message(sessionId, MessageRole.USER, "anchor before delete");
        anchor.setRunId(runId);
        anchor.setBranchId(rootBranchId);
        anchor = messageRepository.saveAndFlush(anchor);

        SessionBranch childBranch = new SessionBranch(UUID.randomUUID(), sessionId);
        childBranch.setParentBranchId(rootBranchId);
        childBranch.setForkPointMessageId(anchor.getId().toString());
        childBranch.setForkPointRunId(run.getId().toString());
        childBranch.setForkPointSequence(1L);
        childBranch.setIdempotencyKey("del-branch-" + sessionId);
        childBranch.setRequestHash("a".repeat(64));
        sessionBranchRepository.saveAndFlush(childBranch);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/sessions/" + sessionId), HttpMethod.DELETE,
                new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.NO_CONTENT, response.getStatusCode(),
                "DELETE must not fail on the branch anchor FK");

        assertEquals(0, jdbcTemplate.queryForObject(
                "select count(*) from session_branches where session_id = ?", Integer.class,
                UUID.fromString(sessionId)));
        assertEquals(0, jdbcTemplate.queryForObject(
                "select count(*) from messages where session_id = ?", Integer.class,
                UUID.fromString(sessionId)));
        assertEquals(0, jdbcTemplate.queryForObject(
                "select count(*) from chat_runs where session_id = ?", Integer.class,
                UUID.fromString(sessionId)));
        assertEquals(0, jdbcTemplate.queryForObject(
                "select count(*) from sessions where id = ?", Integer.class,
                UUID.fromString(sessionId)));
    }
}
