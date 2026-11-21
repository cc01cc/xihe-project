package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGrantExpander;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGrantSource;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGrants;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.WorkspaceMembershipService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
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
import java.util.List;
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
    private SessionParticipantRepository sessionParticipantRepository;
    private AuditLogger auditLogger;
    private WorkspaceEventManager eventManager;
    private WorkspaceMembershipService membershipService;
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
        sessionParticipantRepository = Mockito.mock(SessionParticipantRepository.class);
        membershipService = Mockito.mock(WorkspaceMembershipService.class);
        service = new ScheduledTaskApiService(repository, dispatcher, workspaceService, sessionService,
                evaluator, grantRepository, agentPrincipalRepository, workspaceAgentRepository,
                userRepository, auditLogger, eventManager, sessionParticipantRepository,
                com.cc01cc.p.xihe.cp.policy.OrgUnitGrantsTestFixture.withoutRows(),
                new ScheduledTaskContracts(), cursorCodec(), membershipService);
        when(repository.countByWorkspaceIdAndStatusIn(any(), anyCollection())).thenReturn(0L);
        when(repository.countByWorkspaceIdAndUserIdAndStatusIn(any(), any(), anyCollection()))
                .thenReturn(0L);
        // task-163: the quota now reads origin-aware counts; both sets are stubbed so a test that
        // forgets one gets 0 (empty) rather than a Mockito null-unboxing failure.
        when(repository.countByWorkspaceIdAndStatusInAndOrigin(any(), anyCollection(), anyString()))
                .thenReturn(0L);
        when(repository.countByWorkspaceIdAndUserIdAndStatusInAndOrigin(
                any(), any(), anyCollection(), anyString())).thenReturn(0L);
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

    /**
     * 校验层判据：Spring 原生 6 段（带秒字段）在 API 面必须 400，与解析层
     * {@code CronExpressionsTest#rejects_six_field_cron_instead_of_passing_it_through} 同一口径
     * （task-96，用户 18:56 裁案 5）。
     */
    @Test
    void create_rejects_six_field_cron_with_400() {
        allowAll();
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, cronRequest("0 30 9 * * *", "UTC")));
        assertEquals(org.springframework.http.HttpStatus.BAD_REQUEST, error.getStatus());
        assertEquals("INVALID_CRON_EXPR", error.getCode());
        assertTrue(error.getMessage().contains("5 fields"),
                "message must name the 5-field rule: " + error.getMessage());
        verify(repository, never()).save(any());
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
        when(repository.countByWorkspaceIdAndStatusInAndOrigin(any(), anyCollection(), anyString()))
                .thenReturn((long) ScheduledTaskApiService.WORKSPACE_LIMIT);
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, cronRequest("* * * * *", "UTC")));
        assertEquals(org.springframework.http.HttpStatus.CONFLICT, error.getStatus());
        assertEquals("SCHEDULED_TASK_LIMIT", error.getCode());
    }

    @Test
    void create_conflicts_at_principal_limit() {
        allowAll();
        when(repository.countByWorkspaceIdAndUserIdAndStatusInAndOrigin(
                any(), any(), anyCollection(), anyString()))
                .thenReturn((long) ScheduledTaskApiService.PRINCIPAL_LIMIT);
        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, cronRequest("* * * * *", "UTC")));
        assertEquals("SCHEDULED_TASK_PRINCIPAL_LIMIT", error.getCode());
    }

    /**
     * `M2-8b` gate 3 (`ScheduledTaskApiService`): this gate reads the subject's org-unit grants too —
     * and, because the whitelist is applied inside the expansion, **they can never widen it**.
     *
     * <p>Both halves are asserted, because a wiring that silently widens an unrelated gate would
     * be a privilege leak nobody asked for:</p>
     * <ol>
     *   <li>an org-unit binding carrying {@code CREATE_SCHEDULED_TASK} (non-governance) is
     *       <b>dropped</b> before the decision ⇒ still {@code 403}. This is the filter doing its
     *       job at a gate whose own atom is not a governance atom;</li>
     *   <li>an org-unit binding carrying a <i>governance</i> atom ({@code MANAGE_ORG_UNITS}) is kept
     *       but still doesn't satisfy this gate ⇒ {@code 403} — the expansion adds authority only
     *       where that atom is what is being asked for.</li>
     * </ol>
     *
     * <p>Uses a real {@link GrantIntersectionEvaluator} on purpose: with a stubbed {@code allows}
     * this test would prove nothing about what reached the decision.</p>
     */
    @Test
    void create_isNotWidenedByOrgUnitGrants() {
        when(repository.save(any())).thenAnswer(invocation -> {
            ScheduledTask task = invocation.getArgument(0);
            task.setId(UUID.randomUUID());
            return task;
        });

        for (String atom : List.of(ToolFaceRegistry.ACTION_CREATE_SCHEDULED_TASK,
                ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS)) {
            ScheduledTaskApiService withOrgUnits = serviceWithOrgUnitGrant(atom);
            CpApiException refused = assertThrows(CpApiException.class, () -> withOrgUnits.create(
                    WORKSPACE_ID, USER_ID, delayRequest(Instant.now().plus(2, ChronoUnit.HOURS))),
                    "org-unit grants must not authorize this gate with atom " + atom);
            assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, refused.getStatus());
            verify(repository, never()).save(any());
        }
    }

    /** A service whose org-unit source grants one governance-or-not atom to the human actor. */
    /** task-163: a real codec over a throwaway key — the wiring, not the crypto, is under test here. */
    static ScheduledTaskCursorCodec cursorCodec() {
        return new ScheduledTaskCursorCodec(
                "test-scheduled-task-cursor-secret", new tools.jackson.databind.ObjectMapper());
    }

    private ScheduledTaskApiService serviceWithOrgUnitGrant(String atom) {
        UUID unit = UUID.fromString("00000000-0000-4000-8000-0000000000a0");
        UUID role = UUID.fromString("22222222-2222-4222-8222-222222222221");
        var permissions = new com.fasterxml.jackson.databind.ObjectMapper().createArrayNode();
        permissions.addObject().put("actionClass", atom).put("resource", "*");
        OrgUnitGrantSource source = member -> new OrgUnitGrantExpander.Rows(
                List.of(new OrgUnitGrantExpander.UnitRow(unit, "root")),
                List.of(new OrgUnitGrantExpander.MembershipRow(
                        OrgUnitGrantExpander.MEMBER_HUMAN, UUID.fromString(USER_ID), unit)),
                List.of(new OrgUnitGrantExpander.RoleBindingRow(unit, role, "ORG_ROLE",
                        List.of(atom), permissions)));
        return new ScheduledTaskApiService(repository, dispatcher, workspaceService, sessionService,
                new GrantIntersectionEvaluator(), grantRepository, agentPrincipalRepository,
                workspaceAgentRepository, userRepository, auditLogger, eventManager,
                sessionParticipantRepository,
                new OrgUnitGrants(new OrgUnitGrantExpander(), source), new ScheduledTaskContracts(),
                cursorCodec(), membershipService);
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
        when(repository.countByWorkspaceIdAndStatusInAndOrigin(any(), anyCollection(), anyString()))
                .thenReturn(50L);

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
        // PLAN-0689 A2c: the gate reads the target Session's PRIMARY participant principal.
        when(sessionParticipantRepository.primaryPrincipalId(any()))
                .thenReturn(Optional.of(UUID.fromString("99999999-9999-4999-8999-999999999999")));

        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, agentCronRequest()));
        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, error.getStatus());
    }

    @Test
    void create_agent_forbids_wakeup_when_target_session_has_no_primary_participant() {
        allowAll();
        stubPrincipal(true);
        // The sessions column still names the creator, but the PRIMARY roster row is missing: the
        // gate must reject (fail-closed) instead of falling back to the column.
        when(sessionService.requireCurrent(eq(SESSION_ID), eq(USER_ID), eq(WORKSPACE_ID)))
                .thenReturn(sessionBoundTo(PRINCIPAL_ID));
        when(sessionParticipantRepository.primaryPrincipalId(any())).thenReturn(Optional.empty());

        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, agentCronRequest()));
        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, error.getStatus());
        verify(repository, never()).save(any());
    }

    @Test
    void create_agent_wakeup_of_own_session_succeeds_and_audits_creator() {
        allowAll();
        stubPrincipal(true);
        when(sessionService.requireCurrent(eq(SESSION_ID), eq(USER_ID), eq(WORKSPACE_ID)))
                .thenReturn(sessionBoundTo(PRINCIPAL_ID));
        when(sessionParticipantRepository.primaryPrincipalId(any()))
                .thenReturn(Optional.of(UUID.fromString(PRINCIPAL_ID)));
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
        when(repository.findByWorkspaceIdAndOriginOrderByCreatedAtDescIdDesc(any(), any(), any()))
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


    // ── task-163 聚合读面 / 会话读面 ──────────────────────────────────────

    /**
     * The aggregate face's visible set is exactly the subject's workspace bindings: a row of a
     * workspace the caller is not bound to cannot appear, however many rows the repository would
     * return. The mock here would happily hand back rows of both workspaces, so only the query
     * argument proves the filter — and the query is asked for exactly the bound id.
     */
    @Test
    void aggregate_visible_set_is_the_callers_workspace_bindings_only() {
        UUID mine = UUID.fromString(WORKSPACE_ID);
        UUID foreign = UUID.fromString("77777777-7777-4777-8777-777777777777");
        when(membershipService.workspaceRolesOf(UUID.fromString(USER_ID)))
                .thenReturn(List.of(new WorkspaceMembershipService.WorkspaceRoleRef(
                        mine, com.cc01cc.p.xihe.cp.entity.WorkspaceRole.MEMBER)));
        when(repository.findByWorkspaceIdInAndOriginOrderByCreatedAtDescIdDesc(any(), any(), any()))
                .thenReturn(List.of(taskIn(mine, ScheduledTask.ORIGIN_USER)));

        ScheduledTaskApiService.AggregatePage page = service.listAggregated(USER_ID, 20, null);

        ArgumentCaptor<java.util.Collection<UUID>> ids =
                ArgumentCaptor.forClass(java.util.Collection.class);
        ArgumentCaptor<String> origin = ArgumentCaptor.forClass(String.class);
        verify(repository).findByWorkspaceIdInAndOriginOrderByCreatedAtDescIdDesc(
                ids.capture(), origin.capture(), any());
        assertEquals(List.of(mine), List.copyOf(ids.getValue()),
                "the aggregate face must query exactly the caller's bindings");
        assertFalse(ids.getValue().contains(foreign), "an unbound workspace must never be queried");
        assertEquals(ScheduledTask.ORIGIN_USER, origin.getValue(),
                "the automation tab lists user-created rows only (V94:13-14)");
        assertEquals(1, page.tasks().size());
        assertEquals(WORKSPACE_ID, page.tasks().get(0).workspaceId());
    }

    /** A caller with no workspace binding gets an empty page, not a widened read and not a 500. */
    @Test
    void aggregate_without_any_binding_is_an_empty_page() {
        when(membershipService.workspaceRolesOf(UUID.fromString(USER_ID))).thenReturn(List.of());

        ScheduledTaskApiService.AggregatePage page = service.listAggregated(USER_ID, 20, null);

        assertTrue(page.tasks().isEmpty());
        assertFalse(page.hasMore());
        assertNull(page.nextCursor());
        verify(repository, never()).findByWorkspaceIdInAndOriginOrderByCreatedAtDescIdDesc(
                any(), any(), any());
    }

    /**
     * task-163 卡面判据⑤: the automation faces summarise a prompt to 80 characters. The 17-field DTO
     * is unchanged (same record, different cap), so a client sees one contract with a narrower list
     * projection — the workspace list keeps its own 120.
     */
    @Test
    void aggregate_summarises_prompt_to_eighty_characters() {
        UUID mine = UUID.fromString(WORKSPACE_ID);
        String longPrompt = "p".repeat(300);
        ScheduledTask row = taskIn(mine, ScheduledTask.ORIGIN_USER);
        row.setPrompt(longPrompt);
        when(membershipService.workspaceRolesOf(UUID.fromString(USER_ID)))
                .thenReturn(List.of(new WorkspaceMembershipService.WorkspaceRoleRef(
                        mine, com.cc01cc.p.xihe.cp.entity.WorkspaceRole.MEMBER)));
        when(repository.findByWorkspaceIdInAndOriginOrderByCreatedAtDescIdDesc(any(), any(), any()))
                .thenReturn(List.of(row));

        ScheduledTaskApiService.AggregatePage page = service.listAggregated(USER_ID, 20, null);

        assertEquals(ScheduledTaskApiService.PROMPT_SUMMARY_MAX,
                page.tasks().get(0).task().prompt().length());
        assertEquals(17, ScheduledTaskApiService.TaskView.class.getRecordComponents().length,
                "the read DTO stays the frozen 17-field contract");
    }

    /**
     * task-163 判据③: the session face matches {@code target_session_id} in BOTH origins — that is
     * where a system participant-wake projection belongs. The gate is the session read gate, so a
     * caller who may not read the session never reaches the query.
     */
    @Test
    void session_face_includes_both_origins_and_gates_on_the_read_guard() {
        UUID sessionId = UUID.fromString(SESSION_ID);
        ScheduledTask projection = taskIn(UUID.fromString(WORKSPACE_ID), ScheduledTask.ORIGIN_SYSTEM);
        projection.setTargetSessionId(sessionId);
        when(sessionService.requireReadable(SESSION_ID, USER_ID, WORKSPACE_ID))
                .thenReturn(sessionBoundTo(SESSION_ID));
        when(repository.findByTargetSessionIdOrderByCreatedAtDescIdDesc(any(), any()))
                .thenReturn(List.of(projection));

        ScheduledTaskApiService.SessionPage page =
                service.listBySession(SESSION_ID, USER_ID, WORKSPACE_ID, 20, null);

        assertEquals(1, page.tasks().size());
        assertEquals(ScheduledTask.ORIGIN_SYSTEM, page.tasks().get(0).origin(),
                "the session face must not filter the system projection away");
        assertEquals(SESSION_ID, page.sessionId());
    }

    /** A caller the session read gate refuses never sees a page (404, not an empty list). */
    @Test
    void session_face_propagates_the_read_gate_404() {
        when(sessionService.requireReadable(SESSION_ID, OTHER_USER_ID, WORKSPACE_ID))
                .thenThrow(new CpApiException(org.springframework.http.HttpStatus.NOT_FOUND,
                        "SESSION_NOT_FOUND", "session not found"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.listBySession(SESSION_ID, OTHER_USER_ID, WORKSPACE_ID, 20, null));

        assertEquals("SESSION_NOT_FOUND", error.getCode());
        verify(repository, never()).findByTargetSessionIdOrderByCreatedAtDescIdDesc(any(), any());
    }

    /**
     * Keyset wiring: {@code size + 1} rows are asked for, the page cuts back to {@code size}, and the
     * cursor it returns is one this endpoint accepts on the second call — i.e. the round trip through
     * the codec works and the position is the last row of page one.
     */
    @Test
    void aggregate_paginates_with_a_cursor_the_same_endpoint_accepts() {
        UUID mine = UUID.fromString(WORKSPACE_ID);
        List<ScheduledTask> rows = List.of(taskAt(mine, 3), taskAt(mine, 2), taskAt(mine, 1));
        when(membershipService.workspaceRolesOf(UUID.fromString(USER_ID)))
                .thenReturn(List.of(new WorkspaceMembershipService.WorkspaceRoleRef(
                        mine, com.cc01cc.p.xihe.cp.entity.WorkspaceRole.MEMBER)));
        when(repository.findByWorkspaceIdInAndOriginOrderByCreatedAtDescIdDesc(any(), any(), any()))
                .thenReturn(rows);

        ScheduledTaskApiService.AggregatePage first = service.listAggregated(USER_ID, 2, null);

        assertTrue(first.hasMore());
        assertEquals(2, first.tasks().size());
        assertNotNull(first.nextCursor());

        when(repository.findWorkspacesPageBefore(any(), any(), any(), any(), any()))
                .thenReturn(List.of(rows.get(2)));
        ScheduledTaskApiService.AggregatePage second =
                service.listAggregated(USER_ID, 2, first.nextCursor());

        assertEquals(1, second.tasks().size());
        assertFalse(second.hasMore());
        ArgumentCaptor<UUID> lastId = ArgumentCaptor.forClass(UUID.class);
        verify(repository).findWorkspacesPageBefore(any(), any(), any(), lastId.capture(), any());
        assertEquals(rows.get(1).getId(), lastId.getValue(),
                "the second page must resume strictly after the last row of the first");
    }

    /**
     * A cursor is scoped: one issued by the aggregate face must not be replayable against the session
     * face (different authorization question, so a crossed cursor would silently widen the read set).
     */
    @Test
    void cursor_from_the_other_face_is_rejected_with_invalid_cursor() {
        UUID mine = UUID.fromString(WORKSPACE_ID);
        List<ScheduledTask> rows = List.of(taskAt(mine, 2), taskAt(mine, 1));
        when(membershipService.workspaceRolesOf(UUID.fromString(USER_ID)))
                .thenReturn(List.of(new WorkspaceMembershipService.WorkspaceRoleRef(
                        mine, com.cc01cc.p.xihe.cp.entity.WorkspaceRole.MEMBER)));
        when(repository.findByWorkspaceIdInAndOriginOrderByCreatedAtDescIdDesc(any(), any(), any()))
                .thenReturn(rows);
        String aggregateCursor = service.listAggregated(USER_ID, 1, null).nextCursor();

        when(sessionService.requireReadable(SESSION_ID, USER_ID, WORKSPACE_ID))
                .thenReturn(sessionBoundTo(SESSION_ID));
        CpApiException error = assertThrows(CpApiException.class, () -> service.listBySession(
                SESSION_ID, USER_ID, WORKSPACE_ID, 20, aggregateCursor));

        assertEquals(org.springframework.http.HttpStatus.BAD_REQUEST, error.getStatus());
        assertEquals("INVALID_CURSOR", error.getCode());
        verify(repository, never()).findTargetSessionPageBefore(any(), any(), any(), any());
    }

    /** A tampered cursor is refused before any query runs. */
    @Test
    void tampered_cursor_is_rejected_before_querying() {
        UUID mine = UUID.fromString(WORKSPACE_ID);
        when(membershipService.workspaceRolesOf(UUID.fromString(USER_ID)))
                .thenReturn(List.of(new WorkspaceMembershipService.WorkspaceRoleRef(
                        mine, com.cc01cc.p.xihe.cp.entity.WorkspaceRole.MEMBER)));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.listAggregated(USER_ID, 20, "not-a-cursor"));

        assertEquals("INVALID_CURSOR", error.getCode());
        verify(repository, never()).findByWorkspaceIdInAndOriginOrderByCreatedAtDescIdDesc(
                any(), any(), any());
    }

    /**
     * task-163 判据④ (Lead 加码): the quota must count only rows a principal CREATED. A system
     * projection row is not the caller's, so it cannot push the workspace over its limit — but the
     * user-origin count still does, which is the other half of the same assertion.
     */
    @Test
    void quota_counts_user_origin_rows_only() {
        allowAll();
        when(repository.countByWorkspaceIdAndStatusInAndOrigin(any(), anyCollection(), anyString()))
                .thenReturn(0L);
        when(repository.countByWorkspaceIdAndUserIdAndStatusInAndOrigin(
                any(), any(), anyCollection(), anyString())).thenReturn(0L);
        when(repository.save(any())).thenAnswer(invocation -> {
            ScheduledTask task = invocation.getArgument(0);
            task.setId(UUID.randomUUID());
            return task;
        });

        service.create(WORKSPACE_ID, USER_ID, delayRequest(Instant.now().plus(1, ChronoUnit.HOURS)));

        ArgumentCaptor<String> origin = ArgumentCaptor.forClass(String.class);
        verify(repository).countByWorkspaceIdAndStatusInAndOrigin(any(), anyCollection(),
                origin.capture());
        assertEquals(ScheduledTask.ORIGIN_USER, origin.getValue(),
                "a system projection must not consume a user quota slot");
    }

    /** The workspace limit still bites on user-origin rows (positive half of the same predicate). */
    @Test
    void workspace_quota_still_rejects_at_the_limit_for_user_rows() {
        allowAll();
        when(repository.countByWorkspaceIdAndStatusInAndOrigin(any(), anyCollection(), eq(ScheduledTask.ORIGIN_USER)))
                .thenReturn((long) ScheduledTaskApiService.WORKSPACE_LIMIT);

        CpApiException error = assertThrows(CpApiException.class, () -> service.create(
                WORKSPACE_ID, USER_ID, cronRequest("* * * * *", "UTC")));

        assertEquals("SCHEDULED_TASK_LIMIT", error.getCode());
        verify(repository, never()).save(any());
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private void allowAll() {
        when(evaluator.allows(any(PolicyRequest.class), any())).thenReturn(true);
    }

    private void stubPrincipal(boolean bound) {
        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setId(UUID.fromString(PRINCIPAL_ID));
        principal.setName("agent-principal");
        when(agentPrincipalRepository.findById(UUID.fromString(PRINCIPAL_ID)))
                .thenReturn(Optional.of(principal));
        when(workspaceAgentRepository.findById(new WorkspaceAgentId(PRINCIPAL_ID, WORKSPACE_ID)))
                .thenReturn(bound ? Optional.of(new WorkspaceAgent(PRINCIPAL_ID, WORKSPACE_ID, null))
                        : Optional.empty());
    }

    /** task-163: a row of a given workspace/origin; every read-face test is about those two facts. */
    private static ScheduledTask taskIn(UUID workspaceId, String origin) {
        ScheduledTask task = scheduledTask(ScheduledTask.STATUS_SCHEDULED, UUID.fromString(USER_ID));
        task.setWorkspaceId(workspaceId);
        task.setOrigin(origin);
        return task;
    }

    /**
     * task-163 keyset: a row created {@code secondsAgo} in the past. {@code created_at} is written by
     * {@code @PrePersist} and has no setter, so the fixture sets the field the same way the persistence
     * provider would (ReflectionTestUtils is the established pattern in this test tree).
     */
    private static ScheduledTask taskAt(UUID workspaceId, int secondsAgo) {
        ScheduledTask task = taskIn(workspaceId, ScheduledTask.ORIGIN_USER);
        org.springframework.test.util.ReflectionTestUtils.setField(task, "createdAt",
                Instant.now().minusSeconds(secondsAgo));
        return task;
    }

    /** A session the read gate admits, carrying the id the face binds its cursor to. */
    private static Session sessionBoundTo(String sessionId) {
        Session session = new Session();
        session.setId(UUID.fromString(sessionId));
        return session;
    }

    private static User user() {
        User user = new User("user@example.com", "hash", "User One");
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
                "session_wakeup", SESSION_ID, "wake up", null, null, null, null);
    }

    private static ScheduledTaskApiService.CreateRequest agentCronRequest() {
        return new ScheduledTaskApiService.CreateRequest("cron", "* * * * *", "UTC",
                "session_wakeup", SESSION_ID, "wake up", null, null, PRINCIPAL_ID, null);
    }

    private static ScheduledTaskApiService.CreateRequest delayRequest(Instant at) {
        return new ScheduledTaskApiService.CreateRequest("delay_once", null, "UTC",
                "session_wakeup", SESSION_ID, "wake up", null, at.toString(), null, null);
    }
}
