package com.cc01cc.p.xihe.cp.scheduled;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.mockito.Mockito;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.after;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0489 T1.2：扫描主循环——expired 优先、grace 下界、CAS 认领放弃、
 * firing 占位重叠仅日志、executor 拒绝/异常/超时 → missed(dispatch_failed)。
 */
class ScheduledTaskScanServiceTest {

    private static final long GRACE_MS = 600_000L;

    private ScheduledTaskRepository repository;
    private ScheduledTaskDispatcher dispatcher;
    private ScheduledTaskScanService scanService;

    @BeforeEach
    void setUp() {
        repository = Mockito.mock(ScheduledTaskRepository.class);
        dispatcher = Mockito.mock(ScheduledTaskDispatcher.class);
        // 内联 executor：提交即同步执行，whenComplete 在同线程完成，测试确定性。
        scanService = new ScheduledTaskScanService(
                repository, dispatcher, Runnable::run, GRACE_MS, 60_000L);
        when(repository.expireDueOnceTasks(any())).thenReturn(0);
        when(repository.markOverdueMissed(anyString(), any(), anyString(), any())).thenReturn(0);
        when(repository.markStaleFiringMissed(any(), anyString(), any())).thenReturn(0);
        when(repository.findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(anyString(), any()))
                .thenReturn(List.of());
        when(repository.countByStatusAndNextFireAtBefore(anyString(), any())).thenReturn(0L);
        when(repository.markMissed(any(), anyCollection(), anyString(), any())).thenReturn(1);
        when(dispatcher.dispatch(any())).thenReturn(ScheduledTaskDispatcher.DispatchOutcome.DISPATCHED);
    }

    private static ScheduledTask dueTask(Instant nextFireAt) {
        ScheduledTask task = new ScheduledTask();
        task.setId(UUID.randomUUID());
        task.setWorkspaceId(UUID.randomUUID());
        task.setUserId(UUID.randomUUID());
        task.setTriggerKind(ScheduledTask.TRIGGER_DELAY_ONCE);
        task.setTargetKind(ScheduledTask.TARGET_JOB_DISPATCH);
        task.setTimezone("UTC");
        task.setStatus(ScheduledTask.STATUS_SCHEDULED);
        task.setNextFireAt(nextFireAt);
        task.setExpiresAt(nextFireAt.plusSeconds(3600));
        return task;
    }

    @Test
    void scan_expires_before_overdue_and_before_firing_timeout() {
        ScheduledTask task = dueTask(Instant.now().minusSeconds(5));
        when(repository.claimToFiring(eq(task.getId()), any())).thenReturn(1);
        when(repository.findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(anyString(), any()))
                .thenReturn(List.of(task));

        scanService.scanScheduledTasks();

        InOrder order = inOrder(repository);
        order.verify(repository).expireDueOnceTasks(any(Instant.class));
        order.verify(repository).markOverdueMissed(eq(ScheduledTask.STATUS_SCHEDULED), any(Instant.class),
                eq(ScheduledTask.REASON_OVERDUE_GRACE), any(Instant.class));
        order.verify(repository).markStaleFiringMissed(any(Instant.class),
                eq(ScheduledTask.REASON_DISPATCH_FAILED), any(Instant.class));
        order.verify(repository).findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(
                eq(ScheduledTask.STATUS_SCHEDULED), any(Instant.class));
        order.verify(repository).claimToFiring(task.getId(), task.getNextFireAt());
        verify(dispatcher).dispatch(task);
    }

    @Test
    void grace_cutoff_is_now_minus_grace_for_overdue_and_firing_timeout() {
        Instant beforeScan = Instant.now();
        scanService.scanScheduledTasks();
        Instant afterScan = Instant.now();

        ArgumentCaptor<Instant> overdueCutoff = ArgumentCaptor.forClass(Instant.class);
        verify(repository).markOverdueMissed(anyString(), overdueCutoff.capture(), anyString(), any());
        ArgumentCaptor<Instant> firingCutoff = ArgumentCaptor.forClass(Instant.class);
        verify(repository).markStaleFiringMissed(firingCutoff.capture(), anyString(), any());
        Instant expectedCutoff = beforeScan.minusMillis(GRACE_MS);
        assertTrue(overdueCutoff.getValue().isBefore(expectedCutoff.plusSeconds(5))
                        && overdueCutoff.getValue().isAfter(expectedCutoff.minusSeconds(5)),
                "overdue cutoff must be scan-start minus grace: " + overdueCutoff.getValue());
        assertEquals(overdueCutoff.getValue().getEpochSecond(), firingCutoff.getValue().getEpochSecond());
        assertTrue(overdueCutoff.getValue().isBefore(beforeScan),
                "cutoff must lie in the past relative to scan start");
        assertTrue(overdueCutoff.getValue().isBefore(afterScan));
    }

