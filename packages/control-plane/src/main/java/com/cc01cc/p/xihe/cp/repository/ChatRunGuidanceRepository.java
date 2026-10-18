package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ChatRunGuidance;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

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

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select g from ChatRunGuidance g where g.id = :id")
    Optional<ChatRunGuidance> findByIdForUpdate(@Param("id") UUID id);

    List<ChatRunGuidance> findByRunIdInAndStatus(List<UUID> runIds, String status);
}
