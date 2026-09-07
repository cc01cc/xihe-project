package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ProviderConnectionAudit;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface ProviderConnectionAuditRepository extends JpaRepository<ProviderConnectionAudit, UUID> {
}
