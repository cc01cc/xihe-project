package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ToolFaceEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

/** Persisted tool faces (PLAN-0328 M1, decision #38). */
public interface ToolFaceRepository extends JpaRepository<ToolFaceEntity, UUID> {

    List<ToolFaceEntity> findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc(String scope, String ownerId);

    List<ToolFaceEntity> findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(String scope);
}
