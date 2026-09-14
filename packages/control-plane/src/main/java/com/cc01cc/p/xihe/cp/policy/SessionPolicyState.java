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
 * Session-scoped policy state: the active mode and the in-session rule set
 * (PLAN-0328 spec §4.1 L4 / §7 模式).
 *
 * <p>Two invariants from the spec:</p>
 * <ul>
 *   <li><b>不落库</b>：mode switches and session rules are memory-only (decision #28/#29)；</li>
 *   <li><b>不外溢</b>：session rules never become workspace rules, and are dropped when the
 *       session ends or the state expires.</li>
 * </ul>
 */
@Component
public class SessionPolicyState {

    /** Supported modes; `plan` denies writes, `managed` only honours INSTANCE rules. */
    public static final Set<String> MODES = Set.of(
            LayeredPolicyResolver.MODE_DEFAULT,
            LayeredPolicyResolver.MODE_ACCEPT_EDITS,
            LayeredPolicyResolver.MODE_BYPASS,
            "plan",
            LayeredPolicyResolver.MODE_MANAGED);

    /** Session state is short-lived: a stale entry must never keep granting (or bypassing). */
    static final Duration TTL = Duration.ofHours(12);

    public record Entry(String mode, List<PolicyRule> rules, Instant updatedAt) {}

    private final Map<String, Entry> sessions = new ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicLong seq = new java.util.concurrent.atomic.AtomicLong();

    public Optional<String> modeOf(String sessionId) {
        Entry entry = live(sessionId);
        return entry == null ? Optional.empty() : Optional.ofNullable(entry.mode());
    }

    public void setMode(String sessionId, String mode) {
        if (sessionId == null || sessionId.isBlank()) {
            return;
        }
        if (mode == null || !MODES.contains(mode)) {
            throw new IllegalArgumentException("unsupported policy mode: " + mode);
        }
        sessions.compute(sessionId, (key, existing) -> new Entry(mode,
                existing == null ? List.of() : existing.rules(), Instant.now()));
    }

    public List<PolicyRule> rulesOf(String sessionId) {
        Entry entry = live(sessionId);
        return entry == null ? List.of() : entry.rules();
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
            return new Entry(existing == null ? null : existing.mode(), List.copyOf(rules), Instant.now());
        });
    }

    /** Drops all state for a session (session deletion / rebind / workspace switch). */
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
        Entry entry = sessions.get(sessionId);
        if (entry == null) {
            return null;
        }
        if (entry.updatedAt().isBefore(Instant.now().minus(TTL))) {
            sessions.remove(sessionId, entry);
            return null;
        }
        return entry;
    }
}
