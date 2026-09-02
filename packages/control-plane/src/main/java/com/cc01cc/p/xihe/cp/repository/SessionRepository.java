package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.Session;

import java.util.List;

public interface SessionRepository extends JpaRepository<Session, String> {
    List<Session> findByUserIdAndArchivedFalseOrderByCreatedAtDesc(String userId);
    List<Session> findByWorkspaceIdAndArchivedFalseOrderByCreatedAtDesc(String workspaceId);
    List<Session> findByWorkspaceIdAndUserIdAndArchivedFalseOrderByCreatedAtDesc(
            String workspaceId, String userId);
    java.util.Optional<Session> findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
            String id, String userId, String workspaceId);
}
