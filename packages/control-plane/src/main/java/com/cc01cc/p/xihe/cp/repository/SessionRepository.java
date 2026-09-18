package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.Session;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SessionRepository extends JpaRepository<Session, UUID> {
    List<Session> findByUserIdAndArchivedFalseOrderByCreatedAtDesc(String userId);
    List<Session> findByWorkspaceIdAndArchivedFalseOrderByCreatedAtDesc(String workspaceId);
    List<Session> findByWorkspaceIdAndUserIdAndArchivedFalseOrderByCreatedAtDesc(
            String workspaceId, String userId);
    Optional<Session> findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
            UUID id, String userId, String workspaceId);

    /**
     * PLAN-0346 (gap E): pessimistic lock for context_events sequence
     * allocation — mirrors the operation-row lock used by the ledger (0317
     * decision #7②), keeping both event streams on the same serialization
     * paradigm.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select s from Session s where s.id = :id")
    Optional<Session> findByIdForUpdate(@Param("id") UUID id);
}
