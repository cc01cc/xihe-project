package com.cc01cc.p.xihe.cp.chat;

import java.util.LinkedHashSet;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * PLAN-0624 M3 (D24: chain carrier): the in-memory wake-chain registry.
 *
 * <p>{@code runId → ChainNode} where the node records the root wake round, the chain depth at
 * that run, and every participant already awakened along this path (cycle key = participantId).
 * This is deliberately runtime-only: PLAN-0630 / BL-192 will persist the delegation edges, and
 * {@link ChainNode}'s record shape is the upgrade seam (add the edge id, swap the map for a
 * store — callers do not change).</p>
 */
public final class WakeChainRegistry {

    /**
     * One run's position in a wake chain. {@code awakened} is PATH-scoped: it carries only the
     * participants woken along this branch, so two branches of the same root never false-positive
     * each other, and a genuine cycle (A→B→A) is caught on the same path.
     */
    public record ChainNode(String rootWakeRoundId, int depth, Set<UUID> awakened) {

        public ChainNode {
            awakened = Set.copyOf(awakened);
        }

        /** The node for a run this participant's output would wake next. */
        public ChainNode child(UUID childParticipantId) {
            Set<UUID> next = new LinkedHashSet<>(awakened);
            next.add(childParticipantId);
            return new ChainNode(rootWakeRoundId, depth + 1, next);
        }

        public boolean wouldCycle(UUID participantId) {
            return awakened.contains(participantId);
        }
    }

    private final ConcurrentMap<String, ChainNode> nodes = new ConcurrentHashMap<>();

    /** A run that has no node is a user-rooted run: its agent mentions open depth-1 chains. */
    public Optional<ChainNode> nodeFor(String runId) {
        return Optional.ofNullable(nodes.get(runId));
    }

    public void register(String runId, ChainNode node) {
        nodes.put(runId, node);
    }

    /** Test/observer seam. */
    int size() {
        return nodes.size();
    }
}
