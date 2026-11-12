package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.ConfigAuditEntity;

import java.time.Instant;
import java.util.UUID;
import java.util.List;

public interface ConfigAuditRepository extends JpaRepository<ConfigAuditEntity, UUID> {

    List<ConfigAuditEntity> findByConfigIdOrderByChangedAtDesc(String configId);

    /** task-309: "the most recent N rows for this config" — the only consumer use case. */
    List<ConfigAuditEntity> findByConfigIdOrderByChangedAtDesc(String configId, org.springframework.data.domain.Pageable pageable);

    void deleteByChangedAtBefore(Instant before);
}
