package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.WorkspaceJobHistory;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface WorkspaceJobHistoryRepository extends JpaRepository<WorkspaceJobHistory, UUID> {

    @Query("select coalesce(max(h.sequence), 0) from WorkspaceJobHistory h where h.jobId = :jobId")
    long findMaxSequence(@Param("jobId") UUID jobId);

    List<WorkspaceJobHistory> findByJobIdOrderBySequenceAsc(UUID jobId);
}
