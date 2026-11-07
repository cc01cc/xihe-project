package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
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
 * PLAN-0630 M2 (T2.7): the extracted chain walk's decision table — hops/spawnHops/principalPath
 * for every edge shape, and the shared ancestor-missing determination (T2.8) both gates consume.
 */
class DelegationChainWalkerTest {

    private SessionRepository sessions;
    private ChatRunRepository runs;
    private DelegationChainWalker walker;

    // PLAN-0689 A3b: identity fixtures must be real UUID strings — the Run's stamp is a UUID
    // column, so a readable placeholder like P1 can no longer be mirrored onto it.
    private static final String P1 = "00000000-0000-0000-0000-0000000000a1";
    private static final String P2 = "00000000-0000-0000-0000-0000000000a2";

    private final Map<UUID, Session> sessionById = new HashMap<>();
    private final Map<UUID, ChatRun> runById = new HashMap<>();

    @BeforeEach
    void setUp() {
        sessions = mock(SessionRepository.class);
        runs = mock(ChatRunRepository.class);
        walker = new DelegationChainWalker(sessions, runs);
        when(sessions.findById(any()))
                .thenAnswer(invocation -> Optional.ofNullable(sessionById.get(invocation.getArgument(0))));
        when(runs.findById(any()))
                .thenAnswer(invocation -> Optional.ofNullable(runById.get(invocation.getArgument(0))));
    }

    private Session session(UUID id, String kind, UUID spawnedFromSession, UUID spawnedFromRun,
                            String principalId) {
        Session session = new Session("ws-1", "user-1", "t-" + id.toString().substring(0, 6));
        session.setId(id);
        session.setKind(kind);
        session.setSpawnedFromSessionId(spawnedFromSession);
        session.setSpawnedFromRunId(spawnedFromRun);
        session.setAgentPrincipalId(principalId);
        sessionById.put(id, session);
        return session;
    }

    private ChatRun run(UUID id, UUID sessionId, String origin, String waitingOnRunId,
                        String parentRunId) {
        ChatRun run = new ChatRun(id.toString(), sessionId.toString(), "user-1", "ws-1",
                "idem-" + id, "hash", null, null, "none", "accepted");
        run.setOrigin(origin);
        run.setWaitingOnRunId(waitingOnRunId);
        run.setParentRunId(parentRunId);
        // PLAN-0689 A3b: the walker now reads only the Run's own stamp. These fixtures carry the
        // identity on the Session (the M2-era reading), so mirror it onto the Run to keep the
        // expected principalPath unchanged while the product code stops falling back.
        Session owning = sessionById.get(sessionId);
        if (owning != null && owning.getAgentPrincipalId() != null) {
            run.setAgentPrincipalId(UUID.fromString(owning.getAgentPrincipalId()));
        }
        runById.put(id, run);
        return run;
    }

    private static String edge(DelegationChainWalker.ChainWalk walk, int index) {
        return walk.hops().get(index).edge();
    }

    @Test
    void userRootedRunIsASingleNodePath() {
        UUID s1 = UUID.randomUUID();
        UUID r1 = UUID.randomUUID();
        session(s1, null, null, null, P1);
        run(r1, s1, ChatRun.ORIGIN_USER_SUBMISSION, null, null);

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(runById.get(r1));

        assertEquals(1, walk.hops().size(), "a root run is its own whole path");
        assertEquals(DelegationChainWalker.EDGE_NONE, edge(walk, 0));
        assertEquals(0, walk.spawnHops());
        assertEquals(List.of(P1), walk.principalPath());
    }

    @Test
    void wakeChainCountsEveryHopWithoutSpawn() {
        UUID s1 = UUID.randomUUID();
        UUID r1 = UUID.randomUUID();
        UUID r2 = UUID.randomUUID();
        UUID r3 = UUID.randomUUID();
        session(s1, null, null, null, P1);
        run(r1, s1, ChatRun.ORIGIN_USER_SUBMISSION, null, null);
        run(r2, s1, "scheduled", null, r1.toString());
        run(r3, s1, "scheduled", null, r2.toString());

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(runById.get(r3));

        assertEquals(3, walk.hops().size());
        assertEquals(DelegationChainWalker.EDGE_NONE, edge(walk, 0));
        assertEquals(DelegationChainWalker.EDGE_WAKE, edge(walk, 1));
        assertEquals(DelegationChainWalker.EDGE_WAKE, edge(walk, 2));
        assertEquals(0, walk.spawnHops(), "pure wake hops never raise the delegation depth");
        assertEquals(List.of(P1, P1, P1), walk.principalPath());
    }

