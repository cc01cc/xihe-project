package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.scheduled.ScheduledTask;
import com.cc01cc.p.xihe.cp.scheduled.ScheduledTaskRepository;
import com.cc01cc.p.xihe.cp.scheduled.WakeScheduleProjectionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * BL-448 / PLAN-0716: the participant -> SCHEDULE projection wiring.
 *
 * <p>The defect was structural: {@code WakeScheduleProjectionService.syncParticipant} had zero
 * callers, so a participant configured with {@code wakePolicy=SCHEDULE} never produced a
 * {@code scheduled_tasks} projection row. These tests pin three things:</p>
 * <ol>
 *   <li>call sites (add / update(role|policy|config|disabled) / remove) invoke the projection service;</li>
 *   <li>the real projection service writes/updates/cancels the dispatch row from participant state;</li>
 *   <li>repeated sync is idempotent (exactly one row per participant; interval changes update the same row).</li>
 * </ol>
 */
class SessionParticipantWakeProjectionWiringTest {

    private static final String WORKSPACE = UUID.randomUUID().toString();
    private static final String OWNER = UUID.randomUUID().toString();
    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID HUMAN_ID = UUID.randomUUID();

    private SessionParticipantRepository participants;
    private SessionParticipantCursorRepository cursors;
    private SessionRepository sessions;
    private UserRepository users;
    private WorkspaceService workspaces;
    private Session session;
    private final AtomicReference<SessionParticipant> saved = new AtomicReference<>();

