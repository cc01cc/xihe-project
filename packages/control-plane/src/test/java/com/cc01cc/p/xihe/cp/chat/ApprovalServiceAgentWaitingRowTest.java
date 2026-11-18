package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.policy.PolicyRevision;
import com.cc01cc.p.xihe.cp.policy.SessionApprovalMode;
import com.cc01cc.p.xihe.cp.policy.SessionPolicyState;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;
import java.time.temporal.ChronoUnit;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * G3-a C4-approval (task-188 D-1834): the Agent resume claim read mouth. The load-bearing
 * invariants: reading an approved/rejected row mutates NOTHING (C5 deliberate non-symmetry —
 * no consume on a fact read), and an overdue pending row is lazily settled to expired in the
 * DB (same discipline as the user-question mouth).
 */
class ApprovalServiceAgentWaitingRowTest {

    private ChatApprovalRepository approvals;
    private ApprovalService service;

    private static final String RUN_ID = "22222222-2222-2222-2222-222222222222";
    private static final Instant NOW = Instant.now();
    private static final Instant FUTURE = NOW.plus(1, ChronoUnit.HOURS);
    private static final Instant PAST = NOW.minus(1, ChronoUnit.HOURS);

    @BeforeEach
    void setUp() {
        approvals = mock(ChatApprovalRepository.class);
        ObjectMapper mapper = new ObjectMapper();
        service = new ApprovalService(
                approvals,
                mock(ChatRunRepository.class),
                mock(ApprovalAgentClient.class),
                mapper,
                mock(ApprovalHistoryWriter.class),
                mock(ApprovalGrantWriter.class),
                mock(com.cc01cc.p.xihe.cp.audit.AuditLogger.class),
                mock(ApprovalPolicySummary.class),
                mock(ApprovalPendingStore.class),
                mock(SessionPolicyState.class),
                mock(SessionApprovalMode.class),
                mock(PolicyRevision.class),
                mock(WorkspaceRepository.class),
                mock(AnswererChain.class),
                mock(GuardAdviceService.class),
                mock(SseEmitterManager.class),
                mock(ChatRunDispatchQueueService.class),
                mock(com.cc01cc.p.xihe.cp.service.InstanceIdentityService.class));
    }

    private int sequence;

    /** Deterministic, distinct, VALID UUIDs (ChatApproval's constructor parses requestId). */
    private String nextRequestId() {
        sequence++;
        return UUID.nameUUIDFromBytes(("req-" + sequence).getBytes(java.nio.charset.StandardCharsets.UTF_8))
                .toString();
    }

    private ChatApproval row(String requestId, String runId, String state, Instant expiresAt) {
        return new ChatApproval(requestId, runId, "sess-1", "user-1",
                "ws-1", "tool-x", "action", null, state, expiresAt);
    }

    private void stubSingle(ChatApproval approval) {
        when(approvals.findFirstByRunIdAndStateInOrderByCreatedAtDescRequestIdDesc(
                anyString(), any())).thenReturn(Optional.of(approval));
    }

    @Test
    void pendingUnexpiredSurfacesPendingWithDeadline() {
        ChatApproval pendingRow = row(nextRequestId(), RUN_ID, "pending", FUTURE);
        stubSingle(pendingRow);

        Optional<ApprovalService.AgentApprovalWaitingView> view = service.agentWaitingRow(RUN_ID);

        assertTrue(view.isPresent());
        assertEquals(pendingRow.getRequestId().toString(), view.get().requestId());
        assertEquals("pending", view.get().state());
        assertEquals(FUTURE, view.get().expiresAt());
        verify(approvals, never()).settleExpiredPendingById(any(), any());
    }

    @Test
    void overduePendingSettlesToExpiredAndSurfacesIt() {
        ChatApproval approval = row(nextRequestId(), RUN_ID, "pending", PAST);
        stubSingle(approval);
        when(approvals.settleExpiredPendingById(eq(approval.getRequestId()), any(Instant.class)))
                .thenReturn(1);

        Optional<ApprovalService.AgentApprovalWaitingView> view = service.agentWaitingRow(RUN_ID);

        assertTrue(view.isPresent());
        assertEquals("expired", view.get().state(), "overdue pending 惰性结算后按 expired 上报");
        assertEquals(PAST, view.get().expiresAt(), "expired 状态的 deadline 即事实本身");
        verify(approvals).settleExpiredPendingById(eq(approval.getRequestId()), any(Instant.class));
    }

