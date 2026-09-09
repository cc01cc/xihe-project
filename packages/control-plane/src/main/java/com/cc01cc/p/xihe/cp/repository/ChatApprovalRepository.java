package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.UUID;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface ChatApprovalRepository extends JpaRepository<ChatApproval, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select a from ChatApproval a where a.requestId = :requestId "
            + "and a.userId = :userId and a.workspaceId = :workspaceId")
    Optional<ChatApproval> findOwnedForUpdate(@Param("requestId") UUID requestId,
            @Param("userId") String userId,
            @Param("workspaceId") String workspaceId);

    List<ChatApproval> findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
            String sessionId, String userId, String workspaceId, Collection<String> states);

    List<ChatApproval> findByStateInAndExpiresAtBefore(Collection<String> states, java.time.Instant expiresAt);

    List<ChatApproval> findByRunIdAndStateIn(String runId, Collection<String> states);

    @Transactional
    @Modifying
    @Query("update ChatApproval a set a.state = 'expired', a.decidedAt = :at, a.updatedAt = :at "
            + "where a.requestId = :requestId and a.state in ('pending', 'dispatching')")
    int markExpired(@Param("requestId") UUID requestId, @Param("at") Instant at);

    @Transactional
    @Modifying
    @Query("update ChatApproval a set a.state = 'dispatching', a.approved = :approved, a.updatedAt = :at "
            + "where a.requestId = :requestId and a.state = 'pending'")
    int markDispatching(@Param("requestId") UUID requestId, @Param("approved") boolean approved,
            @Param("at") Instant at);

    @Transactional
    @Modifying
    @Query("update ChatApproval a set a.state = 'dispatch_unknown', a.dispatchErrorCode = :code, a.updatedAt = :at "
            + "where a.requestId = :requestId and a.state = 'dispatching'")
    int markDispatchUnknown(@Param("requestId") UUID requestId, @Param("code") String code, @Param("at") Instant at);

    @Transactional
    @Modifying
    @Query("update ChatApproval a set a.state = :state, a.decidedAt = :at, a.updatedAt = :at "
            + "where a.requestId = :requestId and a.state = 'dispatching'")
    int markDecided(@Param("requestId") UUID requestId, @Param("state") String state, @Param("at") Instant at);

    @Transactional
    @Modifying
    @Query("update ChatApproval a set a.grantConsumedAt = :at, a.updatedAt = :at "
            + "where a.requestId = :requestId and a.userId = :userId and a.workspaceId = :workspaceId "
            + "and a.sessionId = :sessionId and a.tool = :tool and a.state = 'approved' "
            + "and a.grantConsumedAt is null")
    int consumeApprovedGrant(@Param("requestId") UUID requestId,
            @Param("userId") String userId,
            @Param("workspaceId") String workspaceId,
            @Param("sessionId") String sessionId,
            @Param("tool") String tool,
            @Param("at") Instant at);
}
