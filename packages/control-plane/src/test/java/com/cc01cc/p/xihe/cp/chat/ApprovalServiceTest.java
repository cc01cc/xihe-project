package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ApprovalServiceTest {

    private final ChatApprovalRepository approvals = mock(ChatApprovalRepository.class);
    private final ChatRunRepository runs = mock(ChatRunRepository.class);
    private final ApprovalAgentClient agent = mock(ApprovalAgentClient.class);
    private final OperationService operationService = mock(OperationService.class);
    private final ApprovalService service = new ApprovalService(approvals, runs, agent, new ObjectMapper(), operationService);

    private static final String TEST_RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String TEST_REQUEST_ID = "22222222-2222-2222-2222-222222222222";
    private static final String TEST_USER = "33333333-3333-3333-3333-333333333333";
    private static final String TEST_WORKSPACE = "44444444-4444-4444-4444-444444444444";
    private static final String TEST_SESSION = "55555555-5555-5555-5555-555555555555";

    private Map<String, Object> approvalPayload(String sessionId) {
        return Map.of(
                "requestId", TEST_REQUEST_ID,
                "runId", TEST_RUN_ID,
                "sessionId", sessionId,
                "workspaceId", TEST_WORKSPACE,
                "tool", "request_approval",
                "action", "delete file",
                "details", "README.md",
                "expiresAt", Instant.now().plusSeconds(60).toString());
    }

    private ChatRun runningRun() {
        return new ChatRun(TEST_RUN_ID, TEST_SESSION, TEST_USER, TEST_WORKSPACE,
                "idem-1", "hash", "openai", "model", "workspace", "running");
    }

    @Test
    void recordPendingBindsAgentEventToAuthoritativeRun() {
        ChatRun run = runningRun();
        when(runs.findById(UUID.fromString(TEST_RUN_ID))).thenReturn(Optional.of(run));
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.empty());
        UUID operationId = UUID.randomUUID();
        when(operationService.findOperationIdByRunId(TEST_RUN_ID)).thenReturn(operationId);

        service.recordPending(approvalPayload(TEST_SESSION),
                TEST_SESSION, TEST_RUN_ID, TEST_USER, TEST_WORKSPACE);

        ArgumentCaptor<ChatApproval> captor = ArgumentCaptor.forClass(ChatApproval.class);
        verify(approvals).save(captor.capture());
        assertEquals(TEST_REQUEST_ID, captor.getValue().getRequestId().toString());
        assertEquals("pending", captor.getValue().getState());
        assertEquals(TEST_USER, captor.getValue().getUserId());
        verify(operationService).appendApprovalItem(eq(operationId), eq(TEST_REQUEST_ID),
                eq("request_approval"), any());
    }

    @Test
    void recordPendingRejectsMismatchedRunIdentity() {
        ChatRun run = runningRun();
        when(runs.findById(UUID.fromString(TEST_RUN_ID))).thenReturn(Optional.of(run));

        CpApiException error = assertThrows(CpApiException.class, () -> service.recordPending(
                Map.of(
                        "requestId", TEST_REQUEST_ID,
                        "runId", TEST_RUN_ID,
                        "sessionId", "other-session",
                        "action", "delete file"),
                TEST_SESSION, TEST_RUN_ID, TEST_USER, TEST_WORKSPACE));

        assertEquals("AGENT_EVENT_ID_MISMATCH", error.getCode());
    }

    @Test
    void decidePersistsApprovedOnlyAfterAgentAccepts() {
        ChatApproval approval = pending(Instant.now().plusSeconds(60));
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(approval));
        when(approvals.markDispatching(eq(UUID.fromString(TEST_REQUEST_ID)), eq(true), any(Instant.class)))
                .thenReturn(1);
        when(approvals.markDecided(eq(UUID.fromString(TEST_REQUEST_ID)), eq("approved"), any(Instant.class)))
                .thenReturn(1);
        when(agent.respond(TEST_REQUEST_ID, true))
                .thenReturn(Map.of("status", "accepted", "requestId", TEST_REQUEST_ID, "approved", true));

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE, true);

        assertEquals("accepted", response.get("status"));
        verify(approvals).markDecided(eq(UUID.fromString(TEST_REQUEST_ID)), eq("approved"), any());
        verify(operationService).resolveApprovalItem(TEST_REQUEST_ID, true);
        verify(approvals, never()).saveAndFlush(any());
    }

    @Test
    void decideRejectsExpiredApprovalBeforeCallingAgent() {
        ChatApproval approval = pending(Instant.now().minusSeconds(1));
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(approval));
        when(approvals.markExpired(eq(UUID.fromString(TEST_REQUEST_ID)), any(Instant.class))).thenReturn(1);

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE, false));

        assertEquals(410, error.getStatus().value());
        assertEquals("APPROVAL_EXPIRED", error.getCode());
        verify(approvals).markExpired(eq(UUID.fromString(TEST_REQUEST_ID)), any());
        verify(agent, never()).respond(any(), anyBoolean());
    }

    @Test
    void replayIsScopedToTheAuthorizedSessionAndWorkspace() {
        ChatApproval approval = pending(Instant.now().plusSeconds(60));
        when(approvals.findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(TEST_SESSION, TEST_USER, TEST_WORKSPACE, List.of("pending", "dispatching")))
                .thenReturn(List.of(approval));

        List<Map<String, Object>> replay = service.replayPending(TEST_SESSION, TEST_USER, TEST_WORKSPACE);

        assertEquals(1, replay.size());
        assertEquals(TEST_REQUEST_ID, replay.get(0).get("requestId").toString());
        assertEquals(true, replay.get(0).get("replayed"));
    }

    @Test
    void consumeApprovedGrantRequiresExactToolAndArguments() {
        ChatApproval approval = new ChatApproval(
                TEST_REQUEST_ID, TEST_RUN_ID, TEST_SESSION, TEST_USER, TEST_WORKSPACE,
                "write_file", "Execute write_file",
                "{\"tool\":\"write_file\",\"arguments\":{}}",
                "approved", Instant.now().plusSeconds(60), null, "require_approval");
        approval.setApproved(true);
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(approval));
        when(approvals.consumeApprovedGrant(eq(UUID.fromString(TEST_REQUEST_ID)), eq(TEST_USER),
                eq(TEST_WORKSPACE), eq(TEST_SESSION), eq("write_file"), any(Instant.class))).thenReturn(1);

        boolean consumed = service.consumeApprovedGrant(
                TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE, TEST_SESSION, "write_file",
                "{\"jsonrpc\":\"2.0\",\"params\":{\"arguments\":{}},\"id\":1}");

        assertTrue(consumed);
        verify(approvals).consumeApprovedGrant(eq(UUID.fromString(TEST_REQUEST_ID)), eq(TEST_USER),
                eq(TEST_WORKSPACE), eq(TEST_SESSION), eq("write_file"), any(Instant.class));
    }

    @Test
    void consumeApprovedGrantRejectsReplayAndMismatchedArguments() {
        ChatApproval approval = new ChatApproval(
                TEST_REQUEST_ID, TEST_RUN_ID, TEST_SESSION, TEST_USER, TEST_WORKSPACE,
                "write_file", "Execute write_file",
                "{\"tool\":\"write_file\",\"arguments\":{\"path\":\"a\"}}",
                "approved", Instant.now().plusSeconds(60), null, "require_approval");
        approval.setApproved(true);
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(approval));

        assertFalse(service.consumeApprovedGrant(
                TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE, TEST_SESSION, "write_file",
                "{\"params\":{\"arguments\":{\"path\":\"b\"}}}"));
        when(approvals.consumeApprovedGrant(eq(UUID.fromString(TEST_REQUEST_ID)), eq(TEST_USER),
                eq(TEST_WORKSPACE), eq(TEST_SESSION), eq("write_file"), any(Instant.class))).thenReturn(0);
        assertFalse(service.consumeApprovedGrant(
                TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE, TEST_SESSION, "write_file",
                "{\"params\":{\"arguments\":{\"path\":\"a\"}}}"));
    }

    @Test
    void decideReturns400ForMalformedRequestId() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.decide("not-a-uuid", TEST_USER, TEST_WORKSPACE, true));

        assertEquals(400, error.getStatus().value());
        assertEquals("INVALID_REQUEST", error.getCode());
        verify(agent, never()).respond(any(), anyBoolean());
    }

    @Test
    void decideRetriesDispatchUnknownViaExplicitUserDecision() {
        ChatApproval approval = new ChatApproval(TEST_REQUEST_ID, TEST_RUN_ID, TEST_SESSION, TEST_USER, TEST_WORKSPACE,
                "request_approval", "delete file", "README.md", "dispatch_unknown",
                Instant.now().plusSeconds(60), null, null);
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(approval));
        when(approvals.markDispatching(eq(UUID.fromString(TEST_REQUEST_ID)), eq(true), any(Instant.class)))
                .thenReturn(1);
        when(approvals.markDecided(eq(UUID.fromString(TEST_REQUEST_ID)), eq("approved"), any(Instant.class)))
                .thenReturn(1);
        when(agent.respond(TEST_REQUEST_ID, true))
                .thenReturn(Map.of("status", "accepted", "requestId", TEST_REQUEST_ID, "approved", true));

        Map<String, Object> response = service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE, true);

        assertEquals("accepted", response.get("status"));
        verify(approvals).markDispatching(eq(UUID.fromString(TEST_REQUEST_ID)), eq(true), any());
        verify(approvals).markDecided(eq(UUID.fromString(TEST_REQUEST_ID)), eq("approved"), any());
        verify(operationService).resolveApprovalItem(TEST_REQUEST_ID, true);
    }

    @Test
    void decideExpiresStaleDispatchUnknownInsteadOfStuckConflict() {
        ChatApproval approval = new ChatApproval(TEST_REQUEST_ID, TEST_RUN_ID, TEST_SESSION, TEST_USER, TEST_WORKSPACE,
                "request_approval", "delete file", "README.md", "dispatch_unknown",
                Instant.now().minusSeconds(1), null, null);
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.of(approval));
        when(approvals.markExpired(eq(UUID.fromString(TEST_REQUEST_ID)), any(Instant.class))).thenReturn(1);

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.decide(TEST_REQUEST_ID, TEST_USER, TEST_WORKSPACE, true));

        assertEquals(410, error.getStatus().value());
        assertEquals("APPROVAL_EXPIRED", error.getCode());
        verify(agent, never()).respond(any(), anyBoolean());
    }

    @Test
    void recordPendingRejectsDetailsBeyondAgentPreviewBound() {
        when(runs.findById(UUID.fromString(TEST_RUN_ID))).thenReturn(Optional.of(runningRun()));
        HashMap<String, Object> payload = new HashMap<>(approvalPayload(TEST_SESSION));
        payload.put("details", "x".repeat(513));

        CpApiException error = assertThrows(CpApiException.class, () -> service.recordPending(
                payload, TEST_SESSION, TEST_RUN_ID, TEST_USER, TEST_WORKSPACE));

        assertEquals("AGENT_EVENT_INVALID", error.getCode());
        verify(approvals, never()).save(any());
    }

    @Test
    void recordPendingAcceptsDetailsAtAgentPreviewBound() {
        when(runs.findById(UUID.fromString(TEST_RUN_ID))).thenReturn(Optional.of(runningRun()));
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.empty());
        when(operationService.findOperationIdByRunId(TEST_RUN_ID)).thenReturn(null);
        HashMap<String, Object> payload = new HashMap<>(approvalPayload(TEST_SESSION));
        payload.put("details", "x".repeat(512));

        service.recordPending(payload, TEST_SESSION, TEST_RUN_ID, TEST_USER, TEST_WORKSPACE);

        verify(approvals).save(any(ChatApproval.class));
    }

    @Test
    void recordPendingLedgerPreviewRedactsSecrets() {
        when(runs.findById(UUID.fromString(TEST_RUN_ID))).thenReturn(Optional.of(runningRun()));
        when(approvals.findById(UUID.fromString(TEST_REQUEST_ID))).thenReturn(Optional.empty());
        UUID operationId = UUID.randomUUID();
        when(operationService.findOperationIdByRunId(TEST_RUN_ID)).thenReturn(operationId);
        HashMap<String, Object> payload = new HashMap<>(approvalPayload(TEST_SESSION));
        payload.put("details", "Authorization: Bearer abc123tokenvalue");

        service.recordPending(payload, TEST_SESSION, TEST_RUN_ID, TEST_USER, TEST_WORKSPACE);

        ArgumentCaptor<String> preview = ArgumentCaptor.forClass(String.class);
        verify(operationService).appendApprovalItem(eq(operationId), eq(TEST_REQUEST_ID),
                eq("request_approval"), preview.capture());
        assertFalse(preview.getValue().contains("abc123tokenvalue"));
        assertTrue(preview.getValue().contains("***redacted***"));
    }

    private ChatApproval pending(Instant expiresAt) {
        return new ChatApproval(TEST_REQUEST_ID, TEST_RUN_ID, TEST_SESSION, TEST_USER, TEST_WORKSPACE,
                "request_approval", "delete file", "README.md", "pending", expiresAt, null, null);
    }
}
