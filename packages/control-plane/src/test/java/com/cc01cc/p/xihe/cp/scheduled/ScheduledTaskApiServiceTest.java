package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0489 T1.4：API 服务层——create 校验矩阵（cron/时区/TTL/配额）、处置状态机
 * （409/state 分流/remove 幂等/postpone 校验）、权限（0486 #9/#10）与 audit 落点。
 */
class ScheduledTaskApiServiceTest {

    private static final String WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
    private static final String USER_ID = "22222222-2222-4222-8222-222222222222";
    private static final String OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
    private static final String SESSION_ID = "44444444-4444-4444-8444-444444444444";
    private static final String PRINCIPAL_ID = "55555555-5555-4555-8555-555555555555";

    private ScheduledTaskRepository repository;
    private ScheduledTaskDispatcher dispatcher;
    private WorkspaceService workspaceService;
    private SessionService sessionService;
    private GrantIntersectionEvaluator evaluator;
    private AuthorizationGrantRepository grantRepository;
    private AgentPrincipalRepository agentPrincipalRepository;
    private WorkspaceAgentRepository workspaceAgentRepository;
    private UserRepository userRepository;
    private AuditLogger auditLogger;
    private WorkspaceEventManager eventManager;
    private ScheduledTaskApiService service;

    @BeforeEach
    void setUp() {
        repository = Mockito.mock(ScheduledTaskRepository.class);
        dispatcher = Mockito.mock(ScheduledTaskDispatcher.class);
        workspaceService = Mockito.mock(WorkspaceService.class);
        sessionService = Mockito.mock(SessionService.class);
        evaluator = Mockito.mock(GrantIntersectionEvaluator.class);
        grantRepository = Mockito.mock(AuthorizationGrantRepository.class);
        agentPrincipalRepository = Mockito.mock(AgentPrincipalRepository.class);
        workspaceAgentRepository = Mockito.mock(WorkspaceAgentRepository.class);
        userRepository = Mockito.mock(UserRepository.class);
        auditLogger = Mockito.mock(AuditLogger.class);
        eventManager = Mockito.mock(WorkspaceEventManager.class);
        service = new ScheduledTaskApiService(repository, dispatcher, workspaceService, sessionService,
                evaluator, grantRepository, agentPrincipalRepository, workspaceAgentRepository,
                userRepository, auditLogger, eventManager);
        when(repository.countByWorkspaceIdAndStatusIn(any(), anyCollection())).thenReturn(0L);
        when(repository.countByWorkspaceIdAndUserIdAndStatusIn(any(), any(), anyCollection()))
                .thenReturn(0L);
        when(evaluator.union(anyCollection())).thenReturn(Set.of());
        when(userRepository.findById(any())).thenReturn(Optional.of(user()));
    }

    // ── create 校验矩阵 ────────────────────────────────────────────────────

