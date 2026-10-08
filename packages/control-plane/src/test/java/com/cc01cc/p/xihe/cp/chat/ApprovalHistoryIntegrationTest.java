package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.ApprovalHistory;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.ApprovalHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;

/**
 * PLAN-0464 T1.5: {@code approval_history} plus the single approval-domain
 * transaction that replaced the eight Operation-ledger write sites.
 */
class ApprovalHistoryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ApprovalService approvalService;
    @Autowired
    private ChatApprovalRepository approvalRepository;
    @Autowired
    private ApprovalHistoryRepository historyRepository;
    @Autowired
    private ChatRunRepository chatRunRepository;
    @Autowired
    private SessionRepository sessionRepository;
    @Autowired
    private WorkspaceRepository workspaceRepository;
    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @MockitoSpyBean
    private ApprovalHistoryWriter historyWriter;

    private String userId;
    private String workspaceId;

    @AfterEach
    void cleanUp() {
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
            jdbcTemplate.update("DELETE FROM workspace_users WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
            if (workspaceRepository.findById(UUID.fromString(workspaceId)).isPresent()) {
                workspaceRepository.deleteById(UUID.fromString(workspaceId));
            }
        }
        if (userId != null && userRepository.findById(UUID.fromString(userId)).isPresent()) {
            userRepository.deleteById(UUID.fromString(userId));
        }
        userId = null;
        workspaceId = null;
    }

    private record Fixture(String sessionId, String runId) {}

    private Fixture fixture() {
        User user = userRepository.save(new User(
                "approval-history-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Approval history"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Approval history workspace", userId));
        workspaceId = workspace.getId().toString();
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        Session session = new Session(workspaceId, userId, "Approval history session");
        session.setId(UUID.randomUUID());
        session = sessionRepository.saveAndFlush(session);
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                runId, session.getId().toString(), userId, workspaceId,
                "approval-history-" + runId, "approval-history-hash",
                "provider", "model", "none", "running"));
        return new Fixture(session.getId().toString(), runId);
    }

    private Map<String, Object> payload(Fixture fixture) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("requestId", UUID.randomUUID().toString());
        payload.put("runId", fixture.runId());
        payload.put("sessionId", fixture.sessionId());
        payload.put("tool", "write_file");
        payload.put("action", "run");
        payload.put("details", "path=a.md");
        payload.put("origin", ChatApproval.ORIGIN_CP_GATE);
        payload.put("expiresAt", Instant.now().plusSeconds(300).toString());
        return payload;
    }

    @Test
    void recordPendingWritesRequestedHistoryWithTheApprovalRow() {
        Fixture fixture = fixture();
        Map<String, Object> payload = payload(fixture);
        String requestId = (String) payload.get("requestId");

        approvalService.recordPending(payload, fixture.sessionId(), fixture.runId(), userId, workspaceId,
                ChatApproval.ORIGIN_CP_GATE);

        assertTrue(approvalRepository.findById(UUID.fromString(requestId)).isPresent(),
                "the approval row must be durable");
        List<ApprovalHistory> history = historyRepository.findByRequestIdOrderBySequenceAsc(
                UUID.fromString(requestId));
        assertEquals(1, history.size());
        assertEquals(ApprovalHistory.EVENT_REQUESTED, history.get(0).getEventType());
        assertEquals("pending", history.get(0).getToState());
        assertEquals(1L, history.get(0).getSequence());
        assertEquals("cp", history.get(0).getActorType());
    }

    /**
     * The single-domain transaction: a history failure after the approval row
     * insert must roll the row back instead of leaving a partial commit.
     */
    @Test
    void historyWriteFailureRollsBackTheApprovalRow() {
        Fixture fixture = fixture();
        Map<String, Object> payload = payload(fixture);
        String requestId = (String) payload.get("requestId");

        doThrow(new IllegalStateException("forced history failure"))
                .when(historyWriter)
                .append(any(), any(), any(), any(), any(), any(), any(), any(), any(), any());

        assertThrows(IllegalStateException.class, () ->
                approvalService.recordPending(payload, fixture.sessionId(), fixture.runId(), userId, workspaceId,
                        ChatApproval.ORIGIN_CP_GATE));

        assertTrue(approvalRepository.findById(UUID.fromString(requestId)).isEmpty(),
                "a failed history write must roll back the approval row (no partial commit)");
        assertTrue(historyRepository.findByRequestIdOrderBySequenceAsc(
                UUID.fromString(requestId)).isEmpty());
    }
}
