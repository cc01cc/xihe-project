package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.OperationItem;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationItemRepository extends JpaRepository<OperationItem, UUID> {

    List<OperationItem> findByOperationIdOrderBySequenceAsc(String operationId);

    Optional<OperationItem> findByOperationIdAndToolCallId(String operationId, String toolCallId);

    Optional<OperationItem> findFirstByOperationIdAndToolNameAndStatusInOrderByCreatedAtDesc(
            String operationId, String toolName, Collection<String> statuses);

    List<OperationItem> findByParentItemId(String parentItemId);

    List<OperationItem> findByApprovalRequestId(String approvalRequestId);

    @Query("select coalesce(max(i.sequence), 0) from OperationItem i where i.operationId = :operationId")
    int findMaxSequence(@Param("operationId") String operationId);

    @Modifying
    @Transactional
    @Query("update OperationItem i set i.status = :status, i.policyDecision = :policyDecision, "
            + "i.approvalRequestId = :approvalRequestId, i.resultRef = :resultRef, "
            + "i.errorCode = :errorCode, i.finishedAt = :finishedAt "
            + "where i.id = :id and i.status in :expectedStatuses")
    int transitionStatus(@Param("id") UUID id,
            @Param("expectedStatuses") Collection<String> expectedStatuses,
            @Param("status") String status,
            @Param("policyDecision") String policyDecision,
            @Param("approvalRequestId") String approvalRequestId,
            @Param("resultRef") String resultRef,
            @Param("errorCode") String errorCode,
            @Param("finishedAt") Instant finishedAt);
}
