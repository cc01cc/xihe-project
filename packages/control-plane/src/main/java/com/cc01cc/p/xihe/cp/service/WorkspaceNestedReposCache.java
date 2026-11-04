package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PLAN-0641 T2.3 (contract §3): CP-side TTL cache for the nested-repos discovery
 * read face. Warmed by the classify-only path after primary-root captures (F1
 * warm) and by cold probes; evicted when a workspace root is declared /
 * patched / deleted so {@code declared} labels re-project immediately. No
 * durable state — a restart simply re-probes. TTL is a constant, not an env
 * knob (contract §3).
 */
@Component
public class WorkspaceNestedReposCache {

    /** Short TTL per contract §3 (30 s); a cache hit means zero Runtime calls. */
    static final Duration TTL = Duration.ofSeconds(30);

    /** Immutable snapshot of one cached answer. */
    public record Entry(Instant cachedAt, List<RuntimeCheckpointClient.NestedRepoItem> items) {}

    private final Map<String, Entry> entries = new ConcurrentHashMap<>();

    public Optional<Entry> getFresh(String workspaceId) {
        Entry entry = entries.get(workspaceId);
        if (entry == null || entry.cachedAt().plus(TTL).isBefore(Instant.now())) {
            return Optional.empty();
        }
        return Optional.of(entry);
    }

    public void put(String workspaceId, List<RuntimeCheckpointClient.NestedRepoItem> items) {
        putAt(workspaceId, items, Instant.now());
    }

    /**
     * Test hook: stamp an arbitrary {@code cachedAt} so TTL expiry is verifiable
     * without sleeping (workspace rule: no fixed sleeps in tests).
     */
    void putAt(String workspaceId, List<RuntimeCheckpointClient.NestedRepoItem> items, Instant cachedAt) {
        entries.put(workspaceId, new Entry(cachedAt, List.copyOf(items)));
    }

    public void evict(String workspaceId) {
        entries.remove(workspaceId);
    }
}
