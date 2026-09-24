package com.cc01cc.p.xihe.cp.context.repository;

import com.cc01cc.p.xihe.cp.context.entity.ContextProjection;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface ContextProjectionRepository extends JpaRepository<ContextProjection, UUID> {

    // PLAN-0410 field-matrix §2 #3/#4: the V1 "one projection per Session"
    // assumption is gone — locate by the durable V43 key
    // (session_id, projection_type, branch_id).
    Optional<ContextProjection> findBySessionIdAndProjectionTypeAndBranchId(
            String sessionId, String projectionType, String branchId);

    long deleteBySessionId(String sessionId);
}
