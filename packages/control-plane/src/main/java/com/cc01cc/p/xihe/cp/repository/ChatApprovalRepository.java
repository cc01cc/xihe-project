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

    /** PLAN-0341 T1.5: decided approvals for SC constraint extraction. */
    List<ChatApproval> findBySessionIdAndStateInOrderByCreatedAtDesc(
            String sessionId, Collection<String> states);

    /** Cross-session live approval/retry view; callers choose actionable states explicitly. */
    List<ChatApproval> findByUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
            String userId, String workspaceId, Collection<String> states);

    /**
     * Same view with the expiry predicate pushed into SQL (V16 index
     * {@code idx_approval_requests_user_workspace_state}); expired actionable rows are never returned.
     */
    List<ChatApproval> findByUserIdAndWorkspaceIdAndStateInAndExpiresAtAfterOrderByCreatedAtAsc(
            String userId, String workspaceId, Collection<String> states, Instant now);

    List<ChatApproval> findByStateInAndExpiresAtBefore(Collection<String> states, java.time.Instant expiresAt);

    List<ChatApproval> findByRunIdAndStateIn(String runId, Collection<String> states);

    /**
     * T1.7 gate-side idempotency: live (non-terminal) rows for one exact invocation, oldest first.
     * The gate must reuse an existing row instead of archiving a duplicate approval request.
     */
    List<ChatApproval> findBySessionIdAndToolAndArgumentsHashAndStateInOrderByCreatedAtAsc(
            String sessionId, String tool, String argumentsHash, Collection<String> states);

    @Transactional
    @Modifying
    @Query("update ChatApproval a set a.state = 'expired', a.decidedAt = :at, a.updatedAt = :at "
            + "where a.requestId = :requestId and a.state in ('pending', 'dispatching', 'dispatch_unknown')")
    int markExpired(@Param("requestId") UUID requestId, @Param("at") Instant at);

    /**
     * Claims a pending/dispatch_unknown row for dispatch.
     *
     * <p>{@code modeAtGrant} stays coalesced: the first grant's mode is conservative and must not
     * be rewritten by a retry. The revision, generation and reuse scope are re-stamped on every
     * claim with the decision-time values, so a retry after a rule/face write (which moves the
     * durable revision) does not fail {@code consumeStillValid} forever with the stale revision
     * captured before the {@code dispatch_unknown} window.</p>
     */
    @Transactional
    @Modifying
    @Query("update ChatApproval a set a.state = 'dispatching', a.approved = :approved, "
            + "a.dispatchErrorCode = null, a.modeAtGrant = coalesce(a.modeAtGrant, :modeAtGrant), "
            + "a.reuseScope = :reuseScope, "
            + "a.policyRevision = :policyRevision, "
            + "a.sandboxGeneration = :sandboxGeneration, "
            + "a.updatedAt = :at "
            + "where a.requestId = :requestId and a.state in ('pending', 'dispatch_unknown')")
    int markDispatching(@Param("requestId") UUID requestId, @Param("approved") boolean approved,
            @Param("modeAtGrant") String modeAtGrant, @Param("reuseScope") String reuseScope,
            @Param("policyRevision") Long policyRevision,
            @Param("sandboxGeneration") Integer sandboxGeneration, @Param("at") Instant at);

    @Transactional
    @Modifying
    @Query("update ChatApproval a set a.policySummary = :policySummary, a.updatedAt = :at "
            + "where a.requestId = :requestId")
    int updatePolicySummary(@Param("requestId") UUID requestId,
            @Param("policySummary") String policySummary, @Param("at") Instant at);

    @Transactional
    @Modifying
    @Query("update ChatApproval a set a.state = 'dispatch_unknown', a.dispatchErrorCode = :code, a.updatedAt = :at "
            + "where a.requestId = :requestId and a.state = 'dispatching'")
    int markDispatchUnknown(@Param("requestId") UUID requestId, @Param("code") String code, @Param("at") Instant at);

    @Transactional
    @Modifying
    @Query("update ChatApproval a set a.state = :state, a.decisionKind = :decisionKind, "
            + "a.decidedAt = :at, a.updatedAt = :at "
            + "where a.requestId = :requestId and a.state = 'dispatching'")
    int markDecided(@Param("requestId") UUID requestId, @Param("state") String state,
            @Param("decisionKind") String decisionKind, @Param("at") Instant at);

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