    @Test
    void spawnRunCrossesThroughTheWaitingLink() {
        UUID s1 = UUID.randomUUID();
        UUID s2 = UUID.randomUUID();
        UUID r1 = UUID.randomUUID();
        UUID r2 = UUID.randomUUID();
        session(s1, null, null, null, P1);
        session(s2, Session.KIND_SPAWN, s1, r1, P1);
        run(r1, s1, ChatRun.ORIGIN_USER_SUBMISSION, null, null);
        run(r2, s2, ChatRun.ORIGIN_SPAWN, r1.toString(), null);

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(runById.get(r2));

        assertEquals(2, walk.hops().size());
        assertEquals(DelegationChainWalker.EDGE_SPAWN, edge(walk, 1));
        assertEquals(1, walk.spawnHops(), "the spawn edge raises the delegation depth");
        assertEquals(r1, walk.hops().get(1).nodeId(), "the walk lands on the parent run, not the parent session");
        assertEquals(List.of(P1, P1), walk.principalPath());
    }

    @Test
    void spawnRowNeverUsesTheWakeEdge() {
        // D30-01: the same fact in two columns would be a second source of truth — a spawn row whose
        // session provenance exists must cross through waiting_on_run_id even if a parent_run_id
        // were (wrongly) present. Here the walk simply prefers the waiting link first.
        UUID s1 = UUID.randomUUID();
        UUID s2 = UUID.randomUUID();
        UUID r1 = UUID.randomUUID();
        UUID r2 = UUID.randomUUID();
        session(s1, null, null, null, P1);
        session(s2, Session.KIND_SPAWN, s1, r1, P1);
        run(r1, s1, ChatRun.ORIGIN_USER_SUBMISSION, null, null);
        ChatRun spawnRun = run(r2, s2, ChatRun.ORIGIN_SPAWN, r1.toString(), null);
        spawnRun.setParentRunId(r1.toString());

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(spawnRun);

        assertEquals(2, walk.hops().size());
        assertEquals(1, walk.spawnHops());
        assertEquals(DelegationChainWalker.EDGE_SPAWN, edge(walk, 1));
    }

    @Test
    void laterRunInsideASpawnSessionCrossesThroughSessionProvenance() {
        UUID s1 = UUID.randomUUID();
        UUID s2 = UUID.randomUUID();
        UUID r1 = UUID.randomUUID();
        UUID later = UUID.randomUUID();
        session(s1, null, null, null, P1);
        session(s2, Session.KIND_SPAWN, s1, r1, P1);
        run(r1, s1, ChatRun.ORIGIN_USER_SUBMISSION, null, null);
        run(later, s2, ChatRun.ORIGIN_USER_SUBMISSION, null, null);

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(runById.get(later));

        assertEquals(2, walk.hops().size(), "a user run inside a spawn session is charged to the parent tree");
        assertEquals(1, walk.spawnHops());
        assertEquals(DelegationChainWalker.EDGE_SPAWN, edge(walk, 1));
    }

    @Test
    void wokenRunInsideSpawnSessionAccumulatesBothReadings() {
        UUID s1 = UUID.randomUUID();
        UUID s2 = UUID.randomUUID();
        UUID r1 = UUID.randomUUID();
        UUID r2 = UUID.randomUUID();
        UUID woken = UUID.randomUUID();
        session(s1, null, null, null, P1);
        session(s2, Session.KIND_SPAWN, s1, r1, P2);
        run(r1, s1, ChatRun.ORIGIN_USER_SUBMISSION, null, null);
        run(r2, s2, ChatRun.ORIGIN_SPAWN, r1.toString(), null);
        run(woken, s2, "scheduled", null, r2.toString());

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(runById.get(woken));

        assertEquals(3, walk.hops().size());
        assertEquals(DelegationChainWalker.EDGE_WAKE, edge(walk, 1));
        assertEquals(DelegationChainWalker.EDGE_SPAWN, edge(walk, 2));
        assertEquals(1, walk.spawnHops(), "the in-session wake hop inherits, not adds, the delegation depth");
        assertEquals(List.of(P2, P2, P1), walk.principalPath());
    }

