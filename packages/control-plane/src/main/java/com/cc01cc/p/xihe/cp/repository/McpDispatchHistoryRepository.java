package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.McpDispatchHistory;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

public interface McpDispatchHistoryRepository extends JpaRepository<McpDispatchHistory, UUID> {

    @Query("select coalesce(max(h.sequence), 0) from McpDispatchHistory h "
            + "where h.invocationId = :invocationId")
    long findMaxSequence(@Param("invocationId") UUID invocationId);

    List<McpDispatchHistory> findByInvocationIdOrderBySequenceAsc(UUID invocationId);

    @Modifying
    @Transactional
    @Query("delete from McpDispatchHistory h where h.invocationId in "
            + "(select i.id from McpInvocation i where i.sessionId = :sessionId)")
    int deleteBySessionId(@Param("sessionId") String sessionId);
}
