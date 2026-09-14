package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.PolicyRuleEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

/** Persisted authorization rules (PLAN-0328 M1). */
public interface PolicyRuleRepository extends JpaRepository<PolicyRuleEntity, UUID> {

    List<PolicyRuleEntity> findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc(String layer, String ownerId);

    List<PolicyRuleEntity> findByLayerAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(String layer);

    List<PolicyRuleEntity> findByLayerOrderByCreatedAtAscIdAsc(String layer);
}
