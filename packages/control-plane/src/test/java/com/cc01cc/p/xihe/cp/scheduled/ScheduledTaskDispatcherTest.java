package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.chat.SessionWakeupService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.operation.WorkspaceJobStartService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0489 T1.3：分派器四语义与 job 幂等语义（mock 依赖）——
 * session_wakeup 成功/顺延/target_gone/失败，job_dispatch 成功/replay/失败。
 */
class ScheduledTaskDispatcherTest {

    private static final Instant FIRE_AT = Instant.parse("2026-10-11T08:00:00Z");

    private ScheduledTaskRepository repository;
    private SessionWakeupService sessionWakeupService;
    private WorkspaceJobStartService workspaceJobStartService;
    private WorkspaceService workspaceService;
    private ScheduledTaskDispatcher dispatcher;

    @BeforeEach
    void setUp() {
        repository = Mockito.mock(ScheduledTaskRepository.class);
        sessionWakeupService = Mockito.mock(SessionWakeupService.class);
        workspaceJobStartService = Mockito.mock(WorkspaceJobStartService.class);
        workspaceService = Mockito.mock(WorkspaceService.class);
        dispatcher = new ScheduledTaskDispatcher(
                repository, sessionWakeupService, workspaceJobStartService, workspaceService);
        when(repository.markMissed(any(), anyCollection(), anyString(), any())).thenReturn(1);
        when(repository.rescheduleCronFromFiring(any(), any())).thenReturn(1);
        when(repository.rescheduleCronFromFiringWithRun(any(), any(), any())).thenReturn(1);
        when(repository.completeFromFiring(any())).thenReturn(1);
        when(repository.completeFromFiringWithRun(any(), any())).thenReturn(1);
    }

    private static ScheduledTask task(String triggerKind, String targetKind) {
        ScheduledTask task = new ScheduledTask();
        task.setId(UUID.randomUUID());
        task.setWorkspaceId(UUID.randomUUID());
        task.setUserId(UUID.randomUUID());
        task.setTriggerKind(triggerKind);
        task.setTargetKind(targetKind);
        task.setTimezone("UTC");
        task.setStatus(ScheduledTask.STATUS_FIRING);
        task.setNextFireAt(FIRE_AT);
        if (ScheduledTask.TRIGGER_CRON.equals(triggerKind)) {
            task.setCronExpr("*/5 * * * *");
        } else {
            task.setExpiresAt(FIRE_AT.plusSeconds(3600));
        }
        if (ScheduledTask.TARGET_SESSION_WAKEUP.equals(targetKind)) {
            task.setTargetSessionId(UUID.randomUUID());
            task.setPrompt("scheduled prompt");
        }
        return task;
    }

    // ── session_wakeup ──────────────────────────────────────────────────────

