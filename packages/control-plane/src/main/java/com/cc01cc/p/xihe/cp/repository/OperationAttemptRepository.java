package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationAttemptRepository extends JpaRepository<OperationAttempt, UUID> {

    List<OperationAttempt> findByItemIdOrderByStartedAtAsc(String itemId);

    Optional<OperationAttempt> findByItemIdAndStageAndRetryNo(String itemId, String stage, Integer retryNo);

    List<OperationAttempt> findByParentAttemptId(String parentAttemptId);
}