    @Test
    void forkSessionTerminatesTheWalk() {
        UUID sf = UUID.randomUUID();
        UUID rf = UUID.randomUUID();
        session(sf, Session.KIND_FORK, UUID.randomUUID(), UUID.randomUUID(), P1);
        run(rf, sf, ChatRun.ORIGIN_USER_SUBMISSION, null, null);

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(runById.get(rf));

        assertEquals(1, walk.hops().size(), "a fork is a new authority root — never walked through");
        assertEquals(0, walk.spawnHops());
    }

    @Test
    void sessionWalkReachesRootAndCountsSpawnDepth() {
        UUID root = UUID.randomUUID();
        UUID d1 = UUID.randomUUID();
        UUID d2 = UUID.randomUUID();
        session(root, null, null, null, P1);
        session(d1, Session.KIND_SPAWN, root, UUID.randomUUID(), P1);
        session(d2, Session.KIND_SPAWN, d1, UUID.randomUUID(), P1);

        DelegationChainWalker.ChainWalk walk = walker.walkFromSession(sessionById.get(d2));

        assertEquals(3, walk.hops().size());
        assertEquals(2, walk.spawnHops(), "the budget depth is the spawn-edge count");
        assertEquals(root, walk.hops().getLast().nodeId());
        assertEquals(List.of(P1, P1, P1), walk.principalPath());
    }

    @Test
    void missingParentRunRefusesWithAncestorMissing() {
        UUID s2 = UUID.randomUUID();
        UUID r2 = UUID.randomUUID();
        UUID gone = UUID.randomUUID();
        session(s2, Session.KIND_SPAWN, UUID.randomUUID(), gone, P1);
        run(r2, s2, ChatRun.ORIGIN_SPAWN, gone.toString(), null);

        DelegationChainWalker.AncestorMissingException thrown = assertThrows(
                DelegationChainWalker.AncestorMissingException.class,
                () -> walker.walkFromRun(runById.get(r2)));

        assertEquals(DelegationChainWalker.REASON_ANCESTOR_MISSING, thrown.reason(),
                "a hard-deleted ancestor run (session cascade) must not read as depth 0");
    }

    @Test
    void sessionWalkMissingAncestorRefusesWithAncestorMissing() {
        UUID orphan = UUID.randomUUID();
        session(orphan, Session.KIND_SPAWN, UUID.randomUUID(), UUID.randomUUID(), P1);

        DelegationChainWalker.AncestorMissingException thrown = assertThrows(
                DelegationChainWalker.AncestorMissingException.class,
                () -> walker.walkFromSession(sessionById.get(orphan)));

        assertEquals(DelegationChainWalker.REASON_ANCESTOR_MISSING, thrown.reason());
    }

    @Test
    void spawnSessionWithoutProvenanceIsTreeBroken() {
        UUID orphan = UUID.randomUUID();
        session(orphan, Session.KIND_SPAWN, null, null, P1);

        DelegationChainWalker.AncestorMissingException thrown = assertThrows(
                DelegationChainWalker.AncestorMissingException.class,
                () -> walker.walkFromSession(sessionById.get(orphan)));

        assertEquals(DelegationChainWalker.REASON_TREE_BROKEN, thrown.reason(),
                "the V40-unreachable structural break keeps the historical tree_broken audit value");
    }

    @Test
    void spawnRunWithoutWaitingLinkFallsBackToSessionProvenance() {
        UUID s1 = UUID.randomUUID();
        UUID s2 = UUID.randomUUID();
        UUID r1 = UUID.randomUUID();
        UUID r2 = UUID.randomUUID();
        session(s1, null, null, null, P1);
        session(s2, Session.KIND_SPAWN, s1, r1, P1);
        run(r1, s1, ChatRun.ORIGIN_USER_SUBMISSION, null, null);
        run(r2, s2, ChatRun.ORIGIN_SPAWN, null, null);

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(runById.get(r2));

        assertEquals(2, walk.hops().size(), "a pre-V52 spawn row (no waiting link) still crosses via V40 provenance");
        assertEquals(1, walk.spawnHops());
    }

    @Test
    void cyclicRunChainRefusesAsTreeBroken() {
        UUID s1 = UUID.randomUUID();
        UUID ra = UUID.randomUUID();
        UUID rb = UUID.randomUUID();
        session(s1, null, null, null, P1);
        run(ra, s1, "scheduled", null, rb.toString());
        run(rb, s1, "scheduled", null, ra.toString());

        DelegationChainWalker.AncestorMissingException thrown = assertThrows(
                DelegationChainWalker.AncestorMissingException.class,
                () -> walker.walkFromRun(runById.get(ra)));

        assertEquals(DelegationChainWalker.REASON_TREE_BROKEN, thrown.reason(),
                "a parent_run_id cycle is a broken tree, capped without unbounded recursion");
    }

