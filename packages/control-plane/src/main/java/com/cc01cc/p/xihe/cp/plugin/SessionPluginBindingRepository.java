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
     * The session's <b>catalog version</b> (PLAN-0691 T1.6): the highest revision ever handed out for
     * this session.
     *
     * <p>It is a sequence rather than a stored counter because {@code revision} already is one:
     * every catalog change takes the next value of this high-water mark (fresh attach 1, detach 2,
     * re-attach 3; a second binding attached into the same session takes 2) — see
     * {@link SessionPluginBinding#detach} and {@code PluginBindingService#nextCatalogRevision}.
     * The API exposes it as {@code PluginAttachResult.catalogVersion} and the SSE
     * {@code plugin_binding} event announces that it moved; no second column, hence no migration.</p>
     */
    @Query("select coalesce(max(a.revision), 0) from SessionPluginBinding a"
            + " where a.sessionId = :sessionId")
    int maxRevision(@Param("sessionId") UUID sessionId);
}
