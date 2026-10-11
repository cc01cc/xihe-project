package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.chat.SessionWakeupService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.operation.WorkspaceJobStartService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0489 T1.3（contract: PLAN-0486 spec/scheduled-task.md v3.3 §4）：
 * firing 占位行的分派编排——扫描线程只负责认领，本服务在独立 executor 线程
 * 上执行分派动作并以 CAS 回写结果（调度器另以 dispatch-timeout 兜底）。
 *
 * <p>session_wakeup：target_gone（session_id NULL/404）→ missed(target_gone)；
 * busy → 复用 follow-up 队列顺延（不计 missed）；成功/顺延 → cron 重算
 * next_fire_at 回 scheduled、delay_once → completed（带 last_run_id 仅当产生了
 * 新载体）；内部错误 → missed(dispatch_failed)。</p>
 *
 * <p>job_dispatch：payload JSONB → {@link WorkspaceJobStartService}（source='scheduled'、
 * scope='workspace'、幂等键 {@code sched:{task_id}:{fire_at_ms}}、fire_at=认领时的
 * next_fire_at 毫秒、prompt 不传）；成功 → 转移 + last_run_id；replay（同键同
 * hash 返回旧 job）→ 归类该 occurrence 已执行（不标 missed、不再分派）；
 * 异常 → missed(dispatch_failed)。</p>
 */
@Service
public class ScheduledTaskDispatcher {

    public static final String SOURCE_SCHEDULED = "scheduled";
    public static final String SCOPE_WORKSPACE = "workspace";
    public static final String DEFAULT_EXECUTION_MODE = "docker";

    private static final Logger logger = LoggerFactory.getLogger(ScheduledTaskDispatcher.class);

    private final ScheduledTaskRepository scheduledTaskRepository;
    private final SessionWakeupService sessionWakeupService;
    private final WorkspaceJobStartService workspaceJobStartService;
    private final WorkspaceService workspaceService;

    public ScheduledTaskDispatcher(ScheduledTaskRepository scheduledTaskRepository,
                                   SessionWakeupService sessionWakeupService,
                                   WorkspaceJobStartService workspaceJobStartService,
                                   WorkspaceService workspaceService) {
        this.scheduledTaskRepository = scheduledTaskRepository;
        this.sessionWakeupService = sessionWakeupService;
        this.workspaceJobStartService = workspaceJobStartService;
        this.workspaceService = workspaceService;
    }

    /** 分派结果（日志/单测断言用）。 */
    public record DispatchOutcome(String outcome) {
        public static final DispatchOutcome DISPATCHED = new DispatchOutcome("dispatched");
        public static final DispatchOutcome DEFERRED = new DispatchOutcome("deferred");
        public static final DispatchOutcome ALREADY_EXECUTED = new DispatchOutcome("already_executed");
        public static final DispatchOutcome MISSED_TARGET_GONE = new DispatchOutcome("missed_target_gone");
        public static final DispatchOutcome MISSED_DISPATCH_FAILED = new DispatchOutcome("missed_dispatch_failed");
    }

