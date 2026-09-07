package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ApprovalServiceTest {

    private final ChatApprovalRepository approvals = mock(ChatApprovalRepository.class);
    private final ChatRunRepository runs = mock(ChatRunRepository.class);
    private final ApprovalAgentClient agent = mock(ApprovalAgentClient.class);
    private final ApprovalService service = new ApprovalService(approvals, runs, agent);

    @Test
    void recordPendingBindsAgentEventToAuthoritativeRun() {
        ChatRun run = new ChatRun("run-1", "session-1", "user-1", "workspace-1",
                "idem-1", "hash", "openai", "model", "workspace", "running");
        when(runs.findById("run-1")).thenReturn(Optional.of(run));
        when(approvals.findById("approval-1")).thenReturn(Optional.empty());

        service.recordPending(Map.of(
                "requestId", "approval-1",
                "runId", "run-1",
                "sessionId", "session-1",
                "workspaceId", "workspace-1",
                "tool", "request_approval",
                "action", "delete file",
                "details", "README.md",
                "expiresAt", Instant.now().plusSeconds(60).toString()),
                "session-1", "run-1", "user-1", "workspace-1");

        ArgumentCaptor<ChatApproval> captor = ArgumentCaptor.forClass(ChatApproval.class);
        verify(approvals).save(captor.capture());
        assertEquals("approval-1", captor.getValue().getRequestId());
        assertEquals("pending", captor.getValue().getState());
        assertEquals("user-1", captor.getValue().getUserId());
    }

    @Test
    void recordPendingRejectsMismatchedRunIdentity() {
        ChatRun run = new ChatRun("run-1", "session-1", "user-1", "workspace-1",
                "idem-1", "hash", "openai", "model", "workspace", "running");
        when(runs.findById("run-1")).thenReturn(Optional.of(run));

        CpApiException error = assertThrows(CpApiException.class, () -> service.recordPending(Map.of(
                "requestId", "approval-1",
                "runId", "run-1",
                "sessionId", "other-session",
                "action", "delete file"),
                "session-1", "run-1", "user-1", "workspace-1"));

        assertEquals("AGENT_EVENT_ID_MISMATCH", error.getCode());
    }

    @Test
    void decidePersistsApprovedOnlyAfterAgentAccepts() {
        ChatApproval approval = pending("approval-1", Instant.now().plusSeconds(60));
        when(approvals.findOwnedForUpdate("approval-1", "user-1", "workspace-1"))
                .thenReturn(Optional.of(approval));
        when(agent.respond("approval-1", true))
                .thenReturn(Map.of("status", "accepted", "requestId", "approval-1", "approved", true));

        Map<String, Object> response = service.decide("approval-1", "user-1", "workspace-1", true);

        assertEquals("accepted", response.get("status"));
        assertEquals("approved", approval.getState());
        assertTrue(approval.getApproved());
        verify(approvals).saveAndFlush(approval);
    }

    @Test
    void decideRejectsExpiredApprovalBeforeCallingAgent() {
        ChatApproval approval = pending("approval-1", Instant.now().minusSeconds(1));
        when(approvals.findOwnedForUpdate("approval-1", "user-1", "workspace-1"))
                .thenReturn(Optional.of(approval));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.decide("approval-1", "user-1", "workspace-1", false));

        assertEquals(410, error.getStatus().value());
        assertEquals("APPROVAL_EXPIRED", error.getCode());
    }

    @Test
    void replayIsScopedToTheAuthorizedSessionAndWorkspace() {
        ChatApproval approval = pending("approval-1", Instant.now().plusSeconds(60));
        when(approvals.findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
                "session-1", "user-1", "workspace-1", List.of("pending", "dispatching")))
                .thenReturn(List.of(approval));

        List<Map<String, Object>> replay = service.replayPending("session-1", "user-1", "workspace-1");

        assertEquals(1, replay.size());
        assertEquals("approval-1", replay.get(0).get("requestId"));
        assertEquals(true, replay.get(0).get("replayed"));
    }

    private ChatApproval pending(String requestId, Instant expiresAt) {
        return new ChatApproval(requestId, "run-1", "session-1", "user-1", "workspace-1",
                "request_approval", "delete file", "README.md", "pending", expiresAt);
    }
}
