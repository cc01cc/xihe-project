package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ChatRunHistory;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface ChatRunHistoryRepository extends JpaRepository<ChatRunHistory, UUID> {

    @Query("select coalesce(max(h.sequence), 0) from ChatRunHistory h where h.runId = :runId")
    long findMaxSequence(@Param("runId") UUID runId);

    List<ChatRunHistory> findByRunIdOrderBySequenceAsc(UUID runId);
}