    // ------------------------------------------------------------------ T3.3 the principal cycle key

    /**
     * T3.3: the cycle key is the principal of the agent that RAN each hop — the responder stamp on
     * {@code chat_runs.agent_principal_id}, not the session PRIMARY. A session keeps its PRIMARY
     * while its wake runs carry each responder's stamp, so the session reading alone would let two
     * non-primary participants ping-pong forever (A→B→C→B is invisible when every hop reads the
     * same session principal).
     */
    @Test
    void wokenRunResponderPrincipalIsTheCycleKey() {
        UUID s1 = UUID.randomUUID();
        UUID r1 = UUID.randomUUID();
        UUID rb = UUID.randomUUID();
        UUID rc = UUID.randomUUID();
        session(s1, null, null, null, P1);
        run(r1, s1, ChatRun.ORIGIN_USER_SUBMISSION, null, null);
        ChatRun bRun = run(rb, s1, "chain", null, r1.toString());
        bRun.setAgentPrincipalId(UUID.fromString("00000000-0000-0000-0000-0000000000b0"));
        ChatRun cRun = run(rc, s1, "chain", null, rb.toString());
        cRun.setAgentPrincipalId(UUID.fromString("00000000-0000-0000-0000-0000000000c0"));

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(runById.get(rc));

        assertEquals(List.of("00000000-0000-0000-0000-0000000000c0",
                        "00000000-0000-0000-0000-0000000000b0", P1),
                walk.principalPath(),
                "each hop reads WHO RAN it — the durable material for the C→B refusal");
    }

    /**
     * T3.3: the case the participantId key could never see (design §3.2) — the SAME principal on two
     * sessions of the path. A spawn child inherits the parent's principal, so a wake run inside the
     * child session reads the parent's principal again: the walk surfaces the duplicate, and the
     * wake-chain consumer refuses it.
     */
    @Test
    void samePrincipalAcrossSpawnedSessionsIsVisibleOnThePath() {
        UUID s1 = UUID.randomUUID();
        UUID s2 = UUID.randomUUID();
        UUID r1 = UUID.randomUUID();
        UUID r2 = UUID.randomUUID();
        UUID sharedPrincipal = UUID.randomUUID();
        session(s1, null, null, null, sharedPrincipal.toString());
        // The spawn child session inherits the parent's principal (design §5.1: same subject).
        session(s2, Session.KIND_SPAWN, s1, r1, sharedPrincipal.toString());
        ChatRun rootRun = run(r1, s1, ChatRun.ORIGIN_USER_SUBMISSION, null, null);
        rootRun.setAgentPrincipalId(sharedPrincipal);
        ChatRun childRun = run(r2, s2, ChatRun.ORIGIN_SPAWN, r1.toString(), null);
        childRun.setAgentPrincipalId(sharedPrincipal);

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(runById.get(r2));

        assertEquals(List.of(sharedPrincipal.toString(), sharedPrincipal.toString()),
                walk.principalPath(),
                "the same principal on both sessions of the path — the consumer refuses this hop");
    }

    /**
     * PLAN-0689 A3b (design §2): attribution falls back run → NULL and never guesses the Session's
     * PRIMARY row. An unstamped run therefore stays unattributed even when its Session still
     * carries a binding — the old M2 "responder fallback" reading is exactly what §2 forbids.
     */
    @Test
    void runWithoutResponderPrincipalStaysUnattributed() {
        UUID s1 = UUID.randomUUID();
        UUID r1 = UUID.randomUUID();
        UUID r2 = UUID.randomUUID();
        session(s1, null, null, null, P1);
        ChatRun rootRun = run(r1, s1, ChatRun.ORIGIN_USER_SUBMISSION, null, null);
        rootRun.setAgentPrincipalId(null);
        ChatRun woken = run(r2, s1, "chain", null, r1.toString());
        woken.setAgentPrincipalId(null);

        DelegationChainWalker.ChainWalk walk = walker.walkFromRun(woken);

        assertEquals(2, walk.principalPath().size());
        assertNull(walk.principalPath().get(0),
                "an unstamped hop must not borrow the Session's PRIMARY principal");
        assertNull(walk.principalPath().get(1),
                "the root reading stays null so the consumer fails closed with root_principal_missing");
    }
}
