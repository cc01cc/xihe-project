package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0624 task-74 (wire 补丁): wakeConfig is parsed, validated and persisted on add/update,
 * projected by the view, and cleared explicitly when the policy leaves SCHEDULE.
 */
class SessionParticipantWakeConfigTest {

    private static final String WORKSPACE = UUID.randomUUID().toString();
    private static final String OWNER = UUID.randomUUID().toString();
    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID HUMAN_ID = UUID.randomUUID();

    private SessionParticipantRepository participants;
    private SessionParticipantService service;

    @BeforeEach
    void setUp() {
        participants = mock(SessionParticipantRepository.class);
        SessionRepository sessions = mock(SessionRepository.class);
        Session session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getWorkspaceId()).thenReturn(WORKSPACE);
        when(session.getUserId()).thenReturn(OWNER);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));
        UserRepository users = mock(UserRepository.class);
        when(users.existsById(HUMAN_ID)).thenReturn(true);
        when(participants.save(any(SessionParticipant.class))).thenAnswer(call -> call.getArgument(0));
        com.cc01cc.p.xihe.cp.service.WorkspaceService workspaces = mock(com.cc01cc.p.xihe.cp.service.WorkspaceService.class);
        GrantAuthorizationService grants = mock(GrantAuthorizationService.class);
        SessionReadAccess access = new SessionReadAccess(sessions, participants, workspaces, grants);
        service = new SessionParticipantService(participants,
                mock(SessionParticipantCursorRepository.class), sessions,
                mock(AgentPrincipalRepository.class), users,
                workspaces, grants,
                mock(com.cc01cc.p.xihe.cp.scheduled.WakeScheduleProjectionService.class),
                mock(com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository.class), access,
                new com.cc01cc.p.xihe.cp.policy.RequesterAuthority(
                        mock(com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository.class),
                        mock(com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.class),
                        mock(com.cc01cc.p.xihe.cp.policy.AuthzContext.class),
                        com.cc01cc.p.xihe.cp.policy.OrgUnitGrantsTestFixture.withoutRows()));
    }

    private SessionParticipantService.AddRequest scheduleRequest(Map<String, Object> config) {
        return new SessionParticipantService.AddRequest("HUMAN", HUMAN_ID.toString(), "MEMBER",
                "SCHEDULE", "WHEN_MENTIONED", config, null);
    }

    @Test
    void scheduleWithoutConfigIsRejected() {
        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.add(OWNER, WORKSPACE, SESSION_ID.toString(), scheduleRequest(null)));
        assertEquals("PARTICIPANT_INVALID_WAKE_CONFIG", refused.getCode());
        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatus());
    }

    @Test
    void subMinuteIntervalIsRejected() {
        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.add(OWNER, WORKSPACE, SESSION_ID.toString(),
                        scheduleRequest(Map.of("intervalSeconds", 30))));
        assertEquals("PARTICIPANT_INVALID_WAKE_CONFIG", refused.getCode(),
                ">=60 aligns with the M2 scan tick and the V94 CHECK");
    }

    @Test
    void validSchedulePersistsConfigAndProjectsIt() {
        SessionParticipantService.ParticipantView view = service.add(OWNER, WORKSPACE,
                SESSION_ID.toString(),
                scheduleRequest(Map.of("intervalSeconds", 300, "jitterSeconds", 10,
                        "maxConcurrent", 2)));
        assertEquals("SCHEDULE", view.wakePolicy());
        assertEquals(300, view.wakeConfig().path("intervalSeconds").asInt(),
                "the view projects wakeConfig — the openapi contract is now real");
        assertEquals(2, view.wakeConfig().path("maxConcurrent").asInt());
    }

    @Test
    void configOnNonSchedulePolicyIsRejected() {
        SessionParticipantService.AddRequest bad = new SessionParticipantService.AddRequest(
                "HUMAN", HUMAN_ID.toString(), "MEMBER", "MENTION", "WHEN_MENTIONED",
                Map.of("intervalSeconds", 300), null);
        assertThrows(CpApiException.class,
                () -> service.add(OWNER, WORKSPACE, SESSION_ID.toString(), bad));
    }

    @Test
    void leavingScheduleClearsTheConfigExplicitly() {
        SessionParticipant row = new SessionParticipant(SESSION_ID, "HUMAN", HUMAN_ID, "MEMBER",
                20, "SCHEDULE", "WHEN_MENTIONED");
        row.setWakeConfig(new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode()
                .put("intervalSeconds", 300));
        when(participants.findByIdAndSessionId(row.getId(), SESSION_ID))
                .thenReturn(Optional.of(row));

        service.update(OWNER, WORKSPACE, SESSION_ID.toString(), row.getId().toString(),
                new SessionParticipantService.UpdateRequest(null, "MENTION", null, null, null, null));

        assertEquals("MENTION", row.getWakePolicy());
        assertNull(row.getWakeConfig(), "非 SCHEDULE ⇒ config 显式清空，不残留旧调度参数");
    }

    @Test
    void configOnlyPatchRevalidatesAgainstTheCurrentPolicy() {
        SessionParticipant row = new SessionParticipant(SESSION_ID, "HUMAN", HUMAN_ID, "MEMBER",
                20, "SCHEDULE", "WHEN_MENTIONED");
        when(participants.findByIdAndSessionId(row.getId(), SESSION_ID))
                .thenReturn(Optional.of(row));

        service.update(OWNER, WORKSPACE, SESSION_ID.toString(), row.getId().toString(),
                new SessionParticipantService.UpdateRequest(null, null, null, null,
                        Map.of("intervalSeconds", 600), null));

        assertEquals(600, row.getWakeConfig().path("intervalSeconds").asInt(),
                "config-only patch re-validates against the existing SCHEDULE policy");
    }
}
