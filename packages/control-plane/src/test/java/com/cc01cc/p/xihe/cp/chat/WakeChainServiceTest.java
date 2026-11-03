package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
 * PLAN-0624 M3 + PLAN-0630 M3 (T3.1-T3.5): wake-chain depth (default 3), cycle and the two durable
 * readings on the walked chain. The runs live in an in-memory map — the service walks them through
 * {@link DelegationChainWalker} exactly as it does against PostgreSQL, so these are the same
 * assertions M3's integration tests prove on the real edges.
 */
class WakeChainServiceTest {

    private static final String SESSION_ID = UUID.randomUUID().toString();
    private static final UUID SESSION_UUID = UUID.fromString(SESSION_ID);
    private static final String ROOT_PRINCIPAL = "P-ROOT";
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
    private ChatRunRepository chatRuns;
    private DelegationBudgetService budget;
    private WakeChainService chain;

    private final Map<UUID, ChatRun> runById = new HashMap<>();
    private final Map<UUID, Session> sessionById = new HashMap<>();
    /** participantId → principalId, mirroring what participantService.list reports. */
    private final Map<UUID, UUID> principalOf = new HashMap<>();

    @BeforeEach
    void setUp() {
        sessions = mock(SessionRepository.class);
        participantService = mock(SessionParticipantService.class);
        dispatch = mock(WakeDispatchService.class);
        eventStore = mock(EventStoreService.class);
        config = mock(ConfigService.class);
        chatRuns = mock(ChatRunRepository.class);
        budget = mock(DelegationBudgetService.class);
        when(config.resolve(eq("agent-runtime"), eq("wakeChainMaxDepth"), any(), any()))
                .thenAnswer(invocation -> maxDepth);
        when(budget.maxSpawnDepth(any(), any(), any())).thenReturn(3);
        chain = new WakeChainService(sessions, participantService, dispatch, eventStore,
                config, new ObjectMapper(), chatRuns, budget);

        Session session = mock(Session.class);
        when(session.getUserId()).thenReturn("owner-1");
        when(session.getWorkspaceId()).thenReturn("ws-1");
        when(session.getAgentPrincipalId()).thenReturn(ROOT_PRINCIPAL);
        sessionById.put(SESSION_UUID, session);
        when(sessions.findById(any())).thenAnswer(invocation -> {
            UUID id = invocation.getArgument(0);
            return Optional.ofNullable(sessionById.getOrDefault(id, session));
        });
        when(chatRuns.findById(any())).thenAnswer(invocation -> {
            UUID id = invocation.getArgument(0);
            return Optional.ofNullable(runById.get(id));
        });
        when(participantService.list(any(), any(), any())).thenReturn(rosterOf(
                entry(B, "Bee"), entry(C, "Cee"), entry(D, "Dee")));
    }

    // ------------------------------------------------------------------ fixtures

    /**
     * A user-rooted run in the main session. The walk over it is a single-node path, so a mention
     * from it opens a depth-1 link — exactly the "parent == null" branch the M2 registry had.
     */
    private String rootRun() {
        UUID id = UUID.randomUUID();
        ChatRun run = new ChatRun(id.toString(), SESSION_ID, "owner-1", "ws-1",
                "idem-" + id, "hash-" + id, null, null, "none", "succeeded");
        run.setOrigin(ChatRun.ORIGIN_USER_SUBMISSION);
        runById.put(id, run);
        return id.toString();
    }

    private ChatRun chainRun(UUID runId, UUID sessionId, String parentRunId, UUID responderPrincipal) {
        ChatRun run = new ChatRun(runId.toString(), sessionId.toString(), "owner-1", "ws-1",
                "idem-" + runId, "hash-" + runId, null, null, "none", "running");
        run.setOrigin("chain");
        run.setParentRunId(parentRunId);
        run.setAgentPrincipalId(responderPrincipal);
        runById.put(runId, run);
        return run;
    }

    /**
     * The dispatch stub mirrors what {@code SessionWakeupService.wakeupAs} durably does: the woken
     * run gets the responder principal stamped on {@code chat_runs.agent_principal_id} and the
     * parent on {@code parent_run_id} — the walk's raw material.
     */
    private void stubChainRuns() {
        Map<UUID, UUID> runByParticipant = new HashMap<>(Map.of(B, RUN_B, C, RUN_C, D, RUN_D));
        when(dispatch.fire(any(), eq("chain"), anyString(), any(), anyString()))
                .thenAnswer(invocation -> {
                    UUID participant = invocation.getArgument(0);
                    UUID runId = runByParticipant.get(participant);
                    if (runId == null) {
                        // A human recipient: no run is ever created, yet the chain must not choke.
                        return new WakeDispatchService.WakeFireResult(true, null, "submitted");
                    }
                    chainRun(runId, invocation.getArgument(3), invocation.getArgument(4),
                            principalOf.get(participant));
                    return new WakeDispatchService.WakeFireResult(true, runId, "submitted");
                });
    }

