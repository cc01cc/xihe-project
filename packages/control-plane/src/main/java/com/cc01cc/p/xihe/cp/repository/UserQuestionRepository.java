package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0660 M5-B / T5.8 (V128): persistence face of {@code user_questions}.
 *
 * <p>Only reads and the plain JPA writes live here. The state machine itself — CAS
 * {@code pending -> answered}, {@code settle} to expired/cancelled, and the "at most one pending
 * human interaction per run" gate shared with approvals — belongs to T5.9, so no {@code @Modifying}
 * claim/transition method is declared yet.</p>
 *
 * <p>{@code pendingCount} is a count over rows, never a stored counter (spec/session/user-channel.md
 * §3: a second fact source is forbidden).</p>
 */
public interface UserQuestionRepository extends JpaRepository<UserQuestion, UUID> {

    /** Projection list for one addressee, newest first; the caller supplies the page size. */
    List<UserQuestion> findByAddresseeUserIdAndStateOrderByCreatedAtDesc(UUID addresseeUserId,
            String state, Pageable pageable);

    /** The {@code pendingCount} of the same projection — one aggregate query, no N+1. */
    long countByAddresseeUserIdAndState(UUID addresseeUserId, String state);

    /**
     * Addressee-scoped read: a non-addressee must never learn that the row exists (T5.10 returns a
     * uniform 404 for "missing" and "not yours" alike).
     */
    Optional<UserQuestion> findByIdAndAddresseeUserId(UUID id, UUID addresseeUserId);

    /** Read face for session readers who may see the projection but not answer it. */
    List<UserQuestion> findBySessionIdOrderByCreatedAtDesc(UUID sessionId);

    /** Unresolved rows of one run: the T5.9 precondition and terminal cleanup (expired/cancelled). */
    List<UserQuestion> findByRunIdAndStateIn(UUID runId, Collection<String> states);

    /** Cheap existence check for the same precondition. */
    boolean existsByRunIdAndState(UUID runId, String state);
}