    @Test
    void approvedRowSurfacesVerbatimAndNothingIsConsumedOrSettled() {
        stubSingle(row(nextRequestId(), RUN_ID, "approved", PAST));

        Optional<ApprovalService.AgentApprovalWaitingView> view = service.agentWaitingRow(RUN_ID);

        assertTrue(view.isPresent());
        assertEquals("approved", view.get().state());
        assertEquals(null, view.get().expiresAt(), "决策落定后 deadline 不再是事实");
        // C5 正当非对称：读事实 ≠ 消费答案。行状态、grant 消费、惰性结算全部不得发生。
        verify(approvals, never()).settleExpiredPendingById(any(), any());
        verify(approvals, never()).consumeApprovedGrant(any(), any(), any(), any(), any(), any());
        verify(approvals, never()).markDecided(any(), any(), any(), any());
    }

    @Test
    void rejectedRowSurfacesVerbatimAndNothingIsSettled() {
        stubSingle(row(nextRequestId(), RUN_ID, "rejected", PAST));

        Optional<ApprovalService.AgentApprovalWaitingView> view = service.agentWaitingRow(RUN_ID);

        assertTrue(view.isPresent());
        assertEquals("rejected", view.get().state());
        assertEquals(null, view.get().expiresAt());
        verify(approvals, never()).settleExpiredPendingById(any(), any());
    }

    @Test
    void alreadyExpiredRowSurfacesWithoutReSettling() {
        stubSingle(row(nextRequestId(), RUN_ID, "expired", PAST));

        Optional<ApprovalService.AgentApprovalWaitingView> view = service.agentWaitingRow(RUN_ID);

        assertTrue(view.isPresent());
        assertEquals("expired", view.get().state());
        assertEquals(PAST, view.get().expiresAt());
        verify(approvals, never()).settleExpiredPendingById(any(), any());
    }

    @Test
    void dispatchingFoldsIntoPending() {
        stubSingle(row(nextRequestId(), RUN_ID, "dispatching", FUTURE));

        Optional<ApprovalService.AgentApprovalWaitingView> view = service.agentWaitingRow(RUN_ID);

        assertTrue(view.isPresent());
        assertEquals("pending", view.get().state(),
                "dispatching = 决策在途，wire union 无 dispatch 态，折叠为 pending 保持等待");
        assertEquals(FUTURE, view.get().expiresAt());
        verify(approvals, never()).settleExpiredPendingById(any(), any());
    }

    @Test
    void dispatchUnknownFoldsIntoPending() {
        stubSingle(row(nextRequestId(), RUN_ID, "dispatch_unknown", FUTURE));

        Optional<ApprovalService.AgentApprovalWaitingView> view = service.agentWaitingRow(RUN_ID);

        assertTrue(view.isPresent());
        assertEquals("pending", view.get().state(),
                "dispatch_unknown 是 C5 显式重试领域，本口只报'仍在等'，不驱动重试");
        verify(approvals, never()).settleExpiredPendingById(any(), any());
    }

    @Test
    void noRowYieldsEmpty() {
        when(approvals.findFirstByRunIdAndStateInOrderByCreatedAtDescRequestIdDesc(
                anyString(), any())).thenReturn(Optional.empty());

        assertTrue(service.agentWaitingRow(RUN_ID).isEmpty());
    }

    @Test
    void invalidRunIdYieldsEmpty() {
        assertTrue(service.agentWaitingRow("not-a-uuid").isEmpty());
        verify(approvals, never()).findFirstByRunIdAndStateInOrderByCreatedAtDescRequestIdDesc(
                anyString(), any());
    }

    @Test
    void lostCasRaceReportsTheFreshFact() {
        ChatApproval decided = row(nextRequestId(), RUN_ID, "approved", PAST);
        // First read sees an overdue pending; the CAS settle loses (concurrent decide won).
        when(approvals.findFirstByRunIdAndStateInOrderByCreatedAtDescRequestIdDesc(
                anyString(), any()))
                .thenReturn(Optional.of(row(nextRequestId(), RUN_ID, "pending", PAST)))
                .thenReturn(Optional.of(decided));
        when(approvals.settleExpiredPendingById(eq(decided.getRequestId()), any(Instant.class)))
                .thenReturn(0);

        Optional<ApprovalService.AgentApprovalWaitingView> view = service.agentWaitingRow(RUN_ID);

        assertTrue(view.isPresent());
        assertEquals("approved", view.get().state(),
                "CAS 竞争失败时必须重读上报新事实，绝不能把已决定的行谎报成 expired");
    }
}