package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.PolicyRevisionEntity;
import com.cc01cc.p.xihe.cp.repository.PolicyRevisionRepository;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.stereotype.Component;

/**
 * Durable policy revision (PLAN-0328 T1.7): the {@code seq} of the single-row
 * {@code policy_revision} counter, bumped atomically by every rule/face mutation — including
 * deletes. The previous {@code max(updated_at)} derivation missed non-newest deletions, so a
 * tightening delete did not invalidate session fingerprints or once grants.
 *
 * <p>Consumers compare an equality on the value recorded at grant time
 * ({@code approval_requests.policy_revision}, {@link SessionPolicyState.Grant#policyRevision()}):
 * any mutation makes the stored value stale and the grant is rejected at consume time. Missing
 * counter row therefore fails closed via {@link #ABSENT} — no persisted revision can equal it.</p>
 *
 * <p>The read is cached (single entry, keyed by {@link PolicyVersion#current()}) so a hot gate
 * path does not hit the database per call; {@link #bump()} advances the durable counter and bumps
 * the same {@link PolicyVersion}, so writers invalidate both the DB snapshot cache and this one.</p>
 */
@Component
public class PolicyRevision {

    /**
     * Fail-closed sentinel for a missing counter row: real revisions start at 0 and only grow, so
     * no stored grant revision can equal it and every consume comparison rejects.
     */
    public static final long ABSENT = Long.MIN_VALUE;

    private final PolicyRevisionRepository counter;
    private final PolicyVersion version;
    private final AtomicReference<Cached> cache = new AtomicReference<>();

    public PolicyRevision(PolicyRevisionRepository counter, PolicyVersion version) {
        this.counter = counter;
        this.version = version;
    }

    /** Current durable revision, or {@link #ABSENT} when the counter row is missing. */
    public long current() {
        long currentVersion = version.current();
        Cached cached = cache.get();
        if (cached != null && cached.version() == currentVersion) {
            return cached.revision();
        }
        long revision = load();
        cache.set(new Cached(currentVersion, revision));
        return revision;
    }

    /**
     * Atomically advances the durable counter and invalidates the caches keyed by
     * {@link PolicyVersion}. Fails closed when the counter row is missing: the exception aborts the
     * caller's transaction so a mutation can never be persisted without its revision bump.
     */
    public void bump() {
        int updated = counter.bump(PolicyRevisionEntity.SINGLETON_ID, Instant.now());
        if (updated != 1) {
            throw new IllegalStateException("policy_revision counter row is missing; mutation aborted");
        }
        version.bump();
    }

    private long load() {
        return counter.currentSeq(PolicyRevisionEntity.SINGLETON_ID).orElse(ABSENT);
    }

    private record Cached(long version, long revision) {}
}
