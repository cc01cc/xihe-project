package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.ConfigAuditEntity;

import java.time.Instant;
import java.util.UUID;
import java.util.List;

public interface ConfigAuditRepository extends JpaRepository<ConfigAuditEntity, UUID> {

    List<ConfigAuditEntity> findByConfigIdOrderByChangedAtDesc(String configId);

    void deleteByChangedAtBefore(Instant before);
}