    @BeforeEach
    void setUp() {
        participants = mock(SessionParticipantRepository.class);
        cursors = mock(SessionParticipantCursorRepository.class);
        sessions = mock(SessionRepository.class);
        users = mock(UserRepository.class);
        workspaces = mock(WorkspaceService.class);
        session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getWorkspaceId()).thenReturn(WORKSPACE);
        when(session.getUserId()).thenReturn(OWNER);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));
        when(users.existsById(HUMAN_ID)).thenReturn(true);
        when(participants.maxOrderIndex(any())).thenReturn(0);
        when(participants.save(any(SessionParticipant.class))).thenAnswer(call -> {
            SessionParticipant row = call.getArgument(0);
            if (row.getId() == null) {
                row.setId(UUID.randomUUID());
            }
            saved.set(row);
            return row;
        });
    }

    private SessionParticipantService serviceWith(WakeScheduleProjectionService projection) {
        GrantAuthorizationService grants = mock(GrantAuthorizationService.class);
        SessionReadAccess access = new SessionReadAccess(sessions, participants, workspaces, grants);
        return new SessionParticipantService(participants, cursors, sessions,
                mock(AgentPrincipalRepository.class), users, workspaces, grants, projection,
                mock(EventStoreRepository.class), access,
                new RequesterAuthority(mock(AuthorizationGrantRepository.class),
                        mock(GrantIntersectionEvaluator.class), mock(AuthzContext.class)));
    }

    private SessionParticipantService.AddRequest scheduleAdd() {
        return new SessionParticipantService.AddRequest("HUMAN", HUMAN_ID.toString(), "MEMBER",
                "SCHEDULE", "WHEN_MENTIONED",
                Map.of("intervalSeconds", 120, "jitterSeconds", 5, "maxConcurrent", 2), null);
    }

    @Test
    void addUpdateAndRemoveInvokeProjectionService() {
        WakeScheduleProjectionService projection = mock(WakeScheduleProjectionService.class);
        SessionParticipantService subject = serviceWith(projection);

        subject.add(OWNER, WORKSPACE, SESSION_ID.toString(), scheduleAdd());
        SessionParticipant row = saved.get();
        assertNotNull(row.getId());
        verify(projection).syncParticipant(row, session);

        when(participants.findByIdAndSessionId(any(), eq(SESSION_ID))).thenReturn(Optional.of(row));
        subject.update(OWNER, WORKSPACE, SESSION_ID.toString(), row.getId().toString(),
                new SessionParticipantService.UpdateRequest("GUARD", null, null, null, null, null));
        verify(projection, times(2)).syncParticipant(row, session);

        subject.remove(OWNER, WORKSPACE, SESSION_ID.toString(), row.getId().toString());
        verify(projection).cancelProjection(row);
    }

    @Test
    void projectionRefreshesAndIsIdempotent() {
        ScheduledTaskRepository tasks = mock(ScheduledTaskRepository.class);
        List<ScheduledTask> rows = new ArrayList<>();
        when(tasks.findByTargetKindAndOrigin(anyString(), anyString()))
                .thenAnswer(call -> new ArrayList<>(rows));
        when(tasks.save(any(ScheduledTask.class))).thenAnswer(call -> {
            ScheduledTask task = call.getArgument(0);
            if (!rows.contains(task)) {
                rows.add(task);
            }
            return task;
        });
        WakeScheduleProjectionService projection =
                new WakeScheduleProjectionService(tasks, new ObjectMapper());
        SessionParticipantService subject = serviceWith(projection);

        subject.add(OWNER, WORKSPACE, SESSION_ID.toString(), scheduleAdd());
        SessionParticipant row = saved.get();
        assertEquals(1, rows.size(), "SCHEDULE 参与者必须恰好生成一行投影");
        ScheduledTask task = rows.get(0);
        assertEquals(ScheduledTask.TARGET_PARTICIPANT_WAKE, task.getTargetKind());
        assertEquals(ScheduledTask.ORIGIN_SYSTEM, task.getOrigin());
        assertEquals(ScheduledTask.STATUS_SCHEDULED, task.getStatus());
        assertEquals(120, task.getIntervalSeconds());
        assertEquals(SESSION_ID, task.getTargetSessionId());
        assertEquals(row.getId().toString(), task.getPayload().path("participantId").asText());
        assertEquals(5, task.getPayload().path("jitterSeconds").asInt());
        assertEquals(2, task.getPayload().path("maxConcurrent").asInt());

        when(participants.findByIdAndSessionId(any(), eq(SESSION_ID))).thenReturn(Optional.of(row));
        // same config twice -> same row (idempotent)
        subject.update(OWNER, WORKSPACE, SESSION_ID.toString(), row.getId().toString(),
                new SessionParticipantService.UpdateRequest(null, null, null, null,
                        Map.of("intervalSeconds", 120, "jitterSeconds", 5, "maxConcurrent", 2), null));
        subject.update(OWNER, WORKSPACE, SESSION_ID.toString(), row.getId().toString(),
                new SessionParticipantService.UpdateRequest(null, null, null, null,
                        Map.of("intervalSeconds", 180), null));
        assertEquals(1, rows.size(), "update 不得新增第二行投影");
        assertEquals(180, rows.get(0).getIntervalSeconds(), "config 变更必须刷新投影");

        subject.update(OWNER, WORKSPACE, SESSION_ID.toString(), row.getId().toString(),
                new SessionParticipantService.UpdateRequest(null, null, null, true, null, null));
        assertEquals(ScheduledTask.STATUS_CANCELLED, rows.get(0).getStatus(),
                "disabled 后投影必须停止 firing");
    }

    @Test
    void nonScheduleAddDoesNotCreateProjection() {
        ScheduledTaskRepository tasks = mock(ScheduledTaskRepository.class);
        List<ScheduledTask> rows = new ArrayList<>();
        when(tasks.findByTargetKindAndOrigin(anyString(), anyString()))
                .thenAnswer(call -> new ArrayList<>(rows));
        when(tasks.save(any(ScheduledTask.class))).thenAnswer(call -> {
            ScheduledTask task = call.getArgument(0);
            rows.add(task);
            return task;
        });
        WakeScheduleProjectionService projection =
                new WakeScheduleProjectionService(tasks, new ObjectMapper());
        SessionParticipantService subject = serviceWith(projection);
        subject.add(OWNER, WORKSPACE, SESSION_ID.toString(),
                new SessionParticipantService.AddRequest("HUMAN", HUMAN_ID.toString(), "MEMBER",
                        "MENTION", "WHEN_MENTIONED", null, null));
        assertTrue(rows.isEmpty(), "非 SCHEDULE 不得生成 wake 投影");
        assertNull(saved.get().getDisabledAt());
    }
}