    @Test
    void cas_conflict_abandons_the_claim_without_dispatch() {
        ScheduledTask task = dueTask(Instant.now().minusSeconds(5));
        when(repository.claimToFiring(eq(task.getId()), any())).thenReturn(0);
        when(repository.findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(anyString(), any()))
                .thenReturn(List.of(task));

        scanService.scanScheduledTasks();

        verify(dispatcher, never()).dispatch(any());
        verify(repository, never()).markMissed(any(), anyCollection(), anyString(), any());
    }

    @Test
    void firing_placeholder_skips_due_rows_and_only_logs_overlap() {
        // 重叠（firing 占位）：due 查询只返回 scheduled 行，firing 行无行可认领；
        // 扫描仅以 firing_overlap 计数留痕，不改状态。
        when(repository.findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(anyString(), any()))
                .thenReturn(List.of());
        when(repository.countByStatusAndNextFireAtBefore(eq(ScheduledTask.STATUS_FIRING), any()))
                .thenReturn(1L);

        scanService.scanScheduledTasks();

        verify(repository, never()).claimToFiring(any(), any());
        verify(dispatcher, never()).dispatch(any());
        verify(repository).countByStatusAndNextFireAtBefore(eq(ScheduledTask.STATUS_FIRING),
                any(Instant.class));
    }

    @Test
    void executor_rejection_marks_row_missed_dispatch_failed() {
        ScheduledTask task = dueTask(Instant.now().minusSeconds(5));
        when(repository.claimToFiring(eq(task.getId()), any())).thenReturn(1);
        when(repository.findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(anyString(), any()))
                .thenReturn(List.of(task));
        ScheduledTaskScanService rejecting = new ScheduledTaskScanService(repository, dispatcher,
                command -> {
                    throw new RejectedExecutionException("scheduled dispatch queue is full");
                }, GRACE_MS, 60_000L);

        rejecting.scanScheduledTasks();

        verify(repository).markMissed(eq(task.getId()), eq(List.of(ScheduledTask.STATUS_FIRING)),
                eq(ScheduledTask.REASON_DISPATCH_FAILED), any(Instant.class));
        verify(dispatcher, never()).dispatch(any());
    }

    @Test
    void dispatch_exception_marks_row_missed_dispatch_failed() {
        ScheduledTask task = dueTask(Instant.now().minusSeconds(5));
        when(repository.claimToFiring(eq(task.getId()), any())).thenReturn(1);
        when(repository.findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(anyString(), any()))
                .thenReturn(List.of(task));
        when(dispatcher.dispatch(any())).thenThrow(new IllegalStateException("dispatch exploded"));

        scanService.scanScheduledTasks();

        verify(repository).markMissed(eq(task.getId()), eq(List.of(ScheduledTask.STATUS_FIRING)),
                eq(ScheduledTask.REASON_DISPATCH_FAILED), any(Instant.class));
    }

    @Test
    void dispatch_timeout_marks_row_missed_dispatch_failed() throws Exception {
        ScheduledTask task = dueTask(Instant.now().minusSeconds(5));
        when(repository.claimToFiring(eq(task.getId()), any())).thenReturn(1);
        when(repository.findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(anyString(), any()))
                .thenReturn(List.of(task));
        CountDownLatch release = new CountDownLatch(1);
        doAnswer(invocation -> {
            if (!release.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("dispatch latch was never released");
            }
            return ScheduledTaskDispatcher.DispatchOutcome.DISPATCHED;
        }).when(dispatcher).dispatch(any());
        ExecutorService pool = Executors.newSingleThreadExecutor();
        ScheduledTaskScanService shortTimeout = new ScheduledTaskScanService(repository, dispatcher,
                pool::execute, GRACE_MS, 50L);
        try {
            shortTimeout.scanScheduledTasks();
            verify(repository, timeout(2_000)).markMissed(eq(task.getId()),
                    eq(List.of(ScheduledTask.STATUS_FIRING)),
                    eq(ScheduledTask.REASON_DISPATCH_FAILED), any(Instant.class));
            release.countDown();
            // 超时已按 missed 收口；迟到的成功回写不得再次改状态（本 mock 只验证未重复标 missed）。
            verify(repository, after(200).times(1)).markMissed(any(), anyCollection(), anyString(), any());
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void submit_dispatch_reports_rejection() {
        ScheduledTask task = dueTask(Instant.now().minusSeconds(1));
        assertTrue(scanService.submitDispatch(task),
                "inline executor must accept the dispatch");
        ScheduledTaskScanService rejecting = new ScheduledTaskScanService(repository, dispatcher,
                command -> {
                    throw new RejectedExecutionException("full");
                }, GRACE_MS, 60_000L);
        assertFalse(rejecting.submitDispatch(task));
    }
}