    private SessionParticipantService.ParticipantView entry(UUID id, String name) {
        UUID principal = UUID.randomUUID();
        principalOf.put(id, principal);
        return new SessionParticipantService.ParticipantView(id, "AGENT", principal,
                "MEMBER", 10, "MENTION", "ALWAYS", Instant.now(), null, name, null, null,
                null, false, null, null);
    }

    private static SessionParticipantService.ListView rosterOf(
            SessionParticipantService.ParticipantView... entries) {
        return new SessionParticipantService.ListView(List.of(entries),
                java.util.Map.of("view", true));
    }

    // ------------------------------------------------------------------ M3 chain progression

    @Test
    void chainProgressesDepthOneTwoThree() {
        stubChainRuns();
        String root = rootRun();
        chain.onAssistantContent(SESSION_ID, root, "@Bee 请继续");
        verify(dispatch).fire(eq(B), eq("chain"), contains(root),
                eq(SESSION_UUID), anyString());
        chain.onAssistantContent(SESSION_ID, RUN_B.toString(), "@Cee 接力");
        verify(dispatch).fire(eq(C), eq("chain"), contains(RUN_B.toString()),
                eq(SESSION_UUID), anyString());
        chain.onAssistantContent(SESSION_ID, RUN_C.toString(), "@Dee 收尾");
        verify(dispatch).fire(eq(D), eq("chain"), anyString(), eq(SESSION_UUID), anyString());
    }

    @Test
    void depthLimitRefusesTheNextLinkWithAudit() {
        maxDepth = "2";
        stubChainRuns();
        String root = rootRun();
        chain.onAssistantContent(SESSION_ID, root, "@Bee");
        chain.onAssistantContent(SESSION_ID, RUN_B.toString(), "@Cee");
        // depth would be 3 > 2 → refused, D never fired.
        chain.onAssistantContent(SESSION_ID, RUN_C.toString(), "@Dee");
        verify(dispatch, never()).fire(eq(D), eq("chain"), anyString(),
                eq(SESSION_UUID), anyString());
        assertRefusedAudit("depth_exceeded");
    }

    @Test
    void cycleIsRefusedOnTheSamePath() {
        stubChainRuns();
        String root = rootRun();
        chain.onAssistantContent(SESSION_ID, root, "@Bee");          // root → B (depth 1)
        chain.onAssistantContent(SESSION_ID, RUN_B.toString(), "@Cee");    // B → C (depth 2)
        chain.onAssistantContent(SESSION_ID, RUN_C.toString(), "@Bee");    // C → B = cycle
        verify(dispatch, times(1)).fire(eq(B), eq("chain"), anyString(),
                eq(SESSION_UUID), anyString());
        assertRefusedAudit("cycle");
    }

    @Test
    void separateRootsDoNotShareAwakenedSets() {
        stubChainRuns();
        chain.onAssistantContent(SESSION_ID, rootRun(), "@Bee");
        chain.onAssistantContent(SESSION_ID, rootRun(), "@Bee");
        verify(dispatch, times(2)).fire(eq(B), eq("chain"), anyString(),
                eq(SESSION_UUID), anyString());
    }

    @Test
    void humanMentionsRouteThroughDispatchWhichNotifies() {
        UUID humanId = UUID.randomUUID();
        when(participantService.list(any(), any(), any())).thenReturn(rosterOf(
                new SessionParticipantService.ParticipantView(humanId, "HUMAN",
                        UUID.randomUUID(), "MEMBER", 10, "MENTION", "ALWAYS", Instant.now(),
                        null, "Han", null, null, null, false, null, null)));
        stubChainRuns();
        chain.onAssistantContent(SESSION_ID, rootRun(), "@Han 看一下");
        // The chain still routes the mention to dispatch — 人=通知 is dispatch's branch,
        // the chain service never decides "humans cannot be mentioned".
        verify(dispatch, times(1)).fire(eq(humanId), eq("chain"), anyString(),
                eq(SESSION_UUID), anyString());
    }

