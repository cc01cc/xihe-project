package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * PLAN-0489 T1.2（contract: PLAN-0486 spec/scheduled-task.md v3.3 §3，D4 单实例）：
 * {@code scheduled_tasks} 的周期扫描——发现与状态推进在扫描线程，分派动作提交
 * 独立 executor（{@code scheduledDispatchExecutor}）异步执行（同
 * {@code JobReconciliationService} 的属性化 @Scheduled 同构模式）。
 *
 * <p>每轮顺序（0486 §2 优先级）：① 过期扫描（delay_once 超过 expires_at →
 * expired，先于 missed 判定）→ ② overdue 扫描（scheduled 且 next_fire_at 早于
 * grace 下界 → missed(overdue_grace)，不自动补跑）→ ③ firing 超时（认领后
 * updated_at 早于 grace 下界 → missed(dispatch_failed)，崩溃窗口转可见）→
 * ④ 到期认领（CAS scheduled→firing，带 next_fire_at 双前置；CAS 失败即放弃）
 * 并异步分派。重叠天然跳过：未完成的 firing 占位使下一次到期无行可认领，
 * 跳过仅日志留痕、状态不变（不变式④）。</p>
 *
 * <p>分派超时预算 60s（design 决策 #4）：{@code orTimeout} 兜底 →
 * missed(dispatch_failed)；队列满/拒绝（AbortPolicy）→ 该行 missed(dispatch_failed)
 * +日志。CAS 收口保证超时与成功回写单写者——超时后分派线程若再完成，其
 * firing→回写 CAS 失败仅日志留痕（at-most-once 不受影响）。</p>
 */
@Component
public class ScheduledTaskScanService {

    private static final Logger logger = LoggerFactory.getLogger(ScheduledTaskScanService.class);

    private final ScheduledTaskRepository scheduledTaskRepository;
    private final ScheduledTaskDispatcher dispatcher;
    private final WorkspaceEventManager workspaceEventManager;
    private final Executor dispatchExecutor;
    private final Duration grace;
    private final long dispatchTimeoutMs;

    public ScheduledTaskScanService(
            ScheduledTaskRepository scheduledTaskRepository,
            ScheduledTaskDispatcher dispatcher,
            WorkspaceEventManager workspaceEventManager,
            @Qualifier("scheduledDispatchExecutor") Executor dispatchExecutor,
            @Value("${cp.scheduled.grace-ms:600000}") long graceMs,
            @Value("${cp.scheduled.dispatch-timeout-ms:60000}") long dispatchTimeoutMs) {
        this.scheduledTaskRepository = scheduledTaskRepository;
        this.dispatcher = dispatcher;
        this.workspaceEventManager = workspaceEventManager;
        this.dispatchExecutor = dispatchExecutor;
        this.grace = Duration.ofMillis(graceMs);
        this.dispatchTimeoutMs = dispatchTimeoutMs;
    }

    @Scheduled(fixedDelayString = "${cp.scheduled.scan-interval-ms:30000}",
            initialDelayString = "${cp.scheduled.scan-initial-delay-ms:30000}")
    public void scanScheduledTasks() {
        Instant now = Instant.now();
        Instant graceCutoff = now.minus(grace);
        Set<UUID> changedWorkspaces = new LinkedHashSet<>();
        List<UUID> expiringWorkspaces = scheduledTaskRepository.findExpiringWorkspaceIds(now);
        int expired = scheduledTaskRepository.expireDueOnceTasks(now);
        if (expired > 0) {
            changedWorkspaces.addAll(expiringWorkspaces);
        }
        List<UUID> overdueWorkspaces = scheduledTaskRepository.findOverdueWorkspaceIds(
                ScheduledTask.STATUS_SCHEDULED, graceCutoff);
        int overdue = scheduledTaskRepository.markOverdueMissed(
                ScheduledTask.STATUS_SCHEDULED, graceCutoff,
                ScheduledTask.REASON_OVERDUE_GRACE, now);
        if (overdue > 0) {
            changedWorkspaces.addAll(overdueWorkspaces);
        }
        List<UUID> staleFiringWorkspaces = scheduledTaskRepository.findStaleFiringWorkspaceIds(graceCutoff);
        int firingTimeouts = scheduledTaskRepository.markStaleFiringMissed(
                graceCutoff, ScheduledTask.REASON_DISPATCH_FAILED, now);
        if (firingTimeouts > 0) {
            changedWorkspaces.addAll(staleFiringWorkspaces);
        }
        for (UUID workspaceId : changedWorkspaces) {
            workspaceEventManager.publishScheduledTasksChanged(workspaceId.toString());
        }
        List<ScheduledTask> due = scheduledTaskRepository
                .findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(ScheduledTask.STATUS_SCHEDULED, now);
        int claimed = 0;
        int claimSkipped = 0;
        int dispatchRejected = 0;
        for (ScheduledTask task : due) {
            Instant claimedFireAt = task.getNextFireAt();
            int updated = scheduledTaskRepository.claimToFiring(task.getId(), claimedFireAt);
            if (updated == 0) {
                // CAS 失败 = 行被并发路径（API postpone/cancel/另一扫描）改动，放弃本次认领。
                claimSkipped++;
                logger.debug("[LIFECYCLE] service=cp event=scheduled_task_claim_skipped taskId={} "
                        + "nextFireAt={}", task.getId(), claimedFireAt);
                continue;
            }
            claimed++;
            if (!submitDispatch(task)) {
                dispatchRejected++;
            }
        }
        long firingOverlap = scheduledTaskRepository.countByStatusAndNextFireAtBefore(
                ScheduledTask.STATUS_FIRING, now);
        logger.info("[LIFECYCLE] service=cp event=scheduled_task_scan_completed expired={} overdue={} "
                + "firing_timeout={} due={} claimed={} claim_skipped={} dispatch_rejected={} "
                + "firing_overlap={}", expired, overdue, firingTimeouts, due.size(), claimed,
                claimSkipped, dispatchRejected, firingOverlap);
    }

