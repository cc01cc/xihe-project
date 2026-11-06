package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0660 M5-B / T5.8 (V128) + T5.9: persistence face of {@code user_questions}.
 *
 * <p>The read face is additive. Every state change is a <b>conditional single-statement update</b>
 * whose {@code WHERE} carries the expected state, so the database — not a read-then-write window in
 * Java — decides who wins. Affected rows are the only truth about what happened: 0 means "somebody
 * else (or the deadline) already settled it", and the service re-reads to report the honest 409
 * flavour instead of fabricating a result.</p>
 *
 * <p>{@code pendingCount} is a count over rows, never a stored counter, and the question body
 * ({@code prompt} / {@code answer}) never appears in a query predicate
 * (spec/session/user-channel.md §3/§6: the body must not become a searchable surface).</p>
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

    /**
     * Fresh state read that bypasses the persistence context. Loaded entities live in the
     * first-level cache, so re-reading a row with {@code findById} after a bulk update would still
     * report the pre-update state; a scalar JPQL projection always goes to the database.
     */
    @Query("select q.state from UserQuestion q where q.id = :id")
    Optional<String> findStateById(@Param("id") UUID id);

    /**
     * Answer CAS: state, body and settle stamp move in one statement, and the deadline predicate sits
     * inside the same {@code WHERE} — a question that expired between the caller's read and this
     * update can never be answered.
     *
     * @return 1 when this caller won the pending row, 0 when it was already settled or had expired
     */
    @Transactional
    @Modifying
    @Query("update UserQuestion q set q.state = 'answered', q.answer = :answer, q.settledAt = :at "
            + "where q.id = :id and q.state = 'pending' "
            + "and (q.expiresAt is null or q.expiresAt > :at)")
    int markAnswered(@Param("id") UUID id, @Param("answer") String answer, @Param("at") Instant at);

    /**
     * Terminal settle (expired / cancelled) from {@code pending} only. Repeating the call is a no-op
     * and can never overwrite an {@code answered} row.
     *
     * @return 1 when this call settled a pending row, 0 when there was nothing pending any more
     */
    @Transactional
    @Modifying
    @Query("update UserQuestion q set q.state = :state, q.settledAt = :at "
            + "where q.id = :id and q.state = 'pending'")
    int settlePending(@Param("id") UUID id, @Param("state") String state, @Param("at") Instant at);

    /**
     * Same settle for every still-pending question of one run (run reached a terminal status, or the
     * run was cancelled): one statement, pending rows only, idempotent.
     *
     * @return the number of rows that actually moved
     */
    @Transactional
    @Modifying
    @Query("update UserQuestion q set q.state = :state, q.settledAt = :at "
            + "where q.runId = :runId and q.state = 'pending'")
    int settlePendingForRun(@Param("runId") UUID runId, @Param("state") String state,
            @Param("at") Instant at);

    /**
     * PLAN-0660 V13: read-time lazy expiry. There is no scheduler for {@code user_questions}; the
     * deadline is turned into a durable {@code expired} row by the first reader of the addressee's
     * inbox (list or badge) instead of waiting for a late answer. The predicate is exactly the
     * complement of {@link #markAnswered}'s {@code expiresAt > :at}: a row that can no longer be
     * answered is settled, so the projection, the count and the row all agree.
     *
     * <p>Conditional and idempotent: only {@code pending} rows with a passed deadline move, and a
     * repeated read returns 0.</p>
     *
     * @return the number of rows that actually moved
     */
    @Transactional
    @Modifying
    @Query("update UserQuestion q set q.state = 'expired', q.settledAt = :at "
            + "where q.addresseeUserId = :addresseeUserId and q.state = 'pending' "
            + "and q.expiresAt is not null and q.expiresAt <= :at")
    int settleExpiredForAddressee(@Param("addresseeUserId") UUID addresseeUserId,
            @Param("at") Instant at);

    /**
     * Same lazy expiry for the single-read faces, scoped to one row (primary key lookup) so reading
     * one question cannot touch another addressee's inbox.
     *
     * @return 1 when this read settled the row, 0 when it was not pending or had no passed deadline
     */
    @Transactional
    @Modifying
    @Query("update UserQuestion q set q.state = 'expired', q.settledAt = :at "
            + "where q.id = :id and q.state = 'pending' "
            + "and q.expiresAt is not null and q.expiresAt <= :at")
    int settleExpiredById(@Param("id") UUID id, @Param("at") Instant at);
}
