package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;
import com.cc01cc.p.xihe.cp.entity.Session;

import java.util.List;

public interface SessionRepository extends JpaRepository<Session, UUID> {
    List<Session> findByUserIdAndArchivedFalseOrderByCreatedAtDesc(String userId);
    List<Session> findByWorkspaceIdAndArchivedFalseOrderByCreatedAtDesc(String workspaceId);
    List<Session> findByWorkspaceIdAndUserIdAndArchivedFalseOrderByCreatedAtDesc(
            String workspaceId, String userId);
    java.util.Optional<Session> findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
            UUID id, String userId, String workspaceId);
}