    /**
     * 分派一个已被扫描 CAS 认领（status=firing）的任务行。传入实体的
     * {@code nextFireAt} 即认领时读到的 occurrence（幂等键的 fire_at 来源）。
     */
    public DispatchOutcome dispatch(ScheduledTask task) {
        try {
            return switch (task.getTargetKind()) {
                case ScheduledTask.TARGET_SESSION_WAKEUP -> dispatchSessionWakeup(task);
                case ScheduledTask.TARGET_JOB_DISPATCH -> dispatchJob(task);
                default -> settleMissed(task, ScheduledTask.REASON_DISPATCH_FAILED,
                        "unknown target kind: " + task.getTargetKind());
            };
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=scheduled_task_dispatch_failed taskId={} "
                    + "targetKind={} failureType={}", task.getId(), task.getTargetKind(),
                    e.getClass().getSimpleName(), e);
            return settleMissed(task, ScheduledTask.REASON_DISPATCH_FAILED,
                    "dispatch raised " + e.getClass().getSimpleName());
        }
    }

    /** 幂等键 = sched:{task_id}:{fire_at_ms}（0486 §4；fire_at=认领时的 next_fire_at 毫秒）。 */
    public static String idempotencyKey(UUID taskId, Instant fireAt) {
        return "sched:" + taskId + ":" + fireAt.toEpochMilli();
    }

    private DispatchOutcome dispatchSessionWakeup(ScheduledTask task) {
        if (task.getTargetSessionId() == null) {
            return settleMissed(task, ScheduledTask.REASON_TARGET_GONE,
                    "target session was hard-deleted (session_id NULL)");
        }
        SessionWakeupService.WakeupResult result;
        try {
            result = sessionWakeupService.wakeup(
                    task.getTargetSessionId().toString(),
                    task.getUserId().toString(),
                    task.getWorkspaceId().toString(),
                    task.getPrompt(),
                    idempotencyKey(task.getId(), task.getNextFireAt()));
        } catch (SessionWakeupService.TargetGoneException e) {
            logger.warn("[LIFECYCLE] service=cp event=scheduled_task_wakeup_target_gone "
                    + "taskId={} sessionId={}", task.getId(), task.getTargetSessionId());
            return settleMissed(task, ScheduledTask.REASON_TARGET_GONE, "target session is gone");
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=scheduled_task_wakeup_failed taskId={} "
                    + "sessionId={} failureType={}", task.getId(), task.getTargetSessionId(),
                    e.getClass().getSimpleName(), e);
            return settleMissed(task, ScheduledTask.REASON_DISPATCH_FAILED,
                    "wakeup raised " + e.getClass().getSimpleName());
        }
        if (result.started()) {
            logger.info("[LIFECYCLE] service=cp event=scheduled_task_wakeup_dispatched taskId={} "
                    + "sessionId={} runId={}", task.getId(), task.getTargetSessionId(), result.runId());
            return settleExecuted(task, result.runId(), DispatchOutcome.DEFERRED);
        }
        return settleExecuted(task, null, DispatchOutcome.DEFERRED);
    }

    private DispatchOutcome dispatchJob(ScheduledTask task) {
        JsonNode payload = task.getPayload();
        if (payload == null || !payload.isObject()) {
            return settleMissed(task, ScheduledTask.REASON_DISPATCH_FAILED,
                    "job_dispatch payload is missing");
        }
        WorkspaceJobStartService.StartRequest request = new WorkspaceJobStartService.StartRequest(
                textOrNull(payload, "command"),
                stringList(payload.get("args")),
                textOrNull(payload, "cwd"),
                longOrNull(payload, "timeoutSecs"),
                SCOPE_WORKSPACE,
                null,
                null,
                SOURCE_SCHEDULED,
                null);
        WorkspaceJobStartService.StartOutcome outcome;
        try {
            Workspace workspace = workspaceService.requireAccessibleWorkspace(
                    task.getWorkspaceId().toString(), task.getUserId().toString());
            String executionMode = workspace.getExecutionMode() == null || workspace.getExecutionMode().isBlank()
                    ? DEFAULT_EXECUTION_MODE : workspace.getExecutionMode();
            outcome = workspaceJobStartService.start(
                    task.getWorkspaceId().toString(),
                    task.getUserId().toString(),
                    request,
                    idempotencyKey(task.getId(), task.getNextFireAt()),
                    executionMode);
        } catch (CpApiException e) {
            logger.error("[LIFECYCLE] service=cp event=scheduled_task_job_dispatch_failed taskId={} "
                    + "code={}", task.getId(), e.getCode(), e);
            return settleMissed(task, ScheduledTask.REASON_DISPATCH_FAILED,
                    "job start rejected: " + e.getCode());
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=scheduled_task_job_dispatch_failed taskId={} "
                    + "failureType={}", task.getId(), e.getClass().getSimpleName(), e);
            return settleMissed(task, ScheduledTask.REASON_DISPATCH_FAILED,
                    "job start raised " + e.getClass().getSimpleName());
        }
        if (outcome.replayed()) {
            // 同键同 hash 返回旧 job → 该 occurrence 已执行：不标 missed、不再分派。
            logger.info("[LIFECYCLE] service=cp event=scheduled_task_job_replayed taskId={} jobId={}",
                    task.getId(), outcome.job().get("jobId"));
            return settleExecuted(task, null, DispatchOutcome.ALREADY_EXECUTED);
        }
        Object jobId = outcome.job().get("jobId");
        logger.info("[LIFECYCLE] service=cp event=scheduled_task_job_dispatched taskId={} jobId={}",
                task.getId(), jobId);
        UUID domainJobId;
        try {
            domainJobId = UUID.fromString(String.valueOf(jobId));
        } catch (IllegalArgumentException e) {
            logger.error("[LIFECYCLE] service=cp event=scheduled_task_job_dispatch_result_invalid "
                    + "taskId={} jobId={}", task.getId(), jobId, e);
            return settleMissed(task, ScheduledTask.REASON_DISPATCH_FAILED,
                    "dispatched job has no UUID domain id");
        }
        return settleExecuted(task, domainJobId, DispatchOutcome.ALREADY_EXECUTED);
    }

    /**
     * 成功/顺延/replay：cron 重算 next 回 scheduled，delay_once → completed。
     * 无新载体时返回 {@code noRunOutcome}（wakeup 顺延=deferred；job replay=已执行）。
     */
    private DispatchOutcome settleExecuted(ScheduledTask task, UUID runId, DispatchOutcome noRunOutcome) {
        if (ScheduledTask.TRIGGER_CRON.equals(task.getTriggerKind())) {
            Instant next = CronExpressions.nextUtcInstant(
                    task.getCronExpr(), task.getTimezone(), Instant.now());
            if (next == null) {
                logger.error("[LIFECYCLE] service=cp event=scheduled_task_cron_exhausted taskId={} "
                        + "cronExpr={}", task.getId(), task.getCronExpr());
                return settleMissed(task, ScheduledTask.REASON_DISPATCH_FAILED,
                        "cron expression has no future occurrence");
            }
            int updated = runId == null
                    ? scheduledTaskRepository.rescheduleCronFromFiring(task.getId(), next)
                    : scheduledTaskRepository.rescheduleCronFromFiringWithRun(task.getId(), next, runId);
            if (updated == 0) {
                logger.warn("[LIFECYCLE] service=cp event=scheduled_task_settle_lost taskId={} "
                        + "target=scheduled reason=not_firing", task.getId());
                return DispatchOutcome.ALREADY_EXECUTED;
            }
            return runId == null ? noRunOutcome : DispatchOutcome.DISPATCHED;
        }
        int updated = runId == null
                ? scheduledTaskRepository.completeFromFiring(task.getId())
                : scheduledTaskRepository.completeFromFiringWithRun(task.getId(), runId);
        if (updated == 0) {
            logger.warn("[LIFECYCLE] service=cp event=scheduled_task_settle_lost taskId={} "
                    + "target=completed reason=not_firing", task.getId());
            return DispatchOutcome.ALREADY_EXECUTED;
        }
        return runId == null ? noRunOutcome : DispatchOutcome.DISPATCHED;
    }

    /** firing→missed CAS；返回 0 = 行已被并发路径（如超时兜底）收口，仅日志留痕。 */
    private DispatchOutcome settleMissed(ScheduledTask task, String reason, String detail) {
        int updated = scheduledTaskRepository.markMissed(
                task.getId(), List.of(ScheduledTask.STATUS_FIRING), reason, Instant.now());
        if (updated == 0) {
            logger.warn("[LIFECYCLE] service=cp event=scheduled_task_settle_lost taskId={} "
                    + "target=missed reason={} detail={}", task.getId(), reason, detail);
        }
        return ScheduledTask.REASON_TARGET_GONE.equals(reason)
                ? DispatchOutcome.MISSED_TARGET_GONE : DispatchOutcome.MISSED_DISPATCH_FAILED;
    }

    private static String textOrNull(JsonNode payload, String field) {
        JsonNode value = payload.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }

    private static Long longOrNull(JsonNode payload, String field) {
        JsonNode value = payload.get(field);
        return value == null || value.isNull() ? null : value.asLong();
    }

    private static List<String> stringList(JsonNode argsNode) {
        if (argsNode == null || !argsNode.isArray()) {
            return List.of();
        }
        List<String> args = new ArrayList<>();
        argsNode.forEach(arg -> args.add(arg.asText()));
        return args;
    }
}
