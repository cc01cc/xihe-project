package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.OperationEvent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface OperationEventRepository extends JpaRepository<OperationEvent, UUID> {

    List<OperationEvent> findByOperationIdOrderBySequenceAsc(String operationId);

    List<OperationEvent> findByItemIdOrderBySequenceAsc(String itemId);

    List<OperationEvent> findByAttemptIdOrderBySequenceAsc(String attemptId);

    /** PLAN-0317 决策 #7②：只取聚合值，替代逐条加载全表求 max。 */
    @Query("select coalesce(max(e.sequence), -1) from OperationEvent e where e.operationId = :operationId")
    long findMaxSequence(@Param("operationId") String operationId);
}
