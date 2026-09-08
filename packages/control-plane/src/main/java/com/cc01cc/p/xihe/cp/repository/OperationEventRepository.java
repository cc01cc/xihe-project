package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.OperationEvent;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface OperationEventRepository extends JpaRepository<OperationEvent, UUID> {

    List<OperationEvent> findByOperationIdOrderBySequenceAsc(String operationId);

    List<OperationEvent> findByItemIdOrderBySequenceAsc(String itemId);

    List<OperationEvent> findByAttemptIdOrderBySequenceAsc(String attemptId);
}
