package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.OperationItem;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
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

    /** PLAN-0326 决策 #9：行身份 = (operation_id, source, tool_call_id)，幂等收敛限定同源。 */
    Optional<OperationItem> findByOperationIdAndSourceAndToolCallId(String operationId, String source, String toolCallId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select i from OperationItem i where i.id = :id")
    Optional<OperationItem> findByIdForUpdate(@Param("id") UUID id);

    List<OperationItem> findByParentItemId(String parentItemId);

    List<OperationItem> findByApprovalRequestId(String approvalRequestId);

    /** PLAN-0317 决策 #8 补充：取消收口时列出 operation 下所有非终态条目。 */
    List<OperationItem> findByOperationIdAndStatusIn(String operationId, Collection<String> statuses);

    @Query("select coalesce(max(i.sequence), 0) from OperationItem i where i.operationId = :operationId")
    int findMaxSequence(@Param("operationId") String operationId);

    @Modifying
    @Transactional
    @Query("update OperationItem i set i.status = :status, i.policyDecision = :policyDecision, "
            + "i.approvalRequestId = :approvalRequestId, i.resultRef = :resultRef, "
            + "i.errorCode = :errorCode, i.finishedAt = :finishedAt, "
            + "i.updatedAt = CURRENT_INSTANT "
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
