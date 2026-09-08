package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.SessionOperation;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SessionOperationRepository extends JpaRepository<SessionOperation, UUID> {

    Optional<SessionOperation> findByRunId(String runId);

    boolean existsByUserIdAndSessionIdAndIdempotencyKey(
            String userId, String sessionId, String idempotencyKey);

    Optional<SessionOperation> findByUserIdAndSessionIdAndIdempotencyKey(
            String userId, String sessionId, String idempotencyKey);

    List<SessionOperation> findBySessionIdOrderByCreatedAtDesc(String sessionId);

    List<SessionOperation> findByWorkspaceIdOrderByCreatedAtDesc(String workspaceId);
}
