package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.AuditLog;

import java.util.List;

public interface AuditLogRepository extends JpaRepository<AuditLog, String> {
    List<AuditLog> findByUserIdOrderByCreatedAtDesc(String userId);
    List<AuditLog> findByWorkspaceIdOrderByCreatedAtDesc(String workspaceId);
}
