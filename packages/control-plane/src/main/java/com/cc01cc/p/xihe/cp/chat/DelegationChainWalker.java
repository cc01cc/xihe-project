package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0630 M2 (T2.7/T2.8): the single durable-chain walk behind both delegation gates.
 *
 * <p>One walk, two readings, both fail-closed (design §3.1): the path yields every hop
 * ({@code hops}), the spawn-edge count ({@code spawnHops}, the delegation depth the budget gate
 * consumes), and the principal of every hop on the path ({@code principalPath}, nearest-first,
 * the M3 cycle key — run responder first, the hop Session's PRIMARY participant as fallback). The
 * walk never persists anything — each derivation computes it fresh
 * (&le; 10 hops, one primary-key read per hop).</p>
 *
 * <p><b>Edge semantics</b> (design §2.1/§3.3): a spawn run carries its parent on
 * {@code waiting_on_run_id} (never on {@code parent_run_id} — one fact, one column); a chain/judge
 * wake run carries it on {@code parent_run_id}; a later (user or wake) run inside a spawn session
 * crosses through the session provenance ({@code spawned_from_run_id}); a fork session is an
 * authority root and terminates the walk.</p>
 *
 * <p><b>Missing ancestors refuse the derivation</b> (D30-08): a referenced run/session row that no
 * longer exists throws {@link AncestorMissingException} with reason {@code ancestor_missing} —
 * shared by the spawn budget gate and the wake chain, so both paths audit the same refusal. A
 * structurally broken link (spawn provenance the V40 CHECK should have made impossible) reports
 * {@code tree_broken}, preserving the pre-walker budget behavior for that unreachable shape.</p>
 */
public final class DelegationChainWalker {

    /** Anti-footgun rail: a pathological or cyclic tree can never outrun the gate. */
    static final int MAX_TRAVERSAL_NODES = 512;

    static final String EDGE_NONE = "none";
    static final String EDGE_SPAWN = "spawn";
    static final String EDGE_WAKE = "wake";

    static final String REASON_ANCESTOR_MISSING = "ancestor_missing";
    static final String REASON_TREE_BROKEN = "tree_broken";

    private final SessionRepository sessionRepository;
    private final ChatRunRepository chatRunRepository;
    private final SessionParticipantRepository participantRepository;

    public DelegationChainWalker(SessionRepository sessionRepository,
                                 ChatRunRepository chatRunRepository,
                                 SessionParticipantRepository participantRepository) {
        this.sessionRepository = sessionRepository;
        this.chatRunRepository = chatRunRepository;
        this.participantRepository = participantRepository;
    }

    /**
     * One visited chain node, nearest-first. {@code nodeId} is the visited session id for
     * {@link #walkFromSession} and the visited run id for {@link #walkFromRun}; {@code edge} is the
     * edge traversed to reach it ({@link #EDGE_NONE} for the start node, otherwise
     * {@link #EDGE_SPAWN} or {@link #EDGE_WAKE}).
     */
    public record Hop(UUID nodeId, UUID sessionId, String edge, String principalId) {}

    /**
     * The walked path: every hop nearest-first, the number of spawn edges on it (the delegation
     * depth), and — nearest-first, the M3 cycle key — the principal of the agent that <b>ran</b>
     * each hop ({@code chat_runs.agent_principal_id}, the responder stamp), falling back to the
     * hop Session's {@code session_participants} PRIMARY principal when the run carries no responder
     * (pre-V92 rows, human turns). Null entries mark hops where neither principal exists.
     */
    public record ChainWalk(List<Hop> hops, int spawnHops, List<String> principalPath) {}

    /**
     * The shared fail-closed signal (T2.8): the chain points at a row that no longer exists, or is
     * structurally broken. {@link #reason()} distinguishes the durable audit value.
     */
    public static final class AncestorMissingException extends RuntimeException {

        private final String reason;

        private AncestorMissingException(String reason, String detail) {
            super(detail);
            this.reason = reason;
        }

        /** {@link #REASON_ANCESTOR_MISSING} (referenced row gone) or {@link #REASON_TREE_BROKEN}. */
        public String reason() {
            return reason;
        }
    }

    /**
     * Session-edge walk: from a session up through {@code kind='spawn'} provenance to the authority
     * root (the first session whose kind is not {@code spawn} — a fork terminates here too). This is
     * the exact walk {@code DelegationBudgetService.walkToRoot} used to inline; its {@code spawnHops}
     * is the parent's delegation depth.
     */
    public ChainWalk walkFromSession(Session start) {
        List<Hop> hops = new ArrayList<>();
        List<String> principalPath = new ArrayList<>();
        Set<UUID> visited = new HashSet<>();
        Session current = start;
        String edge = EDGE_NONE;
        int spawnHops = 0;
        while (true) {
            if (!visited.add(current.getId()) || hops.size() >= MAX_TRAVERSAL_NODES) {
                throw broken("session cycle or traversal cap at " + current.getId());
            }
            String sessionPrincipalId = participantRepository.primaryPrincipalId(current.getId())
                    .map(UUID::toString).orElse(null);
            hops.add(new Hop(current.getId(), current.getId(), edge, sessionPrincipalId));
            principalPath.add(sessionPrincipalId);
            if (!Session.KIND_SPAWN.equals(current.getKind())) {
                break;
            }
            UUID up = current.getSpawnedFromSessionId();
            if (up == null) {
                // V40's CHECK makes this unreachable in practice; fail closed exactly like the gate did.
                throw broken("spawn session without provenance " + current.getId());
            }
            current = sessionRepository.findById(up)
                    .orElseThrow(() -> missing("spawn ancestor session " + up));
            edge = EDGE_SPAWN;
            spawnHops++;
        }
        // PLAN-0689 A3b: principalPath may now legitimately hold nulls (an unstamped run stays
        // unattributed) and List.copyOf rejects null elements — wrap the private copy instead.
        return new ChainWalk(List.copyOf(hops), spawnHops,
                java.util.Collections.unmodifiableList(principalPath));
    }

    /**
     * Run-edge walk: from a run up through the durable edges ({@code parent_run_id} wake edges,
     * {@code waiting_on_run_id} spawn edges, and — for a later run inside a spawn session — the
     * session provenance) to the root run. {@code hops} counts every edge (the wake-depth reading),
     * {@code spawnHops} the spawn edges (the delegation-depth reading).
     */
    public ChainWalk walkFromRun(ChatRun start) {
        List<Hop> hops = new ArrayList<>();
        List<String> principalPath = new ArrayList<>();
        Set<UUID> visited = new HashSet<>();
        ChatRun current = start;
        String edge = EDGE_NONE;
        int spawnHops = 0;
        while (true) {
            if (!visited.add(current.getId()) || hops.size() >= MAX_TRAVERSAL_NODES) {
                throw broken("run cycle or traversal cap at " + current.getId());
            }
            UUID sessionId = UUID.fromString(current.getSessionId());
            Session session = sessionRepository.findById(sessionId)
                    .orElseThrow(() -> missing("run session " + sessionId));
            // T3.3: the cycle key is WHO RAN the hop, not the session PRIMARY. A session keeps its
            // PRIMARY principal while its wake runs carry each responder's stamp, so the session
            // reading alone would let two non-primary participants ping-pong forever (A→B→C→B is
            // invisible when every hop reads the same session principal).
            // PLAN-0689 A3b (T1.3 / design §2): the old responder fallback onto the Session's
            // PRIMARY is gone — an unstamped run stays unattributed (run → NULL, never guess
            // PRIMARY). Both root-principal readers already fail closed on the resulting null.
            UUID runPrincipalId = current.getAgentPrincipalId();
            String principalId = runPrincipalId == null ? null : runPrincipalId.toString();
            hops.add(new Hop(current.getId(), sessionId, edge, principalId));
            principalPath.add(principalId);
            String parentRunId;
            String nextEdge;
            if (ChatRun.ORIGIN_SPAWN.equals(current.getOrigin())) {
                // design §3.3: the spawn row's parent lives on waiting_on_run_id.
                parentRunId = current.getWaitingOnRunId();
                if (parentRunId == null) {
                    // Pre-V52 rows never got the waiting link; the session provenance (V40) still knows.
                    UUID fromRun = session.getSpawnedFromRunId();
                    parentRunId = fromRun == null ? null : fromRun.toString();
                }
                if (parentRunId == null) {
                    throw broken("spawn run without a waiting link " + current.getId());
                }
                nextEdge = EDGE_SPAWN;
            } else if (current.getParentRunId() != null) {
                parentRunId = current.getParentRunId();
                nextEdge = EDGE_WAKE;
            } else if (Session.KIND_SPAWN.equals(session.getKind())) {
                // A user/wake run created later inside a spawn session: the run itself has no upward
                // edge, so cross through the session provenance (same fact the spawn row carries).
                UUID fromRun = session.getSpawnedFromRunId();
                if (fromRun == null) {
                    throw broken("spawn session without provenance " + sessionId);
                }
                parentRunId = fromRun.toString();
                nextEdge = EDGE_SPAWN;
            } else {
                break;
            }
            final String ancestorRef = parentRunId;
            current = chatRunRepository.findById(UUID.fromString(ancestorRef))
                    .orElseThrow(() -> missing("ancestor run " + ancestorRef));
            edge = nextEdge;
            if (EDGE_SPAWN.equals(nextEdge)) {
                spawnHops++;
            }
        }
        // PLAN-0689 A3b: principalPath may now legitimately hold nulls (an unstamped run stays
        // unattributed) and List.copyOf rejects null elements — wrap the private copy instead.
        return new ChainWalk(List.copyOf(hops), spawnHops,
                java.util.Collections.unmodifiableList(principalPath));
    }

    private static AncestorMissingException missing(String detail) {
        return new AncestorMissingException(REASON_ANCESTOR_MISSING, detail);
    }

    private static AncestorMissingException broken(String detail) {
        return new AncestorMissingException(REASON_TREE_BROKEN, detail);
    }
}
