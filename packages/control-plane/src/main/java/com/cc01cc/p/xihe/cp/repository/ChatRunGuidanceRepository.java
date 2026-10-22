package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ChatRunGuidance;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ChatRunGuidanceRepository extends JpaRepository<ChatRunGuidance, UUID> {

    Optional<ChatRunGuidance> findByRunIdAndIdempotencyKey(UUID runId, String idempotencyKey);

    List<ChatRunGuidance> findByRunIdOrderBySequenceAsc(UUID runId);

    List<ChatRunGuidance> findByRunIdAndStatusOrderBySequenceAsc(UUID runId, String status);

    Optional<ChatRunGuidance> findByIdAndRunId(UUID id, UUID runId);

    @Query("select coalesce(max(g.sequence), 0) from ChatRunGuidance g where g.runId = :runId")
    long findMaxSequence(@Param("runId") UUID runId);

    List<ChatRunGuidance> findByRunIdInAndStatus(List<UUID> runIds, String status);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update ChatRunGuidance g set g.status = 'consumed', g.consumedAt = :now, g.updatedAt = :now "
            + "where g.id = :id and g.runId = :runId and g.status = 'pending'")
    int markConsumedIfPending(@Param("id") UUID id, @Param("runId") UUID runId,
                              @Param("now") Instant now);

    @Modifying(clearAutomatically = false)
    @Query("update ChatRunGuidance g set g.status = 'terminal_expired', "
            + "g.terminalExpiredAt = :now, g.updatedAt = :now "
            + "where g.runId = :runId and g.status = 'pending'")
    int markTerminalExpiredForRun(@Param("runId") UUID runId, @Param("now") Instant now);

    @Modifying(clearAutomatically = false)
    @Query("update ChatRunGuidance g set g.status = 'terminal_expired', "
            + "g.terminalExpiredAt = :now, g.updatedAt = :now "
            + "where g.status = 'pending' and g.runId in "
            + "(select r.id from ChatRun r where r.status in :terminalStatuses)")
    int markTerminalExpiredForTerminalRuns(@Param("terminalStatuses") Collection<String> terminalStatuses,
                                           @Param("now") Instant now);
}
