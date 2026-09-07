package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;
import com.cc01cc.p.xihe.cp.entity.AuditLog;

import java.util.List;

public interface AuditLogRepository extends JpaRepository<AuditLog, UUID> {
    List<AuditLog> findByUserIdOrderByCreatedAtDesc(String userId);
    List<AuditLog> findByWorkspaceIdOrderByCreatedAtDesc(String workspaceId);
}