    @Test
    void create_rejects_invalid_cron_expression_with_400() {
        allowAll();
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, cronRequest("not-a-cron", "UTC")));
        assertEquals(org.springframework.http.HttpStatus.BAD_REQUEST, error.getStatus());
        assertEquals("INVALID_CRON_EXPR", error.getCode());
        verify(repository, never()).save(any());
    }

    @Test
    void create_rejects_cron_without_five_fields() {
        allowAll();
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, cronRequest("*/5 * * *", "UTC")));
        assertEquals("INVALID_CRON_EXPR", error.getCode());
    }

    @Test
    void create_rejects_invalid_timezone_with_400() {
        allowAll();
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, cronRequest("* * * * *", "Not/AZone")));
        assertEquals("INVALID_TIMEZONE", error.getCode());
        assertEquals(org.springframework.http.HttpStatus.BAD_REQUEST, error.getStatus());
    }

    @Test
    void create_rejects_delay_schedule_beyond_ttl() {
        allowAll();
        Instant tooLate = Instant.now().plus(8, ChronoUnit.DAYS);
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, delayRequest(tooLate)));
        assertEquals(org.springframework.http.HttpStatus.BAD_REQUEST, error.getStatus());
        assertEquals("INVALID_REQUEST", error.getCode());
    }

    @Test
    void create_rejects_delay_schedule_in_the_past() {
        allowAll();
        Instant past = Instant.now().minus(1, ChronoUnit.HOURS);
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, delayRequest(past)));
        assertEquals(org.springframework.http.HttpStatus.BAD_REQUEST, error.getStatus());
    }

    @Test
    void create_conflicts_at_workspace_limit() {
        allowAll();
        when(repository.countByWorkspaceIdAndStatusIn(any(), anyCollection()))
                .thenReturn((long) ScheduledTaskApiService.WORKSPACE_LIMIT);
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, cronRequest("* * * * *", "UTC")));
        assertEquals(org.springframework.http.HttpStatus.CONFLICT, error.getStatus());
        assertEquals("SCHEDULED_TASK_LIMIT", error.getCode());
    }

    @Test
    void create_conflicts_at_principal_limit() {
        allowAll();
        when(repository.countByWorkspaceIdAndUserIdAndStatusIn(any(), any(), anyCollection()))
                .thenReturn((long) ScheduledTaskApiService.PRINCIPAL_LIMIT);
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, cronRequest("* * * * *", "UTC")));
        assertEquals("SCHEDULED_TASK_PRINCIPAL_LIMIT", error.getCode());
    }

    // ── create 权限与 agent 边界 ───────────────────────────────────────────

    @Test
    void create_forbids_without_create_scheduled_task_grant() {
        when(evaluator.allows(any(PolicyRequest.class), any())).thenReturn(false);
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, cronRequest("* * * * *", "UTC")));
        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, error.getStatus());
        verify(repository, never()).save(any());
    }

    @Test
    void create_with_grant_persists_delay_task_and_audits_creator() {
        allowAll();
        when(repository.save(any())).thenAnswer(invocation -> {
            ScheduledTask task = invocation.getArgument(0);
            task.setId(UUID.randomUUID());
            return task;
        });

        ScheduledTaskApiService.TaskView view = service.create(
                WORKSPACE_ID, USER_ID, delayRequest(Instant.now().plus(2, ChronoUnit.HOURS)));

        assertEquals(ScheduledTask.STATUS_SCHEDULED, view.status());
        assertEquals(ScheduledTask.TRIGGER_DELAY_ONCE, view.triggerKind());
        assertNotNull(view.expiresAt(), "delay_once carries expires_at = created_at + 7d TTL");
        assertNull(view.cronExpr(), "delay_once never carries a cron expression");
        ArgumentCaptor<ScheduledTask> saved = ArgumentCaptor.forClass(ScheduledTask.class);
        verify(repository).save(saved.capture());
        assertEquals(UUID.fromString(WORKSPACE_ID), saved.getValue().getWorkspaceId());
        assertEquals(UUID.fromString(USER_ID), saved.getValue().getUserId());
        assertNull(saved.getValue().getAgentPrincipalId(),
                "human creation must leave the V60 creator column NULL");
        verify(auditLogger).recordDurableChange(eq(USER_ID), eq(WORKSPACE_ID),
                eq("scheduled_task_created"), eq("scheduled_task"), anyString(), contains("actorType=human"));
        verify(eventManager).publishScheduledTasksChanged(WORKSPACE_ID);
    }

    @Test
    void create_rejection_does_not_publish_workspace_event() {
        allowAll();
        when(repository.countByWorkspaceIdAndStatusIn(any(), anyCollection())).thenReturn(50L);

        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, delayRequest(Instant.now().plus(2, ChronoUnit.HOURS))));
        assertEquals("SCHEDULED_TASK_LIMIT", error.getCode());
        verify(eventManager, never()).publishScheduledTasksChanged(anyString());
    }

    @Test
    void create_agent_requires_workspace_binding() {
        allowAll();
        stubPrincipal(false);
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, agentCronRequest()));
        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, error.getStatus());
        verify(repository, never()).save(any());
    }

    @Test
    void create_agent_forbids_wakeup_of_foreign_principal_session() {
        allowAll();
        stubPrincipal(true);
        when(sessionService.requireCurrent(eq(SESSION_ID), eq(USER_ID), eq(WORKSPACE_ID)))
                .thenReturn(sessionBoundTo("99999999-9999-4999-8999-999999999999"));

        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, agentCronRequest()));
        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, error.getStatus());
    }

    @Test
    void create_agent_wakeup_of_own_session_succeeds_and_audits_creator() {
        allowAll();
        stubPrincipal(true);
        when(sessionService.requireCurrent(eq(SESSION_ID), eq(USER_ID), eq(WORKSPACE_ID)))
                .thenReturn(sessionBoundTo(PRINCIPAL_ID));
        when(repository.save(any())).thenAnswer(invocation -> {
            ScheduledTask task = invocation.getArgument(0);
            task.setId(UUID.randomUUID());
            return task;
        });

        ScheduledTaskApiService.TaskView view = service.create(WORKSPACE_ID, USER_ID, agentCronRequest());

        assertEquals(ScheduledTask.STATUS_SCHEDULED, view.status());
        ArgumentCaptor<ScheduledTask> saved = ArgumentCaptor.forClass(ScheduledTask.class);
        verify(repository).save(saved.capture());
        assertEquals(UUID.fromString(PRINCIPAL_ID), saved.getValue().getAgentPrincipalId(),
                "agent creation must persist the V60 creator principal column");
        verify(auditLogger).recordDurableChange(eq(USER_ID), eq(WORKSPACE_ID),
                eq("scheduled_task_created"), eq("scheduled_task"), anyString(),
                contains("agentPrincipalId=" + PRINCIPAL_ID));
    }

    // ── 处置权（0486 #10） ─────────────────────────────────────────────────

    @Test
    void creator_disposes_own_task_without_manage_grant() {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_MISSED, UUID.fromString(USER_ID));
        when(repository.findById(task.getId())).thenReturn(Optional.of(task),
                Optional.of(cancelled(task)));
        when(repository.markCancelled(eq(task.getId()), anyCollection(), anyString())).thenReturn(1);

        ScheduledTaskApiService.DisposeResult result = service.remove(
                WORKSPACE_ID, USER_ID, task.getId().toString(), null);

        assertTrue(result.changed());
        verify(evaluator, never()).allows(any(), any());
        verify(eventManager).publishScheduledTasksChanged(WORKSPACE_ID);
    }

    @Test
    void non_creator_without_manage_grant_is_forbidden() {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_MISSED, UUID.fromString(OTHER_USER_ID));
        when(repository.findById(task.getId())).thenReturn(Optional.of(task));
        when(evaluator.allows(any(PolicyRequest.class), any())).thenReturn(false);

        CpApiException error = assertThrows(CpApiException.class, () -> service.remove(
                WORKSPACE_ID, USER_ID, task.getId().toString(), null));
        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, error.getStatus());
        verify(repository, never()).markCancelled(any(), anyCollection(), anyString());
        verify(eventManager, never()).publishScheduledTasksChanged(anyString());
    }

    @Test
    void non_creator_with_manage_grant_disposes_and_audits_actor() {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_MISSED, UUID.fromString(OTHER_USER_ID));
        when(repository.findById(task.getId())).thenReturn(Optional.of(task),
                Optional.of(cancelled(task)));
        allowAll();
        stubPrincipal(true);
        when(repository.markCancelled(eq(task.getId()), anyCollection(), anyString())).thenReturn(1);

        ScheduledTaskApiService.DisposeResult result = service.remove(
                WORKSPACE_ID, USER_ID, task.getId().toString(), PRINCIPAL_ID);

        assertTrue(result.changed());
        verify(auditLogger).recordDurableChange(eq(USER_ID), eq(WORKSPACE_ID),
                eq("scheduled_task_removed"), eq("scheduled_task"), anyString(),
                contains("agentPrincipalId=" + PRINCIPAL_ID));
    }

    // ── 处置状态机 ─────────────────────────────────────────────────────────

    @Test
    void rerun_conflicts_on_completed_task() {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_COMPLETED, UUID.fromString(USER_ID));
        when(repository.findById(task.getId())).thenReturn(Optional.of(task));

        CpApiException error = assertThrows(CpApiException.class, () -> service.rerun(
                WORKSPACE_ID, USER_ID, task.getId().toString(), null));
        assertEquals(org.springframework.http.HttpStatus.CONFLICT, error.getStatus());
        assertEquals("SCHEDULED_TASK_STATE", error.getCode());
    }

    @Test
    void rerun_claims_missed_task_and_dispatches_with_retry_key() {
        ScheduledTask missed = scheduledTask(ScheduledTask.STATUS_MISSED, UUID.fromString(USER_ID));
        ScheduledTask firing = scheduledTask(ScheduledTask.STATUS_FIRING, UUID.fromString(USER_ID));
        firing.setId(missed.getId());
        ScheduledTask completed = scheduledTask(ScheduledTask.STATUS_COMPLETED, UUID.fromString(USER_ID));
        completed.setId(missed.getId());
        when(repository.findById(missed.getId())).thenReturn(Optional.of(missed),
                Optional.of(firing), Optional.of(completed));
        when(repository.claimForRerun(eq(missed.getId()), anyCollection())).thenReturn(1);

        ScheduledTaskApiService.TaskView view = service.rerun(
                WORKSPACE_ID, USER_ID, missed.getId().toString(), null);

        assertEquals(ScheduledTask.STATUS_COMPLETED, view.status());
        ArgumentCaptor<String> retryKey = ArgumentCaptor.forClass(String.class);
        verify(dispatcher).dispatchRerun(any(ScheduledTask.class), retryKey.capture());
        assertTrue(retryKey.getValue().startsWith("sched:" + missed.getId() + ":"),
                "retry key must be sched:{task_id}:{fire_at_ms}:retry:{uuid}");
        assertTrue(retryKey.getValue().contains(":retry:"), "rerun uses the dedicated retry key");
        verify(eventManager).publishScheduledTasksChanged(WORKSPACE_ID);
    }

    @Test
    void remove_is_idempotent_for_cancelled_task() {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_CANCELLED, UUID.fromString(USER_ID));
        when(repository.findById(task.getId())).thenReturn(Optional.of(task));

        ScheduledTaskApiService.DisposeResult result = service.remove(
                WORKSPACE_ID, USER_ID, task.getId().toString(), null);

        assertFalse(result.changed());
        assertEquals(ScheduledTask.STATUS_CANCELLED, result.status());
        verify(repository, never()).markCancelled(any(), anyCollection(), anyString());
        verify(eventManager, never()).publishScheduledTasksChanged(anyString());
    }

    @Test
    void delete_cancels_scheduled_task() {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_SCHEDULED, UUID.fromString(USER_ID));
        ScheduledTask cancelled = cancelled(task);
        when(repository.findById(task.getId())).thenReturn(Optional.of(task),
                Optional.of(cancelled));
        when(repository.markCancelled(eq(task.getId()), anyCollection(), anyString())).thenReturn(1);

        ScheduledTaskApiService.DisposeResult result = service.delete(
                WORKSPACE_ID, USER_ID, task.getId().toString(), null);

        assertTrue(result.changed());
        assertEquals(ScheduledTask.STATUS_CANCELLED, result.status());
        verify(repository).markCancelled(eq(task.getId()), any(), eq("user_delete"));
        verify(eventManager).publishScheduledTasksChanged(WORKSPACE_ID);
    }

    @Test
    void delete_on_missed_conflicts_directing_to_remove() {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_MISSED, UUID.fromString(USER_ID));
        when(repository.findById(task.getId())).thenReturn(Optional.of(task));

        CpApiException error = assertThrows(CpApiException.class, () -> service.delete(
                WORKSPACE_ID, USER_ID, task.getId().toString(), null));
        assertEquals("SCHEDULED_TASK_STATE", error.getCode());
        assertTrue(error.getMessage().contains("/remove"),
                "DELETE on missed must point the caller at the remove disposition");
    }

    @Test
    void postpone_rejects_non_future_instant() {
        CpApiException error = assertThrows(CpApiException.class, () -> service.postpone(
                WORKSPACE_ID, USER_ID, UUID.randomUUID().toString(),
                Instant.now().minus(1, ChronoUnit.MINUTES).toString(), null));
        assertEquals(org.springframework.http.HttpStatus.BAD_REQUEST, error.getStatus());
    }

    @Test
    void postpone_rejects_delay_beyond_expires_at() {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_MISSED, UUID.fromString(USER_ID));
        task.setTriggerKind(ScheduledTask.TRIGGER_DELAY_ONCE);
        task.setExpiresAt(Instant.now().plus(2, ChronoUnit.DAYS));
        when(repository.findById(task.getId())).thenReturn(Optional.of(task));

        CpApiException error = assertThrows(CpApiException.class, () -> service.postpone(
                WORKSPACE_ID, USER_ID, task.getId().toString(),
                Instant.now().plus(3, ChronoUnit.DAYS).toString(), null));
        assertEquals(org.springframework.http.HttpStatus.BAD_REQUEST, error.getStatus());
    }

    @Test
    void postpone_missed_resets_next_fire_and_clears_missed_state() {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_MISSED, UUID.fromString(USER_ID));
        ScheduledTask postponed = scheduledTask(ScheduledTask.STATUS_SCHEDULED, UUID.fromString(USER_ID));
        postponed.setId(task.getId());
        postponed.setMissedCount(0);
        when(repository.findById(task.getId())).thenReturn(Optional.of(task),
                Optional.of(postponed));
        Instant at = Instant.now().plus(3, ChronoUnit.HOURS);
        when(repository.postponeToScheduled(eq(task.getId()), anyCollection(), eq(at))).thenReturn(1);

        ScheduledTaskApiService.TaskView view = service.postpone(
                WORKSPACE_ID, USER_ID, task.getId().toString(), at.toString(), null);

        assertEquals(ScheduledTask.STATUS_SCHEDULED, view.status());
        assertEquals(0, view.missedCount());
        verify(repository).postponeToScheduled(eq(task.getId()), any(), eq(at));
        verify(eventManager).publishScheduledTasksChanged(WORKSPACE_ID);
    }

    @Test
    void unknown_task_collapses_to_404() {
        UUID missing = UUID.randomUUID();
        when(repository.findById(missing)).thenReturn(Optional.empty());

        CpApiException error = assertThrows(CpApiException.class, () -> service.detail(
                WORKSPACE_ID, USER_ID, missing.toString()));
        assertEquals(org.springframework.http.HttpStatus.NOT_FOUND, error.getStatus());
        assertEquals("SCHEDULED_TASK_NOT_FOUND", error.getCode());
    }

    // ── 读 DTO ────────────────────────────────────────────────────────────

    @Test
    void list_truncates_prompt_while_detail_keeps_full_text() {
        String longPrompt = "p".repeat(300);
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_SCHEDULED, UUID.fromString(USER_ID));
        task.setPrompt(longPrompt);
        when(repository.findById(task.getId())).thenReturn(Optional.of(task));
        when(repository.findByWorkspaceIdOrderByCreatedAtDesc(any(), any()))
                .thenReturn(java.util.List.of(task));

        ScheduledTaskApiService.ListPage page = service.list(WORKSPACE_ID, USER_ID, 0, 20);
        ScheduledTaskApiService.TaskView detail = service.detail(WORKSPACE_ID, USER_ID,
                task.getId().toString());

        assertEquals(ScheduledTaskApiService.LIST_PROMPT_MAX, page.tasks().get(0).prompt().length());
        assertEquals(longPrompt, detail.prompt());
        assertEquals(17, ScheduledTaskApiService.TaskView.class.getRecordComponents().length,
                "read DTO is the frozen 17-field contract");
        assertEquals("human", detail.createdBy().type());
    }

    @Test
    void view_serializes_camel_case_without_snake_case_fields() throws Exception {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_SCHEDULED, UUID.fromString(USER_ID));
        when(repository.findById(task.getId())).thenReturn(Optional.of(task));

        ScheduledTaskApiService.TaskView view = service.detail(WORKSPACE_ID, USER_ID,
                task.getId().toString());
        Map<?, ?> wire = new ObjectMapper().convertValue(view, Map.class);

        assertTrue(wire.keySet().containsAll(java.util.List.of(
                "id", "triggerKind", "cronExpr", "timezone", "targetKind", "targetSessionId",
                "prompt", "status", "nextFireAt", "expiresAt", "missedCount", "lastMissedAt",
                "missedReason", "lastRunId", "createdBy", "createdAt", "updatedAt")));
        for (Object key : wire.keySet()) {
            assertFalse(key.toString().contains("_"), "wire must not echo snake_case: " + key);
        }
    }

    @Test
    void agent_created_task_projects_created_by_agent_with_principal_name() {
        stubPrincipal(true);
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_SCHEDULED, UUID.fromString(USER_ID));
        task.setAgentPrincipalId(UUID.fromString(PRINCIPAL_ID));
        when(repository.findById(task.getId())).thenReturn(Optional.of(task));

        ScheduledTaskApiService.TaskView view = service.detail(WORKSPACE_ID, USER_ID,
                task.getId().toString());

        assertEquals("agent", view.createdBy().type(),
                "V60 creator column non-null must project type=agent");
        assertEquals("agent-principal", view.createdBy().name(),
                "agent createdBy name must come from agent_principals.name");
    }

    @Test
    void created_by_degrades_to_human_when_agent_principal_column_is_nulled() {
        // FK ON DELETE SET NULL clears the column after the principal row is deleted;
        // the projection then falls back to the human owner (spec §1 V60 degrade).
        ScheduledTask nulledColumn = scheduledTask(ScheduledTask.STATUS_SCHEDULED,
                UUID.fromString(USER_ID));
        when(repository.findById(nulledColumn.getId())).thenReturn(Optional.of(nulledColumn));
        ScheduledTaskApiService.TaskView afterDelete = service.detail(WORKSPACE_ID, USER_ID,
                nulledColumn.getId().toString());
        assertEquals("human", afterDelete.createdBy().type());
        assertEquals("User One", afterDelete.createdBy().name());

        // Defensive branch: column still set but the principal row is gone → degrade, not 500.
        ScheduledTask missingPrincipal = scheduledTask(ScheduledTask.STATUS_SCHEDULED,
                UUID.fromString(USER_ID));
        missingPrincipal.setAgentPrincipalId(UUID.randomUUID());
        when(repository.findById(missingPrincipal.getId())).thenReturn(Optional.of(missingPrincipal));
        ScheduledTaskApiService.TaskView degraded = service.detail(WORKSPACE_ID, USER_ID,
                missingPrincipal.getId().toString());
        assertEquals("human", degraded.createdBy().type());
        assertEquals("User One", degraded.createdBy().name());
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private void allowAll() {
        when(evaluator.allows(any(PolicyRequest.class), any())).thenReturn(true);
    }

    private void stubPrincipal(boolean bound) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(UUID.fromString(PRINCIPAL_ID));
        principal.setName("agent-principal");
        when(agentPrincipalRepository.findById(UUID.fromString(PRINCIPAL_ID)))
                .thenReturn(Optional.of(principal));
        when(workspaceAgentRepository.findById(new WorkspaceAgentId(PRINCIPAL_ID, WORKSPACE_ID)))
                .thenReturn(bound ? Optional.of(new WorkspaceAgent(PRINCIPAL_ID, WORKSPACE_ID, null))
                        : Optional.empty());
    }

    private static Session sessionBoundTo(String principalId) {
        Session session = new Session();
        session.setAgentPrincipalId(principalId);
        return session;
    }

    private static User user() {
        User user = new User("user@example.com", "hash", UserRole.USER, "User One");
        user.setId(UUID.fromString(USER_ID));
        return user;
    }

    private static ScheduledTask scheduledTask(String status, UUID owner) {
        ScheduledTask task = new ScheduledTask();
        task.setId(UUID.randomUUID());
        task.setWorkspaceId(UUID.fromString(WORKSPACE_ID));
        task.setUserId(owner);
        task.setTriggerKind(ScheduledTask.TRIGGER_CRON);
        task.setCronExpr("*/5 * * * *");
        task.setTimezone("UTC");
        task.setTargetKind(ScheduledTask.TARGET_SESSION_WAKEUP);
        task.setTargetSessionId(UUID.fromString(SESSION_ID));
        task.setPrompt("scheduled prompt");
        task.setStatus(status);
        task.setNextFireAt(Instant.now().plus(1, ChronoUnit.HOURS));
        task.setMissedCount(ScheduledTask.STATUS_MISSED.equals(status) ? 1 : 0);
        return task;
    }

    private static ScheduledTask cancelled(ScheduledTask source) {
        ScheduledTask copy = scheduledTask(ScheduledTask.STATUS_CANCELLED, source.getUserId());
        copy.setId(source.getId());
        return copy;
    }

    private static ScheduledTaskApiService.CreateRequest cronRequest(String cronExpr, String timezone) {
        return new ScheduledTaskApiService.CreateRequest("cron", cronExpr, timezone,
                "session_wakeup", SESSION_ID, "wake up", null, null, null);
    }

    private static ScheduledTaskApiService.CreateRequest agentCronRequest() {
        return new ScheduledTaskApiService.CreateRequest("cron", "* * * * *", "UTC",
                "session_wakeup", SESSION_ID, "wake up", null, null, PRINCIPAL_ID);
    }

    private static ScheduledTaskApiService.CreateRequest delayRequest(Instant at) {
        return new ScheduledTaskApiService.CreateRequest("delay_once", null, "UTC",
                "session_wakeup", SESSION_ID, "wake up", null, at.toString(), null);
    }
}