    /**
     * PLAN-0630 M1 (taskbook §3.4-②): a spawn child now owns a PRIMARY, so its roster is non-empty —
     * the regression to pin is that an ordinary reply <b>without</b> {@code @} wakes nobody. Before the
     * PRIMARY fix this held trivially (empty roster); after it, "no mention" must still mean "no wake",
     * otherwise every sub-conversation turn would fan out.
     */
    @Test
    void replyWithoutMentionWakesNobody() {
        stubChainRuns();
        chain.onAssistantContent(SESSION_ID, rootRun(), "我处理完了，没有提到任何人。");
        verify(dispatch, never()).fire(any(), anyString(), anyString(),
                eq(SESSION_UUID), anyString());
        verify(eventStore, never()).append(any(), any(), any(), eq("wake_dispatch"), any());
    }

    /**
     * PLAN-0630 M1 (taskbook §3.4-② second half): with a PRIMARY present, an agent that prints its own
     * display name mentions itself. The chain must terminate with a visible refusal instead of looping —
     * either the cycle guard (same principal on the same path) or the depth gate stops it.
     */
    @Test
    void selfMentionTerminatesWithAVisibleRefusal() {
        UUID self = UUID.randomUUID();
        when(participantService.list(any(), any(), any())).thenReturn(rosterOf(entry(self, "Bee")));
        when(dispatch.fire(any(), eq("chain"), anyString(), any(), anyString()))
                .thenAnswer(invocation -> {
                    chainRun(RUN_B, invocation.getArgument(3), invocation.getArgument(4),
                            principalOf.get(invocation.getArgument(0)));
                    return new WakeDispatchService.WakeFireResult(true, RUN_B, "submitted");
                });

        chain.onAssistantContent(SESSION_ID, rootRun(), "@Bee 我继续");
        chain.onAssistantContent(SESSION_ID, RUN_B.toString(), "@Bee 我继续");
        chain.onAssistantContent(SESSION_ID, RUN_B.toString(), "@Bee 我继续");

        // One wake happened; every further self-mention is refused, so the chain cannot loop.
        verify(dispatch, times(1)).fire(eq(self), eq("chain"), anyString(),
                eq(SESSION_UUID), anyString());
        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(eventStore, times(2)).append(eq(SESSION_ID), eq("ws-1"), eq("owner-1"),
                eq("wake_dispatch"), payload.capture());
        for (Object body : payload.getAllValues()) {
            assertEquals("chain_refused",
                    ((com.fasterxml.jackson.databind.node.ObjectNode) body).path("outcome").asText());
        }
    }

    // ------------------------------------------------------------------ T3.4 two readings, two ceilings

    /**
     * T3.4: a two-spawn-deep run (root → spawn → spawn) wakes at wakeDepth 3 / spawnDepth 2. With the
     * wake ceiling still satisfied, only the delegation depth refuses — and the reason names
     * DELEGATION_LIMIT_EXCEEDED, the same code the spawn gate answers.
     */
    @Test
    void spawnDepthExceededRefusesWithDelegationLimit() {
        UUID r3 = twoSpawnDeepRun();
        when(budget.maxSpawnDepth(any(), any(), any())).thenReturn(1);

        chain.onAssistantContent(SESSION_ID, r3.toString(), "@Dee 继续");

        verify(dispatch, never()).fire(eq(D), eq("chain"), anyString(), any(), anyString());
        assertRefusedAudit("delegation_limit_exceeded");
        com.fasterxml.jackson.databind.node.ObjectNode body = lastRefusedPayload();
        assertEquals(3, body.path("wakeDepth").asInt(), "wakeDepth 3 is within the wake ceiling");
        assertEquals(2, body.path("spawnDepth").asInt(), "spawnDepth 2 exceeds the stubbed max 1");
    }

    /** T3.4 priority: both readings over their ceilings refuse with the wake-depth reason FIRST. */
    @Test
    void wakeDepthTakesPriorityOverTheSpawnGate() {
        maxDepth = "2";
        UUID r3 = twoSpawnDeepRun();

        chain.onAssistantContent(SESSION_ID, r3.toString(), "@Dee 继续");

        assertRefusedAudit("depth_exceeded");
        com.fasterxml.jackson.databind.node.ObjectNode body = lastRefusedPayload();
        assertFalse(body.path("error").asText().contains("delegation_limit_exceeded"),
                "the wake-depth refusal wins; the spawn gate is never consulted: " + body);
        verify(budget, never()).maxSpawnDepth(any(), any(), any());
        verify(dispatch, never()).fire(eq(D), eq("chain"), anyString(), any(), anyString());
    }

