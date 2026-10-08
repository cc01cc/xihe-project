package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ApprovalHistory;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface ApprovalHistoryRepository extends JpaRepository<ApprovalHistory, UUID> {

    @Query("select coalesce(max(h.sequence), 0) from ApprovalHistory h where h.requestId = :requestId")
    long findMaxSequence(@Param("requestId") UUID requestId);

    List<ApprovalHistory> findByRequestIdOrderBySequenceAsc(UUID requestId);

    List<ApprovalHistory> findByRunIdOrderByCreatedAtAsc(UUID runId);
}
