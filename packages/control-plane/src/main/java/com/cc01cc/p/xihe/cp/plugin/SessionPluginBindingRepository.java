package com.cc01cc.p.xihe.cp.plugin;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0691 T1.2 (V136 / DP-6): per-session frozen snapshots.
 *
 * <p>Detached rows stay in the table (they are evidence), so every read that means "currently
 * attached" must filter {@code detachedAt is null} — the finder name carries that predicate instead
 * of leaving it to the caller.</p>
 */
@Repository
public interface SessionPluginBindingRepository
        extends JpaRepository<SessionPluginBinding, SessionPluginBinding.AttachmentKey> {

    List<SessionPluginBinding> findBySessionIdAndDetachedAtIsNullOrderByAttachedAtAsc(
            UUID sessionId);

    Optional<SessionPluginBinding> findBySessionIdAndBindingId(UUID sessionId, UUID bindingId);

    long countByBindingId(UUID bindingId);

    /**
     * T1.6 owns the real {@code catalogVersion} sequence; until it lands, the per-session counter is
     * the highest revision ever handed out, which is monotonic and honest about being a skeleton.
     */
    @Query("select coalesce(max(a.revision), 0) from SessionPluginBinding a"
            + " where a.sessionId = :sessionId")
    int maxRevision(@Param("sessionId") UUID sessionId);
}