    /** 认领成功后提交异步分派；true=已提交，false=executor 拒绝（行已按 missed 收口）。 */
    boolean submitDispatch(ScheduledTask task) {
        try {
            CompletableFuture
                    .supplyAsync(() -> dispatcher.dispatch(task), dispatchExecutor)
                    .orTimeout(dispatchTimeoutMs, TimeUnit.MILLISECONDS)
                    .whenComplete((outcome, error) -> handleDispatchCompletion(task, outcome, error));
            return true;
        } catch (RejectedExecutionException e) {
            logger.warn("[LIFECYCLE] service=cp event=scheduled_task_dispatch_rejected taskId={} "
                    + "targetKind={} reason=executor_queue_full_or_shutdown", task.getId(),
                    task.getTargetKind(), e);
            markMissedDispatchFailed(task, e);
            return false;
        }
    }

    private void handleDispatchCompletion(ScheduledTask task,
                                          ScheduledTaskDispatcher.DispatchOutcome outcome,
                                          Throwable error) {
        if (error == null) {
            logger.debug("[LIFECYCLE] service=cp event=scheduled_task_dispatch_settled taskId={} outcome={}",
                    task.getId(), outcome == null ? null : outcome.outcome());
            // 任一 settle（DISPATCHED 成功→scheduled/completed，或 MISSED→missed）都是状态变化，
            // 粗粒度失效事件统一通知 UI refetch（成功回写同样需推送，否则 completed 不实时）。
            workspaceEventManager.publishScheduledTasksChanged(task.getWorkspaceId().toString());
            return;
        }
        Throwable cause = error instanceof CompletionException && error.getCause() != null
                ? error.getCause() : error;
        if (cause instanceof TimeoutException) {
            logger.warn("[LIFECYCLE] service=cp event=scheduled_task_dispatch_timeout taskId={} "
                    + "targetKind={} timeoutMs={}", task.getId(), task.getTargetKind(), dispatchTimeoutMs);
        } else {
            logger.error("[LIFECYCLE] service=cp event=scheduled_task_dispatch_error taskId={} "
                    + "targetKind={} failureType={}", task.getId(), task.getTargetKind(),
                    cause.getClass().getSimpleName(), cause);
        }
        markMissedDispatchFailed(task, cause);
    }

    private void markMissedDispatchFailed(ScheduledTask task, Throwable cause) {
        int updated = scheduledTaskRepository.markMissed(task.getId(),
                List.of(ScheduledTask.STATUS_FIRING), ScheduledTask.REASON_DISPATCH_FAILED, Instant.now());
        if (updated == 0) {
            logger.debug("[LIFECYCLE] service=cp event=scheduled_task_missed_settle_lost taskId={} "
                    + "failureType={}", task.getId(), cause.getClass().getSimpleName());
            return;
        }
        workspaceEventManager.publishScheduledTasksChanged(task.getWorkspaceId().toString());
    }
}
