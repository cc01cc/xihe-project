package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionFollowUpItemRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0489 T1.3：session_wakeup 适配——target_gone（404 归并）、busy→follow-up
 * 既有入队路径、空闲会话 fail-closed（待决策 handoff）、enqueue 冲突原样传播。
 */
class SessionWakeupServiceTest {

    private static final String SESSION_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    private static final String USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    private static final String WORKSPACE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    private static final String BRANCH_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

    private SessionService sessionService;
    private ChatRunRepository chatRunRepository;
    private SessionFollowUpItemRepository followUpItemRepository;
    private FollowUpQueueService followUpQueueService;
    private BranchPathService branchPathService;
    private SessionWakeupService service;

    @BeforeEach
    void setUp() {
        sessionService = Mockito.mock(SessionService.class);
        chatRunRepository = Mockito.mock(ChatRunRepository.class);
        followUpItemRepository = Mockito.mock(SessionFollowUpItemRepository.class);
        followUpQueueService = Mockito.mock(FollowUpQueueService.class);
        branchPathService = Mockito.mock(BranchPathService.class);
        service = new SessionWakeupService(sessionService, chatRunRepository,
                followUpItemRepository, followUpQueueService, branchPathService);
        when(chatRunRepository.existsBySessionIdAndStatusIn(anyString(), anyCollection()))
                .thenReturn(false);
        when(followUpItemRepository.countBySessionIdAndStatusIn(anyString(), anyCollection()))
                .thenReturn(0L);
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void missing_session_maps_to_target_gone() {
        when(sessionService.requireCurrent(anyString(), anyString(), anyString()))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "gone"));

        assertThrows(SessionWakeupService.TargetGoneException.class,
                () -> service.wakeup(SESSION_ID, USER_ID, WORKSPACE_ID, "hi", "sched-wakeup-1"));
    }

    @Test
    void non_not_found_conflict_propagates_unchanged() {
        when(sessionService.requireCurrent(anyString(), anyString(), anyString()))
                .thenThrow(new CpApiException(HttpStatus.CONFLICT, "SESSION_DELETING", "deleting"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.wakeup(SESSION_ID, USER_ID, WORKSPACE_ID, "hi", "sched-wakeup-1"));
        assertEquals("SESSION_DELETING", error.getCode());
    }

    @Test
    void free_session_fails_closed_start_unavailable_pending_decision() {
        assertThrows(SessionWakeupService.WakeupStartUnavailableException.class,
                () -> service.wakeup(SESSION_ID, USER_ID, WORKSPACE_ID, "hi", "sched-wakeup-1"));
        verify(followUpQueueService, never()).enqueue(anyString(), anyString(), anyString(),
                anyString(), any());
    }

    @Test
    void active_run_defers_through_follow_up_enqueue() {
        when(chatRunRepository.existsBySessionIdAndStatusIn(eq(SESSION_ID), anyCollection()))
                .thenReturn(true);
        when(branchPathService.ensureRootBranchId(SESSION_ID)).thenReturn(BRANCH_ID);

        SessionWakeupService.WakeupResult result =
                service.wakeup(SESSION_ID, USER_ID, WORKSPACE_ID, "wake up", "sched-wakeup-1");

        assertFalse(result.started());
        ArgumentCaptor<FollowUpCreateRequest> request =
                ArgumentCaptor.forClass(FollowUpCreateRequest.class);
        verify(followUpQueueService).enqueue(eq(SESSION_ID), eq(USER_ID), eq(WORKSPACE_ID),
                eq("sched-wakeup-1"), request.capture());
        assertEquals("wake up", request.getValue().content());
        assertEquals(BRANCH_ID, request.getValue().branchId());
        assertEquals("none", request.getValue().toolMode());
        assertEquals(List.of(), request.getValue().attachments());
        assertNull(TenantContext.getUserId(), "tenant context must be cleared after enqueue");
    }

    @Test
    void outstanding_queue_defers_through_follow_up_enqueue() {
        when(followUpItemRepository.countBySessionIdAndStatusIn(eq(SESSION_ID), anyCollection()))
                .thenReturn(2L);
        when(branchPathService.ensureRootBranchId(SESSION_ID)).thenReturn(BRANCH_ID);

        SessionWakeupService.WakeupResult result =
                service.wakeup(SESSION_ID, USER_ID, WORKSPACE_ID, "wake up", "sched-wakeup-1");

        assertFalse(result.started());
        verify(followUpQueueService).enqueue(eq(SESSION_ID), eq(USER_ID), eq(WORKSPACE_ID),
                eq("sched-wakeup-1"), any(FollowUpCreateRequest.class));
    }

    @Test
    void enqueue_receives_task_identity_as_tenant_context_during_call() {
        when(chatRunRepository.existsBySessionIdAndStatusIn(eq(SESSION_ID), anyCollection()))
                .thenReturn(true);
        when(branchPathService.ensureRootBranchId(SESSION_ID)).thenReturn(BRANCH_ID);
        AtomicReference<String> seenUser = new AtomicReference<>();
        AtomicReference<String> seenWorkspace = new AtomicReference<>();
        doAnswer(invocation -> {
            seenUser.set(TenantContext.getUserId());
            seenWorkspace.set(TenantContext.getWorkspaceId());
            return null;
        }).when(followUpQueueService).enqueue(anyString(), anyString(), anyString(), anyString(), any());

        service.wakeup(SESSION_ID, USER_ID, WORKSPACE_ID, "hi", "sched-wakeup-1");

        assertEquals(USER_ID, seenUser.get());
        assertEquals(WORKSPACE_ID, seenWorkspace.get());
        assertNull(TenantContext.getUserId());
    }

    @Test
    void enqueue_conflict_propagates_for_dispatcher_classification() {
        when(chatRunRepository.existsBySessionIdAndStatusIn(eq(SESSION_ID), anyCollection()))
                .thenReturn(true);
        when(branchPathService.ensureRootBranchId(SESSION_ID)).thenReturn(BRANCH_ID);
        when(followUpQueueService.enqueue(anyString(), anyString(), anyString(), anyString(), any()))
                .thenThrow(new CpApiException(HttpStatus.CONFLICT, "FOLLOW_UP_QUEUE_FULL", "full"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.wakeup(SESSION_ID, USER_ID, WORKSPACE_ID, "hi", "sched-wakeup-1"));
        assertEquals("FOLLOW_UP_QUEUE_FULL", error.getCode());
        assertNull(TenantContext.getUserId(), "tenant context must be cleared on failure");
    }
}
