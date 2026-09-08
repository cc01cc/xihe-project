package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.OperationItem;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationItemRepository extends JpaRepository<OperationItem, UUID> {

    List<OperationItem> findByOperationIdOrderBySequenceAsc(UUID operationId);

    Optional<OperationItem> findByOperationIdAndToolCallId(UUID operationId, String toolCallId);

    List<OperationItem> findByParentItemId(String parentItemId);

    List<OperationItem> findByApprovalRequestId(String approvalRequestId);
}