    /**
     * The spawn fixture: root run in the main session, then two spawn sessions each carrying a spawn
     * run on the waiting link — walking r3 yields hops=3 (wakeDepth 3) and spawnHops=2 (spawnDepth 2).
     */
    private UUID twoSpawnDeepRun() {
        UUID r1 = UUID.fromString(rootRun());
        UUID s2 = UUID.randomUUID();
        UUID r2 = UUID.randomUUID();
        UUID s3 = UUID.randomUUID();
        UUID r3 = UUID.randomUUID();
        sessionById.put(s2, spawnSession(s2, SESSION_UUID, r1, "P2"));
        sessionById.put(s3, spawnSession(s3, s2, r2, "P3"));
        ChatRun spawn2 = new ChatRun(r2.toString(), s2.toString(), "owner-1", "ws-1",
                "idem-" + r2, "hash-" + r2, null, null, "none", "running");
        spawn2.setOrigin(ChatRun.ORIGIN_SPAWN);
        spawn2.setWaitingOnRunId(r1.toString());
        runById.put(r2, spawn2);
        ChatRun spawn3 = new ChatRun(r3.toString(), s3.toString(), "owner-1", "ws-1",
                "idem-" + r3, "hash-" + r3, null, null, "none", "running");
        spawn3.setOrigin(ChatRun.ORIGIN_SPAWN);
        spawn3.setWaitingOnRunId(r2.toString());
        runById.put(r3, spawn3);
        return r3;
    }

    private Session spawnSession(UUID id, UUID spawnedFromSession, UUID spawnedFromRun, String principal) {
        Session session = mock(Session.class);
        when(session.getKind()).thenReturn(Session.KIND_SPAWN);
        when(session.getSpawnedFromSessionId()).thenReturn(spawnedFromSession);
        when(session.getSpawnedFromRunId()).thenReturn(spawnedFromRun);
        when(session.getAgentPrincipalId()).thenReturn(principal);
        return session;
    }

    // ------------------------------------------------------------------ T3.5 observability fields

    /** T3.5: the refusal payload gains parentRunId/rootRunId/wakeDepth/spawnDepth — no new event name. */
    @Test
    void refusedPayloadCarriesParentRootAndBothDepths() {
        maxDepth = "1";
        stubChainRuns();
        String root = rootRun();
        chain.onAssistantContent(SESSION_ID, root, "@Bee");
        chain.onAssistantContent(SESSION_ID, RUN_B.toString(), "@Cee 接力");

        com.fasterxml.jackson.databind.node.ObjectNode body = lastRefusedPayload();
        assertEquals(RUN_B.toString(), body.path("parentRunId").asText());
        assertEquals(root, body.path("rootRunId").asText(),
                "the walked root, not the refused parent, is the chain root");
        assertEquals(2, body.path("wakeDepth").asInt());
        assertEquals(0, body.path("spawnDepth").asInt());
        assertTrue(body.path("wakeRoundId").asText().equals("wake:chain:" + root),
                "the M2 wake-round string shape is preserved: " + body.path("wakeRoundId").asText());
    }

    /** T3.5: only the pre-existing event names are ever appended — zero new event names. */
    @Test
    void onlyExistingEventNamesAreAppended() {
        stubChainRuns();
        String root = rootRun();
        chain.onAssistantContent(SESSION_ID, root, "@Bee");
        chain.onAssistantContent(SESSION_ID, RUN_B.toString(), "@Cee");
        chain.onAssistantContent(SESSION_ID, RUN_C.toString(), "@Bee 循环");

        ArgumentCaptor<String> eventNames = ArgumentCaptor.forClass(String.class);
        verify(eventStore, times(1)).append(any(), any(), any(), eventNames.capture(), any());
        Set<String> distinct = new HashSet<>(eventNames.getAllValues());
        assertEquals(Set.of("wake_dispatch"), distinct,
                "the audit surface stays on the one pre-existing event name");
    }

    // ------------------------------------------------------------------ payload helpers

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

    private com.fasterxml.jackson.databind.node.ObjectNode lastRefusedPayload() {
        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(eventStore, times(1)).append(eq(SESSION_ID), eq("ws-1"), eq("owner-1"),
                eq("wake_dispatch"), payload.capture());
        return (com.fasterxml.jackson.databind.node.ObjectNode) payload.getValue();
    }
}
