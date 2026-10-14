package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.CredentialLease;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

public interface CredentialLeaseRepository extends JpaRepository<CredentialLease, UUID> {

    Optional<CredentialLease> findByLeaseHash(String leaseHash);

    /**
     * PLAN-0497 I1: single-use + TTL consumption in one compare-and-set update —
     * a lease can be redeemed exactly once and only before it expires. Returns 1
     * on success, 0 when the lease is already redeemed or expired. The persistence
     * context is cleared after the update so a follow-up load reads the fresh row
     * (wave review: stale first-level cache misread 409 as 410 under concurrency).
     */
    @Modifying(clearAutomatically = true)
    @Transactional
    @Query("update CredentialLease l set l.redeemedAt = :now "
            + "where l.id = :id and l.redeemedAt is null and l.expiresAt > :now")
    int consumeIfValid(@Param("id") UUID id, @Param("now") Instant now);
}
