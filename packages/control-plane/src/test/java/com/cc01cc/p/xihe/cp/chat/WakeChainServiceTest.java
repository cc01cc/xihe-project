package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0624 M3: wake-chain depth (default 3) and cycle detection on agent output.
 * Run ids are deterministic per participant so the registry links can be walked.
 */
class WakeChainServiceTest {

    private static final String SESSION_ID = UUID.randomUUID().toString();
    private static final UUID B = UUID.randomUUID();
    private static final UUID C = UUID.randomUUID();
    private static final UUID D = UUID.randomUUID();
    private static final UUID RUN_B = UUID.randomUUID();
    private static final UUID RUN_C = UUID.randomUUID();
    private static final UUID RUN_D = UUID.randomUUID();

    private String maxDepth = "3";

    private SessionRepository sessions;
    private SessionParticipantService participantService;
    private WakeDispatchService dispatch;
    private EventStoreService eventStore;
    private ConfigService config;
    private WakeChainService chain;

    @BeforeEach
    void setUp() {
        sessions = mock(SessionRepository.class);
        participantService = mock(SessionParticipantService.class);
        dispatch = mock(WakeDispatchService.class);
        eventStore = mock(EventStoreService.class);
        config = mock(ConfigService.class);
        when(config.resolve(eq("agent-runtime"), eq("wakeChainMaxDepth"), any(), any()))
                .thenAnswer(invocation -> maxDepth);
        chain = new WakeChainService(sessions, participantService, dispatch, eventStore,
                config, new ObjectMapper());

        Session session = mock(Session.class);
        when(session.getUserId()).thenReturn("owner-1");
        when(session.getWorkspaceId()).thenReturn("ws-1");
        when(sessions.findById(UUID.fromString(SESSION_ID)))
                .thenReturn(java.util.Optional.of(session));
        when(participantService.list(any(), any(), any())).thenReturn(rosterOf(
                entry(B, "Bee"), entry(C, "Cee"), entry(D, "Dee")));
    }

    private void stubChainRuns() {
        Map<UUID, UUID> runByParticipant = new HashMap<>(Map.of(B, RUN_B, C, RUN_C, D, RUN_D));
        when(dispatch.fire(any(), eq("chain"), anyString(), eq(UUID.fromString(SESSION_ID))))
                .thenAnswer(invocation -> {
                    UUID participant = invocation.getArgument(0);
                    return new WakeDispatchService.WakeFireResult(true,
                            runByParticipant.get(participant), "submitted");
                });
    }

    private static SessionParticipantService.ParticipantView entry(UUID id, String name) {
        return new SessionParticipantService.ParticipantView(id, "AGENT", UUID.randomUUID(),
                "MEMBER", 10, "MENTION", "ALWAYS", Instant.now(), null, name, null, null,
                null, false, null);
    }

    private static SessionParticipantService.ListView rosterOf(
            SessionParticipantService.ParticipantView... entries) {
        return new SessionParticipantService.ListView(List.of(entries),
                java.util.Map.of("view", true));
    }

    @Test
    void chainProgressesDepthOneTwoThree() {
        stubChainRuns();
        chain.onAssistantContent(SESSION_ID, "root-run", "@Bee 请继续");
        verify(dispatch).fire(eq(B), eq("chain"), contains("root-run"),
                eq(UUID.fromString(SESSION_ID)));
        chain.onAssistantContent(SESSION_ID, RUN_B.toString(), "@Cee 接力");
        verify(dispatch).fire(eq(C), eq("chain"), contains(RUN_B.toString()),
                eq(UUID.fromString(SESSION_ID)));
        chain.onAssistantContent(SESSION_ID, RUN_C.toString(), "@Dee 收尾");
        verify(dispatch).fire(eq(D), eq("chain"), anyString(), eq(UUID.fromString(SESSION_ID)));
    }

    @Test
    void depthLimitRefusesTheNextLinkWithAudit() {
        maxDepth = "2";
        stubChainRuns();
        chain.onAssistantContent(SESSION_ID, "root-run", "@Bee");
        chain.onAssistantContent(SESSION_ID, RUN_B.toString(), "@Cee");
        // depth would be 3 > 2 → refused, D never fired.
        chain.onAssistantContent(SESSION_ID, RUN_C.toString(), "@Dee");
        verify(dispatch, never()).fire(eq(D), eq("chain"), anyString(),
                eq(UUID.fromString(SESSION_ID)));
        assertRefusedAudit("depth_exceeded");
    }

    @Test
    void cycleIsRefusedOnTheSamePath() {
        stubChainRuns();
        chain.onAssistantContent(SESSION_ID, "root-run", "@Bee");          // root → B (depth 1)
        chain.onAssistantContent(SESSION_ID, RUN_B.toString(), "@Cee");    // B → C (depth 2)
        chain.onAssistantContent(SESSION_ID, RUN_C.toString(), "@Bee");    // C → B = cycle
        verify(dispatch, times(1)).fire(eq(B), eq("chain"), anyString(),
                eq(UUID.fromString(SESSION_ID)));
        assertRefusedAudit("cycle");
    }

    @Test
    void separateRootsDoNotShareAwakenedSets() {
        stubChainRuns();
        chain.onAssistantContent(SESSION_ID, "root-1", "@Bee");
        chain.onAssistantContent(SESSION_ID, "root-2", "@Bee");
        verify(dispatch, times(2)).fire(eq(B), eq("chain"), anyString(),
                eq(UUID.fromString(SESSION_ID)));
    }

    @Test
    void humanMentionsRouteThroughDispatchWhichNotifies() {
        UUID humanId = UUID.randomUUID();
        when(participantService.list(any(), any(), any())).thenReturn(rosterOf(
                new SessionParticipantService.ParticipantView(humanId, "HUMAN",
                        UUID.randomUUID(), "MEMBER", 10, "MENTION", "ALWAYS", Instant.now(),
                        null, "Han", null, null, null, false, null)));
        stubChainRuns();
        chain.onAssistantContent(SESSION_ID, "root-run", "@Han 看一下");
        // The chain still routes the mention to dispatch — 人=通知 is dispatch's branch,
        // the chain service never decides "humans cannot be mentioned".
        verify(dispatch, times(1)).fire(eq(humanId), eq("chain"), anyString(),
                eq(UUID.fromString(SESSION_ID)));
    }

    private void assertRefusedAudit(String reason) {
        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(eventStore, times(1)).append(eq(SESSION_ID), eq("ws-1"), eq("owner-1"),
                eq("wake_dispatch"), payload.capture());
        com.fasterxml.jackson.databind.node.ObjectNode body =
                (com.fasterxml.jackson.databind.node.ObjectNode) payload.getValue();
        assertEquals("chain_refused", body.path("outcome").asText());
        assertTrue(body.path("error").asText().contains(reason),
                "refusal reason recorded: " + reason);
    }
}
