package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface ChatApprovalRepository extends JpaRepository<ChatApproval, String> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select a from ChatApproval a where a.requestId = :requestId "
            + "and a.userId = :userId and a.workspaceId = :workspaceId")
    Optional<ChatApproval> findOwnedForUpdate(
            @Param("requestId") String requestId,
            @Param("userId") String userId,
            @Param("workspaceId") String workspaceId);

    List<ChatApproval> findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
            String sessionId, String userId, String workspaceId, Collection<String> states);

    List<ChatApproval> findByStateInAndExpiresAtBefore(Collection<String> states, java.time.Instant expiresAt);

    List<ChatApproval> findByRunIdAndStateIn(String runId, Collection<String> states);
}
