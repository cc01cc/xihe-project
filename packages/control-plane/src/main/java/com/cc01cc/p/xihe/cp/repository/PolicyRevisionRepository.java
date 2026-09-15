package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.PolicyRevisionEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;

/**
 * Single-row durable policy revision counter (PLAN-0328 T1.7).
 *
 * <p>{@link #currentSeq(Short)} is a scalar JPQL query on purpose: unlike {@code findById} it
 * always reads the database, so a preceding {@link #bump(Short, Instant)} is visible even inside
 * the same transaction. Both statements stay portable across PostgreSQL and H2.</p>
 */
public interface PolicyRevisionRepository extends JpaRepository<PolicyRevisionEntity, Short> {

    /** Current durable sequence; empty when the counter row is missing (caller fails closed). */
    @Transactional(readOnly = true)
    @Query("select r.seq from PolicyRevisionEntity r where r.id = :id")
    Optional<Long> currentSeq(@Param("id") Short id);

    /**
     * Atomic monotonic bump. Returns the number of updated rows; 0 when the singleton row is
     * missing so the caller can fail closed instead of persisting a mutation untracked.
     */
    @Modifying
    @Transactional
    @Query("update PolicyRevisionEntity r set r.seq = r.seq + 1, r.updatedAt = :now where r.id = :id")
    int bump(@Param("id") Short id, @Param("now") Instant now);
}
