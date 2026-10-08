package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.SessionFollowUpItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.TaskScheduler;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class FollowUpQueueServiceTest {

    @AfterEach
    void clearTenantContext() {
        TenantContext.clear();
    }

    @Test
    void explicitContinueAllowsHeadAfterCancelledAnchor() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionFollowUpItemRepository items = mock(SessionFollowUpItemRepository.class);
        ChatRunRepository runs = mock(ChatRunRepository.class);
        FileRepository files = mock(FileRepository.class);
        BranchPathService branches = mock(BranchPathService.class);
        DbLockTimeout lockTimeout = mock(DbLockTimeout.class);
        EntityManager entityManager = mock(EntityManager.class);
        ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
        TaskScheduler taskScheduler = mock(TaskScheduler.class);
        FollowUpQueueService service = new FollowUpQueueService(sessions, items, runs, files, branches,
                lockTimeout, new ObjectMapper(), entityManager, events, taskScheduler);

        UUID sessionUuid = UUID.randomUUID();
        UUID parentRunUuid = UUID.randomUUID();
        String sessionId = sessionUuid.toString();
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        String branchId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "follow-up-test");
        session.setId(sessionUuid);
        SessionFollowUpItem item = SessionFollowUpItem.create();
        item.setId(UUID.randomUUID());
        item.setSessionId(sessionId);
        item.setQueueSequence(1);
        item.setStatus(SessionFollowUpItem.STATUS_PAUSED);
        item.setPauseReason(SessionFollowUpItem.PAUSE_PARENT_CANCELLED);
        item.setPauseRunId(parentRunUuid);
        item.setAnchorRunId(parentRunUuid);
        item.setBranchId(UUID.fromString(branchId));
        ChatRun parent = new ChatRun(parentRunUuid.toString(), sessionId, userId, workspaceId,
                "parent", "hash", null, null, "none", "cancelled");

        TenantContext.setUserId(userId);
        TenantContext.setWorkspaceId(workspaceId);
        when(sessions.findByIdForUpdate(sessionUuid)).thenReturn(Optional.of(session));
        when(items.findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                eq(sessionId), anyCollection())).thenReturn(List.of(item));
        when(runs.findById(parentRunUuid)).thenReturn(Optional.of(parent));
        when(branches.resolveVisibility(sessionId, branchId))
                .thenReturn(new BranchPathService.BranchVisibility(branchId, Map.of()));
        when(items.saveAndFlush(item)).thenReturn(item);

        FollowUpQueueService.ContinueResult continued = service.continueQueue(sessionId, userId, workspaceId);
        assertTrue(continued.changed());
        assertEquals(SessionFollowUpItem.STATUS_QUEUED, item.getStatus());
        assertEquals("continued_after_terminal", item.getPauseReason());

        UUID childRunUuid = UUID.randomUUID();
        FollowUpQueueService.AdmissionResult admission = service.admitHead(sessionId,
                ignored -> new FollowUpQueueService.ChildAdmission(childRunUuid, UUID.randomUUID()));

        assertTrue(admission.admitted());
        assertEquals(SessionFollowUpItem.STATUS_ADMITTED, item.getStatus());
        assertEquals(childRunUuid, item.getChildRunId());
        assertNull(item.getPauseReason());
    }

    @Test
    void leaseWakeIsScheduledOnceAndRecheckedBeforePublishing() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionFollowUpItemRepository items = mock(SessionFollowUpItemRepository.class);
        ChatRunRepository runs = mock(ChatRunRepository.class);
        FileRepository files = mock(FileRepository.class);
        BranchPathService branches = mock(BranchPathService.class);
        DbLockTimeout lockTimeout = mock(DbLockTimeout.class);
        EntityManager entityManager = mock(EntityManager.class);
        ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
        TaskScheduler taskScheduler = mock(TaskScheduler.class);
        FollowUpQueueService service = new FollowUpQueueService(sessions, items, runs, files, branches,
                lockTimeout, new ObjectMapper(), entityManager, events, taskScheduler);

        String sessionId = UUID.randomUUID().toString();
        Instant firstExpiry = Instant.now().plusSeconds(10);
        Instant renewedExpiry = firstExpiry.plusSeconds(10);
        ScheduledFuture<?> scheduled = mock(ScheduledFuture.class);
        List<Runnable> callbacks = new ArrayList<>();
        List<Instant> retryTimes = new ArrayList<>();
        when(runs.findLatestLeaseExpiryAfter(eq(sessionId), any(Instant.class)))
                .thenReturn(firstExpiry, renewedExpiry, null);
        when(taskScheduler.schedule(any(Runnable.class), any(Instant.class))).thenAnswer(invocation -> {
            callbacks.add(invocation.getArgument(0));
            retryTimes.add(invocation.getArgument(1));
            return scheduled;
        });

        service.publishAfterCommit(new FollowUpQueueWakeupEvent(sessionId));
        verify(events, never()).publishEvent(any(Object.class));

        assertEquals(1, callbacks.size());
        assertEquals(firstExpiry.plusMillis(50), retryTimes.get(0));

        callbacks.get(0).run();
        verify(events, never()).publishEvent(any(Object.class));
        assertEquals(2, callbacks.size());
        assertEquals(renewedExpiry.plusMillis(50), retryTimes.get(1));

        callbacks.get(1).run();
        verify(events).publishEvent(new FollowUpQueueWakeupEvent(sessionId));
    }

    @Test
    void admissionFailureWakeupSchedulesOnlyOneRetry() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionFollowUpItemRepository items = mock(SessionFollowUpItemRepository.class);
        ChatRunRepository runs = mock(ChatRunRepository.class);
        FileRepository files = mock(FileRepository.class);
        BranchPathService branches = mock(BranchPathService.class);
        DbLockTimeout lockTimeout = mock(DbLockTimeout.class);
        EntityManager entityManager = mock(EntityManager.class);
        ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
        TaskScheduler taskScheduler = mock(TaskScheduler.class);
        FollowUpQueueService service = new FollowUpQueueService(sessions, items, runs, files, branches,
                lockTimeout, new ObjectMapper(), entityManager, events, taskScheduler);

        String sessionId = UUID.randomUUID().toString();
        Instant beforeSchedule = Instant.now();
        ScheduledFuture<?> scheduled = mock(ScheduledFuture.class);
        List<Runnable> callbacks = new ArrayList<>();
        List<Instant> retryTimes = new ArrayList<>();
        when(taskScheduler.schedule(any(Runnable.class), any(Instant.class))).thenAnswer(invocation -> {
            callbacks.add(invocation.getArgument(0));
            retryTimes.add(invocation.getArgument(1));
            return scheduled;
        });

        service.scheduleAdmissionRetry(new FollowUpQueueWakeupEvent(sessionId));

        assertEquals(1, callbacks.size());
        assertTrue(retryTimes.get(0).isAfter(beforeSchedule));
        callbacks.get(0).run();
        verify(events).publishEvent(new FollowUpQueueWakeupEvent(sessionId, 1));

        service.scheduleAdmissionRetry(new FollowUpQueueWakeupEvent(sessionId, 1));

        assertEquals(1, callbacks.size(), "a failed retry must not reschedule indefinitely");
        verify(taskScheduler, org.mockito.Mockito.times(1))
                .schedule(any(Runnable.class), any(Instant.class));
    }

    @Test
    void schedulerFailureFallsBackToOneImmediateRetryEvent() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionFollowUpItemRepository items = mock(SessionFollowUpItemRepository.class);
        ChatRunRepository runs = mock(ChatRunRepository.class);
        FileRepository files = mock(FileRepository.class);
        BranchPathService branches = mock(BranchPathService.class);
        DbLockTimeout lockTimeout = mock(DbLockTimeout.class);
        EntityManager entityManager = mock(EntityManager.class);
        ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
        TaskScheduler taskScheduler = mock(TaskScheduler.class);
        FollowUpQueueService service = new FollowUpQueueService(sessions, items, runs, files, branches,
                lockTimeout, new ObjectMapper(), entityManager, events, taskScheduler);

        String sessionId = UUID.randomUUID().toString();
        when(taskScheduler.schedule(any(Runnable.class), any(Instant.class)))
                .thenThrow(new IllegalStateException("scheduler is stopping"));

        service.scheduleAdmissionRetry(new FollowUpQueueWakeupEvent(sessionId));

        verify(taskScheduler, org.mockito.Mockito.times(1))
                .schedule(any(Runnable.class), any(Instant.class));
        verify(events, org.mockito.Mockito.times(1))
                .publishEvent(new FollowUpQueueWakeupEvent(sessionId, 1));
    }

    @Test
    void missingAttachmentPausesHeadWithoutCallingAdmission() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionFollowUpItemRepository items = mock(SessionFollowUpItemRepository.class);
        ChatRunRepository runs = mock(ChatRunRepository.class);
        FileRepository files = mock(FileRepository.class);
        BranchPathService branches = mock(BranchPathService.class);
        DbLockTimeout lockTimeout = mock(DbLockTimeout.class);
        EntityManager entityManager = mock(EntityManager.class);
        ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
        TaskScheduler taskScheduler = mock(TaskScheduler.class);
        ObjectMapper mapper = new ObjectMapper();
        FollowUpQueueService service = new FollowUpQueueService(sessions, items, runs, files, branches,
                lockTimeout, mapper, entityManager, events, taskScheduler);

        UUID sessionUuid = UUID.randomUUID();
        UUID runUuid = UUID.randomUUID();
        UUID itemUuid = UUID.randomUUID();
        UUID fileUuid = UUID.randomUUID();
        String sessionId = sessionUuid.toString();
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        String branchId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "missing-attachment");
        session.setId(sessionUuid);
        SessionFollowUpItem item = SessionFollowUpItem.create();
        item.setId(itemUuid);
        item.setSessionId(sessionId);
        item.setQueueSequence(1);
        item.setStatus(SessionFollowUpItem.STATUS_QUEUED);
        item.setAnchorRunId(runUuid);
        item.setBranchId(UUID.fromString(branchId));
        item.setContent("use the attached file");
        item.setAttachmentRefs(mapper.createArrayNode().add(fileUuid.toString()));
        ChatRun parent = new ChatRun(runUuid.toString(), sessionId, userId, workspaceId,
                "parent", "hash", null, null, "none", "succeeded");
        AtomicBoolean admissionCalled = new AtomicBoolean(false);

        when(sessions.findByIdForUpdate(sessionUuid)).thenReturn(Optional.of(session));
        when(items.findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                eq(sessionId), anyCollection())).thenReturn(List.of(item));
        when(runs.findById(runUuid)).thenReturn(Optional.of(parent));
        when(branches.resolveVisibility(sessionId, branchId))
                .thenReturn(new BranchPathService.BranchVisibility(branchId, Map.of()));
        when(files.findAllById(any())).thenReturn(List.of());

        FollowUpQueueService.AdmissionResult result = service.admitHead(sessionId, ignored -> {
            admissionCalled.set(true);
            return new FollowUpQueueService.ChildAdmission(UUID.randomUUID(), UUID.randomUUID());
        });

        assertFalse(result.admitted());
        assertEquals(SessionFollowUpItem.STATUS_PAUSED, item.getStatus());
        assertEquals(SessionFollowUpItem.PAUSE_ATTACHMENT_UNAVAILABLE, item.getPauseReason());
        assertFalse(admissionCalled.get());
    }
}