    @Test
    void wakeup_started_on_cron_reschedules_next_fire_with_run_id() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_CRON, ScheduledTask.TARGET_SESSION_WAKEUP);
        UUID runId = UUID.randomUUID();
        when(sessionWakeupService.wakeup(anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenReturn(SessionWakeupService.WakeupResult.started(runId));
        Instant beforeDispatch = Instant.now();

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.DISPATCHED, outcome);
        ArgumentCaptor<Instant> next = ArgumentCaptor.forClass(Instant.class);
        verify(repository).rescheduleCronFromFiringWithRun(eq(task.getId()), next.capture(), eq(runId));
        assertTrue(next.getValue().isAfter(beforeDispatch),
                "cron next must be strictly after dispatch time");
        assertTrue(next.getValue().isAfter(FIRE_AT), "cron next must move past the fired occurrence");
        verify(repository, never()).markMissed(any(), anyCollection(), anyString(), any());
    }

    @Test
    void wakeup_started_on_delay_once_completes_with_run_id() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_DELAY_ONCE, ScheduledTask.TARGET_SESSION_WAKEUP);
        UUID runId = UUID.randomUUID();
        when(sessionWakeupService.wakeup(anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenReturn(SessionWakeupService.WakeupResult.started(runId));

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.DISPATCHED, outcome);
        verify(repository).completeFromFiringWithRun(task.getId(), runId);
    }

    @Test
    void wakeup_deferred_by_busy_session_reschedules_without_touching_run_id() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_CRON, ScheduledTask.TARGET_SESSION_WAKEUP);
        when(sessionWakeupService.wakeup(anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenReturn(SessionWakeupService.WakeupResult.deferred());

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.DEFERRED, outcome);
        verify(repository).rescheduleCronFromFiring(eq(task.getId()), any(Instant.class));
        verify(repository, never()).markMissed(any(), anyCollection(), anyString(), any());
    }

    @Test
    void wakeup_with_null_session_id_marks_missed_target_gone() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_DELAY_ONCE, ScheduledTask.TARGET_SESSION_WAKEUP);
        task.setTargetSessionId(null);

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.MISSED_TARGET_GONE, outcome);
        verify(repository).markMissed(eq(task.getId()),
                eq(List.of(ScheduledTask.STATUS_FIRING)),
                eq(ScheduledTask.REASON_TARGET_GONE), any(Instant.class));
        verify(sessionWakeupService, never()).wakeup(anyString(), anyString(), anyString(),
                anyString(), anyString());
    }

    @Test
    void wakeup_target_gone_exception_marks_missed_target_gone() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_DELAY_ONCE, ScheduledTask.TARGET_SESSION_WAKEUP);
        when(sessionWakeupService.wakeup(anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenThrow(new SessionWakeupService.TargetGoneException("gone", null));

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.MISSED_TARGET_GONE, outcome);
        verify(repository).markMissed(eq(task.getId()),
                eq(List.of(ScheduledTask.STATUS_FIRING)),
                eq(ScheduledTask.REASON_TARGET_GONE), any(Instant.class));
    }

    @Test
    void wakeup_start_unavailable_marks_missed_dispatch_failed() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_DELAY_ONCE, ScheduledTask.TARGET_SESSION_WAKEUP);
        when(sessionWakeupService.wakeup(anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenThrow(new SessionWakeupService.WakeupStartUnavailableException("pending decision"));

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.MISSED_DISPATCH_FAILED, outcome);
        verify(repository).markMissed(eq(task.getId()),
                eq(List.of(ScheduledTask.STATUS_FIRING)),
                eq(ScheduledTask.REASON_DISPATCH_FAILED), any(Instant.class));
    }

    @Test
    void wakeup_conflict_marks_missed_dispatch_failed() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_DELAY_ONCE, ScheduledTask.TARGET_SESSION_WAKEUP);
        when(sessionWakeupService.wakeup(anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenThrow(new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                        "FOLLOW_UP_QUEUE_FULL", "full"));

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.MISSED_DISPATCH_FAILED, outcome);
        verify(repository).markMissed(eq(task.getId()),
                eq(List.of(ScheduledTask.STATUS_FIRING)),
                eq(ScheduledTask.REASON_DISPATCH_FAILED), any(Instant.class));
    }

    @Test
    void cron_without_future_occurrence_marks_missed_dispatch_failed() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_CRON, ScheduledTask.TARGET_SESSION_WAKEUP);
        task.setCronExpr("0 0 30 2 *");
        when(sessionWakeupService.wakeup(anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenReturn(SessionWakeupService.WakeupResult.started(UUID.randomUUID()));

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.MISSED_DISPATCH_FAILED, outcome);
        verify(repository).markMissed(eq(task.getId()),
                eq(List.of(ScheduledTask.STATUS_FIRING)),
                eq(ScheduledTask.REASON_DISPATCH_FAILED), any(Instant.class));
        verify(repository, never()).rescheduleCronFromFiringWithRun(any(), any(), any());
    }

    // ── job_dispatch ────────────────────────────────────────────────────────

    @Test
    void job_dispatch_success_starts_with_scheduled_source_and_records_job_id() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_DELAY_ONCE, ScheduledTask.TARGET_JOB_DISPATCH);
        ObjectNode payload = JsonNodeFactory.instance.objectNode();
        payload.put("command", "echo");
        ArrayNode args = payload.putArray("args");
        args.add("hello");
        payload.put("cwd", "/tmp");
        payload.put("timeoutSecs", 42);
        task.setPayload(payload);
        UUID jobId = UUID.randomUUID();
        stubWorkspace("docker");
        when(workspaceJobStartService.start(anyString(), anyString(), any(),
                anyString(), anyString()))
                .thenReturn(new WorkspaceJobStartService.StartOutcome(Map.of("jobId", jobId.toString()), false));

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.DISPATCHED, outcome);
        ArgumentCaptor<WorkspaceJobStartService.StartRequest> request =
                ArgumentCaptor.forClass(WorkspaceJobStartService.StartRequest.class);
        ArgumentCaptor<String> key = ArgumentCaptor.forClass(String.class);
        verify(workspaceJobStartService).start(eq(task.getWorkspaceId().toString()),
                eq(task.getUserId().toString()), request.capture(), key.capture(), eq("docker"));
        assertEquals("echo", request.getValue().command());
        assertEquals(List.of("hello"), request.getValue().args());
        assertEquals("/tmp", request.getValue().cwd());
        assertEquals(Long.valueOf(42L), request.getValue().timeoutSecs());
        assertEquals(ScheduledTaskDispatcher.SCOPE_WORKSPACE, request.getValue().scope());
        assertEquals(ScheduledTaskDispatcher.SOURCE_SCHEDULED, request.getValue().source());
        assertNull(request.getValue().sessionId());
        assertNull(request.getValue().runId());
        assertNull(request.getValue().env(), "scheduled dispatch passes no env overrides");
        assertEquals("sched:" + task.getId() + ":" + FIRE_AT.toEpochMilli(), key.getValue());
        verify(repository).completeFromFiringWithRun(task.getId(), jobId);
        verify(repository, never()).markMissed(any(), anyCollection(), anyString(), any());
    }

    @Test
    void job_dispatch_replay_is_classified_already_executed_without_missed() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_CRON, ScheduledTask.TARGET_JOB_DISPATCH);
        task.setPayload(commandPayload());
        stubWorkspace("docker");
        when(workspaceJobStartService.start(anyString(), anyString(), any(),
                anyString(), anyString()))
                .thenReturn(new WorkspaceJobStartService.StartOutcome(Map.of("jobId", "existing"), true));

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.ALREADY_EXECUTED, outcome);
        verify(repository).rescheduleCronFromFiring(eq(task.getId()), any(Instant.class));
        verify(repository, never()).markMissed(any(), anyCollection(), anyString(), any());
    }

    @Test
    void job_dispatch_failure_marks_missed_dispatch_failed() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_DELAY_ONCE, ScheduledTask.TARGET_JOB_DISPATCH);
        task.setPayload(commandPayload());
        stubWorkspace("docker");
        when(workspaceJobStartService.start(anyString(), anyString(), any(),
                anyString(), anyString()))
                .thenThrow(new CpApiException(org.springframework.http.HttpStatus.BAD_GATEWAY,
                        "RUNTIME_UNAVAILABLE", "runtime down"));

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.MISSED_DISPATCH_FAILED, outcome);
        verify(repository).markMissed(eq(task.getId()),
                eq(List.of(ScheduledTask.STATUS_FIRING)),
                eq(ScheduledTask.REASON_DISPATCH_FAILED), any(Instant.class));
        verify(repository, never()).completeFromFiringWithRun(any(), any());
    }

    @Test
    void job_dispatch_without_payload_marks_missed_dispatch_failed() {
        ScheduledTask task = task(ScheduledTask.TRIGGER_DELAY_ONCE, ScheduledTask.TARGET_JOB_DISPATCH);

        ScheduledTaskDispatcher.DispatchOutcome outcome = dispatcher.dispatch(task);

        assertEquals(ScheduledTaskDispatcher.DispatchOutcome.MISSED_DISPATCH_FAILED, outcome);
        verify(workspaceJobStartService, never()).start(anyString(), anyString(), any(),
                anyString(), anyString());
    }

    @Test
    void idempotency_key_is_sched_task_fire_at_millis() {
        assertEquals("sched:11111111-1111-1111-1111-111111111111:" + FIRE_AT.toEpochMilli(),
                ScheduledTaskDispatcher.idempotencyKey(
                        UUID.fromString("11111111-1111-1111-1111-111111111111"), FIRE_AT));
    }

    private void stubWorkspace(String executionMode) {
        Workspace workspace = new Workspace();
        workspace.setExecutionMode(executionMode);
        when(workspaceService.requireAccessibleWorkspace(anyString(), anyString())).thenReturn(workspace);
    }

    private static ObjectNode commandPayload() {
        ObjectNode payload = JsonNodeFactory.instance.objectNode();
        payload.put("command", "echo");
        payload.putArray("args");
        return payload;
    }
}
