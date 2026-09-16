package com.cc01cc.p.xihe.cp.policy;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Session-scoped policy state: the active mode, the in-session rule set (PLAN-0328 spec §4.1 L4 /
 * §7 模式), and the T1.7 exact-invocation reuse grants.
 *
 * <p>Three invariants from the spec:</p>
 * <ul>
 *   <li><b>不落库</b>：mode switches, session rules and reuse grants are memory-only
 *       (decision #28/#29);</li>
 *   <li><b>不外溢</b>：session state never becomes a workspace rule, and is dropped when the
 *       session ends or the state expires;</li>
 *   <li><b>精确指纹</b>：a session reuse grant is bound to one tool + one canonical
 *       {@code arguments_hash} — never a coarse "whole action class" allow (decision #27).</li>
 * </ul>
 */
@Component
public class SessionPolicyState {

    /** Supported modes for the current session. */
    public static final Set<String> MODES = Set.of(
            LayeredPolicyResolver.MODE_MANUAL,
            LayeredPolicyResolver.MODE_AUTO);

    /** Session state is short-lived: a stale entry must never keep granting (or bypassing). */
    static final Duration TTL = Duration.ofHours(12);

    /** Most recent reuse grants kept per session; older fingerprints fall out (fail-closed). */
    static final int MAX_GRANTS_PER_SESSION = 64;

    /** Opportunistic sweep cadence: every Nth lookup expired entries are dropped. */
    private static final long SWEEP_INTERVAL = 64;

    /** One exact-invocation session grant (T1.7): tool + canonical arguments hash, plus the
     * decision-time mode/revision/generation that must still hold when it is reused. */
    public record Grant(String argumentsHash, String tool, String modeAtGrant, long policyRevision,
                        int sandboxGeneration, Instant grantedAt) {}

    public record Entry(String mode, List<PolicyRule> rules, List<Grant> grants, Instant updatedAt) {
        public Entry {
            rules = rules == null ? List.of() : List.copyOf(rules);
            grants = grants == null ? List.of() : List.copyOf(grants);
        }

        /** Backwards-compatible view for callers that only care about mode + rules. */
        public Entry(String mode, List<PolicyRule> rules, Instant updatedAt) {
            this(mode, rules, List.of(), updatedAt);
        }
    }

    private final Map<String, Entry> sessions = new ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicLong seq = new java.util.concurrent.atomic.AtomicLong();
    private final java.util.concurrent.atomic.AtomicLong accesses = new java.util.concurrent.atomic.AtomicLong();
    private final Duration ttl;

    public SessionPolicyState() {
        this(TTL);
    }

    /** Package-private for tests: a tiny TTL makes the expiration sweep observable. */
    SessionPolicyState(Duration ttl) {
        this.ttl = ttl;
    }

    public Optional<String> modeOf(String sessionId) {
        return snapshot(sessionId).map(Entry::mode);
    }

    public void setMode(String sessionId, String mode) {
        if (sessionId == null || sessionId.isBlank()) {
            return;
        }
        if (mode == null || !MODES.contains(mode)) {
            throw new IllegalArgumentException("unsupported policy mode: " + mode);
        }
        sessions.compute(sessionId, (key, existing) -> new Entry(mode,
                existing == null ? List.of() : existing.rules(),
                existing == null ? List.of() : existing.grants(),
                Instant.now()));
    }

    public List<PolicyRule> rulesOf(String sessionId) {
        return snapshot(sessionId).map(Entry::rules).orElse(List.of());
    }

    /** Returns one coherent live entry for callers that need mode, rules and grants together. */
    public Optional<Entry> snapshot(String sessionId) {
        return Optional.ofNullable(live(sessionId));
    }

    /** Adds a rule granted for this session only ("本会话允许"). */
    public void addRule(String sessionId, PolicyRule rule) {
        if (sessionId == null || sessionId.isBlank() || rule == null) {
            return;
        }
        sessions.compute(sessionId, (key, existing) -> {
            List<PolicyRule> rules = new java.util.ArrayList<>(existing == null ? List.of() : existing.rules());
            rules.add(new PolicyRule(rule.actionClass(), rule.resource(), rule.effect(),
                    rule.priority(), rule.locked(), seq.getAndIncrement()));
            return new Entry(existing == null ? null : existing.mode(), List.copyOf(rules),
                    existing == null ? List.of() : existing.grants(), Instant.now());
        });
    }

    /** Records one exact-invocation reuse grant for the session tier (T1.7). */
    public void addGrant(String sessionId, Grant grant) {
        if (sessionId == null || sessionId.isBlank() || grant == null
                || grant.argumentsHash() == null || grant.argumentsHash().isBlank()
                || grant.tool() == null || grant.tool().isBlank()
                || grant.grantedAt() == null) {
            return;
        }
        sessions.compute(sessionId, (key, existing) -> {
            List<Grant> grants = new java.util.ArrayList<>(existing == null ? List.of() : existing.grants());
            grants.removeIf(item -> grant.tool().equals(item.tool())
                    && grant.argumentsHash().equals(item.argumentsHash()));
            grants.add(grant);
            if (grants.size() > MAX_GRANTS_PER_SESSION) {
                grants = new java.util.ArrayList<>(
                        grants.subList(grants.size() - MAX_GRANTS_PER_SESSION, grants.size()));
            }
            return new Entry(existing == null ? null : existing.mode(),
                    existing == null ? List.of() : existing.rules(), grants, Instant.now());
        });
    }

    /** Exact reuse lookup: most recent grant for (tool, canonical arguments hash), if any. */
    public Optional<Grant> grantOf(String sessionId, String tool, String argumentsHash) {
        if (tool == null || argumentsHash == null) {
            return Optional.empty();
        }
        Entry entry = live(sessionId);
        if (entry == null) {
            return Optional.empty();
        }
        List<Grant> grants = entry.grants();
        for (int i = grants.size() - 1; i >= 0; i--) {
            Grant grant = grants.get(i);
            if (tool.equals(grant.tool()) && argumentsHash.equals(grant.argumentsHash())) {
                return Optional.of(grant);
            }
        }
        return Optional.empty();
    }

    /** Drops all state for a session when it is deleted. */
    public void clear(String sessionId) {
        if (sessionId != null) {
            sessions.remove(sessionId);
        }
    }

    int size() {
        return sessions.size();
    }

    private Entry live(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            return null;
        }
        if (accesses.incrementAndGet() % SWEEP_INTERVAL == 0) {
            sweepExpired();
        }
        Entry entry = sessions.get(sessionId);
        if (entry == null) {
            return null;
        }
        if (entry.updatedAt().isBefore(Instant.now().minus(ttl))) {
            sessions.remove(sessionId, entry);
            return null;
        }
        return entry;
    }

    /** Opportunistic sweep: drop entries never touched again so the map cannot grow unbounded. */
    private void sweepExpired() {
        Instant cutoff = Instant.now().minus(ttl);
        sessions.entrySet().removeIf(entry -> entry.getValue().updatedAt().isBefore(cutoff));
    }
}
