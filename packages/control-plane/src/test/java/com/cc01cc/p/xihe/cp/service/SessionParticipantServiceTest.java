package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.SessionParticipantCursor;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0623 M1a: participant invariants and the two authorization paths (D23-13 / D23-08).
 *
 * <p>Unit level on purpose: every rule here is a decision in this service, not a Spring wiring
 * detail. The HTTP envelope (`{participants:[…], capabilities:{…}}`) is pinned by
 * {@code OpenApiYamlContractTest} + the controller, and the run-level attribution that consumes
 * {@code authorizeAsParticipant} lands in M1b.</p>
 */
class SessionParticipantServiceTest {

    private static final String WORKSPACE = UUID.randomUUID().toString();
    private static final String OWNER = UUID.randomUUID().toString();
    private static final String STRANGER = UUID.randomUUID().toString();
    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID AGENT_ID = UUID.randomUUID();
    private static final UUID HUMAN_ID = UUID.randomUUID();

    private SessionParticipantRepository participants;
    private SessionParticipantCursorRepository cursors;
    private SessionRepository sessions;
    private AgentPrincipalRepository agents;
    private UserRepository users;
    private WorkspaceService workspaces;
    private GrantAuthorizationService grants;
    private SessionParticipantService service;
    private Session session;

    @BeforeEach
    void setUp() {
        participants = mock(SessionParticipantRepository.class);
        cursors = mock(SessionParticipantCursorRepository.class);
        sessions = mock(SessionRepository.class);
        agents = mock(AgentPrincipalRepository.class);
        users = mock(UserRepository.class);
        workspaces = mock(WorkspaceService.class);
        grants = mock(GrantAuthorizationService.class);
        service = new SessionParticipantService(participants, cursors, sessions, agents, users,
                workspaces, grants,
                mock(com.cc01cc.p.xihe.cp.scheduled.WakeScheduleProjectionService.class));

        session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getWorkspaceId()).thenReturn(WORKSPACE);
        when(session.getUserId()).thenReturn(OWNER);
        when(session.isArchived()).thenReturn(false);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));
        when(cursors.findByParticipantIdIn(any())).thenReturn(java.util.List.of());
        when(participants.save(any(SessionParticipant.class))).thenAnswer(call -> call.getArgument(0));
        when(cursors.save(any(SessionParticipantCursor.class))).thenAnswer(call -> call.getArgument(0));
        when(participants.findBySessionIdOrderByOrderIndexAsc(SESSION_ID)).thenReturn(List.of());
    }

    // ------------------------------------------------------------ R4 ordering

    @Test
    void newParticipantsTakeTheNextTenStepAndDeletesLeaveTheGap() {
        when(users.existsById(HUMAN_ID)).thenReturn(true);
        when(participants.maxOrderIndex(SESSION_ID)).thenReturn(0);
        SessionParticipantService.ParticipantView first = service.add(OWNER, WORKSPACE,
                SESSION_ID.toString(), humanRequest());
        assertEquals(10, first.orderIndex(), "R4: the first participant sits at 10");
        assertEquals("MENTION", first.wakePolicy(), "R3: MEMBER wakes on mention");
        assertEquals("WHEN_MENTIONED", first.respondPolicy());

        when(participants.maxOrderIndex(SESSION_ID)).thenReturn(20);
        SessionParticipantService.ParticipantView third = service.add(OWNER, WORKSPACE,
                SESSION_ID.toString(), humanRequest());
        assertEquals(30, third.orderIndex(), "R4: MAX+10 — a removed row is never renumbered");
    }

    @Test
    void removingAMemberSoftDisablesTheRowSoTheUiKeepsTheDisabledBadge() {
        SessionParticipant member = new SessionParticipant(SESSION_ID, "AGENT", AGENT_ID, "MEMBER",
                20, "MENTION", "WHEN_MENTIONED");
        when(participants.findByIdAndSessionId(member.getId(), SESSION_ID))
                .thenReturn(Optional.of(member));

        service.remove(OWNER, WORKSPACE, SESSION_ID.toString(), member.getId().toString());

        assertNotNull(member.getDisabledAt(), "D23-26: remove is a soft disable — the row survives");
        verify(participants, never()).delete(member);
        verify(participants).save(member);
    }

    // ------------------------------------------------------------ D23-13 PRIMARY

    @Test
    void aSecondPrimaryIsRefusedWithABusinessCode() {
        CpApiException refused = assertThrows(CpApiException.class, () -> service.add(OWNER,
                WORKSPACE, SESSION_ID.toString(), new SessionParticipantService.AddRequest(
                        "AGENT", AGENT_ID.toString(), "PRIMARY", null, null, null)));
        assertEquals("PARTICIPANT_PRIMARY_EXISTS", refused.getCode(),
                "D23-13: a second PRIMARY is a conflict, never a 500");
        assertEquals(HttpStatus.CONFLICT, refused.getStatus());
    }

    @Test
    void thePrimaryCannotBeRemovedOrDowngraded() {
        SessionParticipant primary = new SessionParticipant(SESSION_ID, "AGENT", AGENT_ID,
                "PRIMARY", 10, "ALL_MESSAGES", "ALWAYS");
        when(participants.findByIdAndSessionId(primary.getId(), SESSION_ID))
                .thenReturn(Optional.of(primary));

        CpApiException removed = assertThrows(CpApiException.class,
                () -> service.remove(OWNER, WORKSPACE, SESSION_ID.toString(),
                        primary.getId().toString()));
        assertEquals("PARTICIPANT_PRIMARY_IMMUTABLE", removed.getCode(),
                "D23-13: PRIMARY is irreducible — a new session is the way to replace it");
        assertEquals(HttpStatus.FORBIDDEN, removed.getStatus());

        CpApiException downgraded = assertThrows(CpApiException.class,
                () -> service.update(OWNER, WORKSPACE, SESSION_ID.toString(),
                        primary.getId().toString(),
                        new SessionParticipantService.UpdateRequest("MEMBER", null, null, null, null)));
        assertEquals("PARTICIPANT_PRIMARY_IMMUTABLE", downgraded.getCode(),
                "D23-13: PRIMARY is not transferable");
    }

    @Test
    void aMemberCannotBePromotedToPrimary() {
        SessionParticipant member = new SessionParticipant(SESSION_ID, "AGENT", AGENT_ID,
                "MEMBER", 20, "MENTION", "WHEN_MENTIONED");
        when(participants.findByIdAndSessionId(member.getId(), SESSION_ID))
                .thenReturn(Optional.of(member));

        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.update(OWNER, WORKSPACE, SESSION_ID.toString(),
                        member.getId().toString(),
                        new SessionParticipantService.UpdateRequest("PRIMARY", null, null, null, null)));
        assertEquals("PARTICIPANT_PRIMARY_EXISTS", refused.getCode());
    }

    @Test
    void duplicatePrincipalsAreRefusedWithABusinessCode() {
        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalId(SESSION_ID, "HUMAN",
                HUMAN_ID)).thenReturn(true);
        when(users.existsById(HUMAN_ID)).thenReturn(true);

        CpApiException refused = assertThrows(CpApiException.class, () -> service.add(OWNER,
                WORKSPACE, SESSION_ID.toString(), humanRequest()));
        assertEquals("PARTICIPANT_ALREADY_EXISTS", refused.getCode());
        assertEquals(HttpStatus.CONFLICT, refused.getStatus());
    }

    // ------------------------------------------------------------ authorization

    @Test
    void aStrangerCannotSeeOrManageTheParticipantList() {
        CpApiException hidden = assertThrows(CpApiException.class,
                () -> service.list(STRANGER, WORKSPACE, SESSION_ID.toString()));
        assertEquals("SESSION_ACCESS_DENIED", hidden.getCode(),
                "only the owner or an invited HUMAN participant can read the list");
        assertEquals(HttpStatus.FORBIDDEN, hidden.getStatus());
    }

    @Test
    void aWorkspaceMemberWithManageAuthorityMayAddPeopleButTheOwnerKeepsTheSay() {
        String admin = UUID.randomUUID().toString();
        when(workspaces.isWorkspaceMember(WORKSPACE, admin)).thenReturn(true);
        when(grants.allowsUserOnly(any())).thenReturn(true);
        when(users.existsById(HUMAN_ID)).thenReturn(true);

        SessionParticipantService.ParticipantView added =
                service.add(admin, WORKSPACE, SESSION_ID.toString(), humanRequest());
        assertEquals("HUMAN", added.principalKind(), "D23-08: an administrator may add people");

        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                SESSION_ID, "HUMAN", UUID.fromString(admin))).thenReturn(true);
        when(grants.allowsUserOnly(any())).thenReturn(false);
        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.add(admin, WORKSPACE, SESSION_ID.toString(), humanRequest()));
        assertEquals("PARTICIPANT_MANAGE_FORBIDDEN", refused.getCode(),
                "without MANAGE_WORKSPACE_AGENTS the add is refused with an explicit code");
    }

    @Test
    void theCapabilityBlockGatesTheUiBeforeTheClick() {
        SessionParticipant primary = new SessionParticipant(SESSION_ID, "AGENT", AGENT_ID,
                "PRIMARY", 10, "ALL_MESSAGES", "ALWAYS");
        when(participants.findBySessionIdOrderByOrderIndexAsc(SESSION_ID))
                .thenReturn(List.of(primary));

        SessionParticipantService.ListView ownerView =
                service.list(OWNER, WORKSPACE, SESSION_ID.toString());
        // D23-27: the owner can speak as somebody only when a row is selfOwned; in this fixture the
        // only participant is an AGENT whose owner is not the caller, so both projections are false.
        assertEquals(Map.of("view", true, "manage", true, "mention", true, "speakAs", false),
                ownerView.capabilities(),
                "capability keys: view / manage / mention / speakAs (the UI gates on them)");
        assertFalse(ownerView.participants().get(0).selfOwned(),
                "selfOwned and speakAs are the same predicate, projected twice");
        assertEquals(1, ownerView.participants().size());
    }

    // ------------------------------------------------------------ D23-08 send-as

    @Test
    void aHumanMayOnlySpeakAsThemselves() {
        SessionParticipant mine = new SessionParticipant(SESSION_ID, "HUMAN", UUID.fromString(OWNER),
                "MEMBER", 20, "MENTION", "WHEN_MENTIONED");
        when(participants.findByIdAndSessionId(mine.getId(), SESSION_ID)).thenReturn(Optional.of(mine));
        assertEquals(mine, service.authorizeAsParticipant(OWNER, WORKSPACE, SESSION_ID.toString(),
                mine.getId().toString()));

        SessionParticipant someoneElse = new SessionParticipant(SESSION_ID, "HUMAN",
                UUID.fromString(STRANGER), "MEMBER", 30, "MENTION", "WHEN_MENTIONED");
        when(participants.findByIdAndSessionId(someoneElse.getId(), SESSION_ID))
                .thenReturn(Optional.of(someoneElse));
        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                SESSION_ID, "HUMAN", UUID.fromString(OWNER))).thenReturn(true);

        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.authorizeAsParticipant(OWNER, WORKSPACE, SESSION_ID.toString(),
                        someoneElse.getId().toString()));
        assertEquals("PARTICIPANT_CAP_DENIED", refused.getCode(),
                "D23-08: speaking as another human is impersonation, not delegation");
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus());
    }

    @Test
    void anAdministratorCannotSpeakForAnAgentInSomeoneElsesSession() {
        Session otherOwnersSession = mock(Session.class);
        when(otherOwnersSession.getId()).thenReturn(SESSION_ID);
        when(otherOwnersSession.getWorkspaceId()).thenReturn(WORKSPACE);
        when(otherOwnersSession.getUserId()).thenReturn(STRANGER);
        when(otherOwnersSession.isArchived()).thenReturn(false);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(otherOwnersSession));
        // The administrator may manage (added themselves as a HUMAN participant) ...
        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                SESSION_ID, "HUMAN", UUID.fromString(OWNER))).thenReturn(true);
        when(workspaces.isWorkspaceMember(WORKSPACE, OWNER)).thenReturn(true);
        when(grants.allowsUserOnly(any())).thenReturn(true);

        SessionParticipant agentRow = new SessionParticipant(SESSION_ID, "AGENT", AGENT_ID,
                "PRIMARY", 10, "ALL_MESSAGES", "ALWAYS");
        when(participants.findByIdAndSessionId(agentRow.getId(), SESSION_ID))
                .thenReturn(Optional.of(agentRow));

        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.authorizeAsParticipant(OWNER, WORKSPACE, SESSION_ID.toString(),
                        agentRow.getId().toString()));
        assertEquals("PARTICIPANT_CAP_DENIED", refused.getCode(),
                "D23-08: managing members never means speaking as their agent");
    }

    @Test
    void theOwnerMaySpeakAsAPersonalAgentOnlyWhenItIsTheirs() {
        SessionParticipant agentRow = new SessionParticipant(SESSION_ID, "AGENT", AGENT_ID,
                "PRIMARY", 10, "ALL_MESSAGES", "ALWAYS");
        when(participants.findByIdAndSessionId(agentRow.getId(), SESSION_ID))
                .thenReturn(Optional.of(agentRow));
        AgentPrincipal personal = mock(AgentPrincipal.class);
        when(personal.getScope()).thenReturn("PERSONAL");
        when(personal.getOwnerUserId()).thenReturn(UUID.fromString(OWNER));
        when(agents.findById(AGENT_ID)).thenReturn(Optional.of(personal));

        assertEquals(agentRow, service.authorizeAsParticipant(OWNER, WORKSPACE,
                SESSION_ID.toString(), agentRow.getId().toString()));

        when(personal.getOwnerUserId()).thenReturn(UUID.fromString(STRANGER));
        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.authorizeAsParticipant(OWNER, WORKSPACE, SESSION_ID.toString(),
                        agentRow.getId().toString()));
        assertEquals("PARTICIPANT_CAP_DENIED", refused.getCode(),
                "a PERSONAL agent owned by someone else is not yours to speak for");
    }

    // ------------------------------------------------------------ view projection

    @Test
    void agentRowsCarryTheModelIntentAndSourceWhileHumanRowsStayNull() {
        SessionParticipant agentRow = new SessionParticipant(SESSION_ID, "AGENT", AGENT_ID,
                "PRIMARY", 10, "ALL_MESSAGES", "ALWAYS");
        SessionParticipant humanRow = new SessionParticipant(SESSION_ID, "HUMAN", HUMAN_ID,
                "MEMBER", 20, "MENTION", "WHEN_MENTIONED");
        when(participants.findBySessionIdOrderByOrderIndexAsc(SESSION_ID))
                .thenReturn(List.of(agentRow, humanRow));
        AgentPrincipal principal = mock(AgentPrincipal.class);
        when(principal.getName()).thenReturn("Research Agent");
        when(principal.getScope()).thenReturn("WORKSPACE");
        when(principal.getDefaultModelProvider()).thenReturn("openai");
        when(principal.getDefaultModelName()).thenReturn("gpt-5");
        when(agents.findById(AGENT_ID)).thenReturn(Optional.of(principal));

        SessionParticipantService.ListView view = service.list(OWNER, WORKSPACE, SESSION_ID.toString());
        SessionParticipantService.ParticipantView agent = view.participants().getFirst();
        SessionParticipantService.ParticipantView human = view.participants().get(1);

        assertEquals("Research Agent", agent.displayName(), "AGENT rows carry the principal name");
        assertEquals("openai", agent.defaultModelProvider());
        assertEquals("gpt-5", agent.defaultModelName());
        assertEquals("workspace", agent.source(), "source reuses the 0622 scope vocabulary");
        assertNull(human.displayName(), "HUMAN rows must not fake agent fields");
        assertNull(human.defaultModelProvider());
        assertNull(human.defaultModelName());
        assertNull(human.source());

        verify(cursors).findByParticipantIdIn(any());
    }
    private static SessionParticipantService.AddRequest humanRequest() {
        return new SessionParticipantService.AddRequest("HUMAN", HUMAN_ID.toString(), null, null, null, null);
    }
}